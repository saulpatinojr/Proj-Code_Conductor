import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  constructor(root = join(conductorHome(), 'runs')) {
    this.root = root;
    ensurePrivateDirectory(root);
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

  /** Age of a stored run (from its manifest) in milliseconds; undefined when it cannot be read. */
  runAgeMs(runId: string, now = Date.now()): number | undefined {
    try { return now - lstatSync(join(this.root, safeRunDirectoryName(runId), 'manifest.json')).mtimeMs; } catch { return undefined; }
  }

  /** Delete one stored run's local evidence (manifest, events, handoffs). Never touches worktrees. */
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
