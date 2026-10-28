import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HandoffPacket, RunManifest } from '@code-conductor/schemas';

export interface RunEvent {
  at: string;
  runId: string;
  type: string;
  assignmentId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export function conductorHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor');
}

/** Stored handoff packets are bounded on write and read. */
const MAX_HANDOFF_BYTES = 4 * 1024 * 1024;
/** Each stored tool-output stream is bounded on write and read (the gates' capture bound). */
export const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const EVIDENCE_ID = /^E-[A-Za-z0-9-]{8,80}$/;

/** The full output of one deterministic tool run, stored next to its evidence record (#94). */
export interface ToolOutputRecord {
  evidenceId: string;
  /** The command line and executable, as the evidence's `source`. */
  source: string;
  status: number | null;
  timedOut: boolean;
  /** Output beyond the capture bound was discarded before it reached the store; `sha256` still covers it. */
  truncated: boolean;
  stdout: string;
  stderr: string;
  /** The digest recorded in the evidence. */
  sha256: string;
  /**
   * How `sha256` was computed: `streams` is SHA-256 over the digests of all stdout bytes
   * then all stderr bytes (the gate runner); `combined` is SHA-256 over the trimmed,
   * joined text (an injected executor without its own digest).
   */
  digestMethod: 'streams' | 'combined';
}

export interface StoredToolOutput {
  /** Path of the JSON record; the streams sit next to it as `<id>.stdout` and `<id>.stderr`. */
  path: string;
  /** SHA-256 of the stored stdout and stderr text, as written. */
  stdoutSha256: string;
  stderrSha256: string;
}

/** What a read-back established about a stored output. */
export interface ToolOutputVerification {
  /** The stored streams match the digests written with them. */
  storedIntact: boolean;
  /** The stored streams reproduce the evidence digest; undefined when truncation makes that impossible. */
  matchesEvidence: boolean | undefined;
}

function combinedDigest(stdout: string, stderr: string): string {
  return createHash('sha256').update([stdout.trim(), stderr.trim()].filter(Boolean).join('\n')).digest('hex');
}

function streamsDigest(stdout: string, stderr: string): string {
  return createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update(stderr).digest()).digest('hex');
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// Trims leading and trailing '-'/'_' in linear time; an anchored regex such as
// /[-_]+$/ backtracks quadratically on long runs of separators in untrusted run IDs.
function trimSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '-' || value[start] === '_')) start += 1;
  while (end > start && (value[end - 1] === '-' || value[end - 1] === '_')) end -= 1;
  return value.slice(start, end);
}

/**
 * Read a file from the run store through one descriptor, so it cannot be swapped between
 * the checks and the read: no symlink following, non-blocking open (a FIFO cannot hang
 * the read), a regular file no larger than maxBytes, and at most its fstat size + 1 bytes.
 */
