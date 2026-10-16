import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

export function safeRunDirectoryName(runId: string): string {
  if (/^[A-Za-z0-9_-]{1,120}$/.test(runId)) return runId;
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const prefix = runId
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 96)
    .replace(/[-_]+$/g, '');
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

  /** Most recently written run manifest, if any. */
  latestRunId(): string | undefined {
    if (!existsSync(this.root)) return undefined;
    let latest: { name: string; mtime: number } | undefined;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let mtime: number;
      try { mtime = statSync(join(this.root, entry.name, 'manifest.json')).mtimeMs; } catch { continue; }
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
      return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
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
