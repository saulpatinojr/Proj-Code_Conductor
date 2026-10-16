import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
      const manifest = join(this.root, entry.name, 'manifest.json');
      if (!existsSync(manifest)) continue;
      const mtime = statSync(manifest).mtimeMs;
      if (!latest || mtime > latest.mtime) latest = { name: entry.name, mtime };
    }
    return latest?.name;
  }

  /** Read a stored manifest without creating directories. Callers validate the contract. */
  readManifest(runId: string, maxBytes = 16 * 1024 * 1024): unknown {
    const target = join(this.root, safeRunDirectoryName(runId), 'manifest.json');
    if (!existsSync(target)) throw new Error(`No stored run manifest for ${runId}.`);
    if (statSync(target).size > maxBytes) throw new Error(`Run manifest for ${runId} exceeds ${maxBytes} bytes.`);
    return JSON.parse(readFileSync(target, 'utf8')) as unknown;
  }

  appendEvent(event: RunEvent): string {
    const target = join(this.runDirectory(event.runId), 'events.jsonl');
    ensurePrivateDirectory(dirname(target));
    appendFileSync(target, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(target, 0o600);
    return target;
  }
}