function readStoredText(target: string, maxBytes: number, label: string): string {
  let descriptor: number;
  try { descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label} is not stored.`);
    throw new Error(`${label} cannot be opened: ${(error as NodeJS.ErrnoException).code ?? String(error)}.`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    }
    if (length > stat.size) throw new Error(`${label} changed while it was read.`);
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(descriptor); }
}

export function safeRunDirectoryName(runId: string): string {
  if (/^[A-Za-z0-9_-]{1,120}$/.test(runId)) return runId;
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const prefix = trimSeparators(trimSeparators(runId.replace(/[^A-Za-z0-9_-]+/g, '-')).slice(0, 96));
  return prefix ? `${prefix}-${digest}` : `run-${digest}`;
}

export class RunStore {
  readonly root: string;

  constructor(root = join(conductorHome(), 'runs'), options: { initializeRoot?: boolean } = {}) {
    this.root = root;
    if (options.initializeRoot !== false) ensurePrivateDirectory(root);
  }

  runDirectory(runId: string): string {
    const dir = join(this.root, safeRunDirectoryName(runId));
    ensurePrivateDirectory(dir);
    return dir;
  }

  saveManifest(manifest: RunManifest): string {
    const target = join(this.runDirectory(manifest.runId), 'manifest.json');
    const temp = `${target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    chmodSync(target, 0o600);
    return target;
  }

  /** Persist a handoff packet next to its run (owner-only); returns its sha256. */
  saveHandoff(packet: HandoffPacket): string {
    if (!/^HP-[A-Za-z0-9-]{8,80}$/.test(packet.id)) throw new Error(`Invalid handoff packet id: ${packet.id}`);
    const directory = join(this.runDirectory(packet.runId), 'handoffs');
    ensurePrivateDirectory(directory);
    const text = `${JSON.stringify(packet, null, 2)}\n`;
    // The same bound readHandoff enforces, so nothing is stored that could not be read back.
    if (Buffer.byteLength(text) > MAX_HANDOFF_BYTES) throw new Error(`Handoff packet ${packet.id} exceeds ${MAX_HANDOFF_BYTES} bytes.`);
    const target = join(directory, `${packet.id}.json`);
    writeFileSync(`${target}.tmp`, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(`${target}.tmp`, target);
    chmodSync(target, 0o600);
    return createHash('sha256').update(text).digest('hex');
  }

  /** Read a stored packet and verify it against the manifest's recorded digest. Callers validate the contract. */
  readHandoff(runId: string, id: string, sha256: string): unknown {
    if (!/^HP-[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error(`Invalid handoff packet id: ${id}`);
    const text = readStoredText(join(this.root, safeRunDirectoryName(runId), 'handoffs', `${id}.json`), MAX_HANDOFF_BYTES, `Handoff packet ${id}`);
    if (createHash('sha256').update(text).digest('hex') !== sha256) throw new Error(`Handoff packet ${id} does not match the digest recorded in run ${runId}.`);
    return JSON.parse(text) as unknown;
  }

  /**
   * Persist the full output of one gate command next to the run's evidence, owner-only,
   * so a bounded or summarised evidence record can always be traced back to it. Returns
   * the record path (the evidence `uri`) and the digests of what was written.
   */
  saveToolOutput(runId: string, record: ToolOutputRecord): StoredToolOutput {
    if (!EVIDENCE_ID.test(record.evidenceId)) throw new Error(`Invalid evidence id: ${record.evidenceId}`);
    if (Buffer.byteLength(record.stdout) > MAX_TOOL_OUTPUT_BYTES || Buffer.byteLength(record.stderr) > MAX_TOOL_OUTPUT_BYTES) throw new Error(`Tool output for ${record.evidenceId} exceeds ${MAX_TOOL_OUTPUT_BYTES} bytes per stream.`);
    const directory = join(this.runDirectory(runId), 'tool-output');
    ensurePrivateDirectory(directory);
    const write = (name: string, text: string): string => {
      const target = join(directory, name);
      writeFileSync(`${target}.tmp`, text, { encoding: 'utf8', mode: 0o600 });
      renameSync(`${target}.tmp`, target);
      chmodSync(target, 0o600);
      return createHash('sha256').update(text).digest('hex');
    };
    const stdoutSha256 = write(`${record.evidenceId}.stdout`, record.stdout);
    const stderrSha256 = write(`${record.evidenceId}.stderr`, record.stderr);
    const header = { evidenceId: record.evidenceId, runId, source: record.source, status: record.status, timedOut: record.timedOut, truncated: record.truncated, sha256: record.sha256, digestMethod: record.digestMethod, stdoutSha256, stderrSha256, stdoutBytes: Buffer.byteLength(record.stdout), stderrBytes: Buffer.byteLength(record.stderr) };
    const path = join(directory, `${record.evidenceId}.json`);
    write(`${record.evidenceId}.json`, `${JSON.stringify(header, null, 2)}\n`);
    return { path, stdoutSha256, stderrSha256 };
  }

  /**
   * Read a stored tool output back and say what the read established: whether the
   * streams still match the digests stored with them, and whether they reproduce the
   * capture header's claimed evidence digest (unknowable when truncated). This low-level
   * check does not bind the header to a manifest; use readManifestToolOutput for recovery.
   */
  readToolOutput(runId: string, evidenceId: string): { record: ToolOutputRecord; verification: ToolOutputVerification } {
    return readCapturedOutput(this.root, runId, evidenceId);
  }

  /** Age of a stored run (from its manifest) in milliseconds; undefined when it cannot be read. */
  runAgeMs(runId: string, now = Date.now()): number | undefined {
    try { return now - lstatSync(join(this.root, safeRunDirectoryName(runId), 'manifest.json')).mtimeMs; } catch { return undefined; }
  }

  /** Delete one stored run's local evidence (manifest, events, handoffs, tool output). Never touches worktrees. */
  deleteRun(runId: string): void {
    const name = safeRunDirectoryName(runId);
    const target = join(this.root, name);
    let stored = false;
    try { stored = lstatSync(join(target, 'manifest.json')).isFile(); } catch { stored = false; }
    if (name !== runId || !stored) throw new Error(`No stored run ${runId}.`);
    rmSync(target, { recursive: true, force: true });
  }

  /** Stored runs, most recently written first. Only a regular manifest file (not a symlink) counts. */
  listRunIds(): string[] {
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const runs: Array<{ name: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const stat = lstatSync(join(this.root, entry.name, 'manifest.json'));
        if (stat.isFile()) runs.push({ name: entry.name, mtime: stat.mtimeMs });
      } catch { /* not a stored run */ }
    }
    return runs.sort((a, b) => b.mtime - a.mtime).map((run) => run.name);
  }

  /** Most recently written run manifest, if any. */
  latestRunId(): string | undefined {
    return this.listRunIds()[0];
  }

  /**
   * Read a stored manifest without creating directories. Callers validate the contract.
   * One descriptor is checked and read, so the file cannot be swapped in between, and a
   * symlink or non-regular file (for example a FIFO that would block) is refused.
   */
  readManifest(runId: string, maxBytes = 16 * 1024 * 1024): unknown {
    const label = `Run manifest for ${runId}`;
    try { return JSON.parse(readStoredText(join(this.root, safeRunDirectoryName(runId), 'manifest.json'), maxBytes, label)) as unknown; }
    catch (error) {
      if (error instanceof Error && error.message === `${label} is not stored.`) throw new Error(`No stored run manifest for ${runId}.`);
      throw error;
    }
  }

  appendEvent(event: RunEvent): string {
    const target = join(this.runDirectory(event.runId), 'events.jsonl');
    ensurePrivateDirectory(dirname(target));
    appendFileSync(target, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(target, 0o600);
    return target;
  }
}

/** Read-only low-level capture reader; its hashes alone are not manifest provenance. */
function readCapturedOutput(root: string, runId: string, evidenceId: string): { record: ToolOutputRecord; verification: ToolOutputVerification } {
  if (!EVIDENCE_ID.test(evidenceId)) throw new Error(`Invalid evidence id: ${evidenceId}`);
  const directory = join(root, safeRunDirectoryName(runId), 'tool-output');
  const header = JSON.parse(readStoredText(join(directory, `${evidenceId}.json`), 1024 * 1024, `Tool output record ${evidenceId}`)) as Partial<ToolOutputRecord> & { runId?: string; stdoutSha256?: string; stderrSha256?: string };
  if (header.evidenceId !== evidenceId || header.runId !== runId) throw new Error(`Tool output record ${evidenceId} does not belong to run ${runId}.`);
  const stdout = readStoredText(join(directory, `${evidenceId}.stdout`), MAX_TOOL_OUTPUT_BYTES, `Tool output ${evidenceId} stdout`);
  const stderr = readStoredText(join(directory, `${evidenceId}.stderr`), MAX_TOOL_OUTPUT_BYTES, `Tool output ${evidenceId} stderr`);
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
  const storedIntact = digest(stdout) === header.stdoutSha256 && digest(stderr) === header.stderrSha256;
  const record: ToolOutputRecord = {
    evidenceId, source: String(header.source ?? ''), status: typeof header.status === 'number' ? header.status : null, timedOut: header.timedOut === true, truncated: header.truncated === true,
    stdout, stderr, sha256: String(header.sha256 ?? ''), digestMethod: header.digestMethod === 'combined' ? 'combined' : 'streams',
  };
  const matchesEvidence = record.truncated ? undefined : (record.digestMethod === 'combined' ? combinedDigest(stdout, stderr) : streamsDigest(stdout, stderr)) === record.sha256;
  return { record, verification: { storedIntact, matchesEvidence } };
}

export class ToolOutputIntegrityError extends Error {}

/** Recover only a capture anchored to the selected validated manifest; no paths from evidence URIs are followed. */
export function readManifestToolOutput(root: string, manifest: RunManifest, evidenceId: string): { record: ToolOutputRecord; verification: ToolOutputVerification } {
  if (safeRunDirectoryName(manifest.runId) !== manifest.runId || !EVIDENCE_ID.test(evidenceId)) throw new Error('Invalid run or evidence identity.');
  const matches = manifest.results.flatMap((result) => result.evidence).filter((item) => item.id === evidenceId);
  const evidence = matches[0];
  if (matches.length !== 1 || !evidence || !['test', 'tool'].includes(evidence.kind) || !evidence.sha256 || !/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error('No unique digest-bound tool evidence in this manifest.');
  for (const folder of [root, join(root, manifest.runId), join(root, manifest.runId, 'tool-output')]) {
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe capture directory.');
  }
  for (const suffix of ['json', 'stdout', 'stderr']) {
    const stat = lstatSync(join(root, manifest.runId, 'tool-output', `${evidenceId}.${suffix}`));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Unsafe capture file.');
  }
  let stored: ReturnType<typeof readCapturedOutput>;
  try { stored = readCapturedOutput(root, manifest.runId, evidenceId); }
  catch { throw new Error('Capture unavailable; check stored metadata, paths and file limits.'); }
  if (stored.record.sha256 !== evidence.sha256 || stored.record.source !== evidence.source) throw new ToolOutputIntegrityError('Capture metadata differs from the run manifest.');
  if (stored.record.digestMethod !== 'streams') throw new ToolOutputIntegrityError('Legacy combined digests cannot verify exact captured bytes and stream identity. Original stored evidence was preserved.');
  if (!stored.verification.storedIntact || stored.verification.matchesEvidence !== true) throw new ToolOutputIntegrityError('Capture cannot be verified against the manifest digest (changed or truncated output).');
  return stored;
}
