import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunManifest } from '@code-conductor/schemas';

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

  /** Stored run ids, newest manifest first. */
  listRunIds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, 'manifest.json')))
      .map((entry) => ({ name: entry.name, mtime: statSync(join(this.root, entry.name, 'manifest.json')).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.name);
  }

  /** Most recently written run manifest, if any. */
  latestRunId(): string | undefined {
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let latest: { name: string; mtime: number } | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Same rule as readManifest: only a regular file (not a symlink) counts as a run.
      let mtime: number;
      try {
        const stat = lstatSync(join(this.root, entry.name, 'manifest.json'));
        if (!stat.isFile()) continue;
        mtime = stat.mtimeMs;
      } catch { continue; }
      if (!latest || mtime > latest.mtime) latest = { name: entry.name, mtime };
    }
    return latest?.name;
  }

  /**
   * Read a stored manifest without creating directories. Callers validate the contract.
   * One descriptor is checked and read, so the file cannot be swapped in between, and a
   * symlink or non-regular file (for example a FIFO that would block) is refused.
   */
  readManifest(runId: string, maxBytes = 16 * 1024 * 1024): unknown {
    const target = join(this.root, safeRunDirectoryName(runId), 'manifest.json');
    let descriptor: number;
    try { descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No stored run manifest for ${runId}.`);
      throw new Error(`Run manifest for ${runId} cannot be opened: ${(error as NodeJS.ErrnoException).code ?? String(error)}.`);
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) throw new Error(`Run manifest for ${runId} is not a regular file.`);
      if (stat.size > maxBytes) throw new Error(`Run manifest for ${runId} exceeds ${maxBytes} bytes.`);
      // Read at most one byte more than fstat reported, so a file that grows meanwhile is
      // refused rather than read without bound.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      for (let read = -1; read !== 0 && length < buffer.length;) {
        read = readSync(descriptor, buffer, length, buffer.length - length, null);
        length += read;
      }
      if (length > stat.size) throw new Error(`Run manifest for ${runId} changed while it was read.`);
      return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
    } finally { closeSync(descriptor); }
  }

  appendEvent(event: RunEvent): string {
    const target = join(this.runDirectory(event.runId), 'events.jsonl');
    ensurePrivateDirectory(dirname(target));
    appendFileSync(target, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(target, 0o600);
    return target;
  }
}
