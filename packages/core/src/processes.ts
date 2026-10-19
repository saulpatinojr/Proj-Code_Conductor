import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

// Provider clients and gate commands run in their own session and process group on
// POSIX. Without a controlling terminal they cannot open /dev/tty or inject keystrokes
// into an approval prompt, and the processes they leave behind in their group are
// terminated with it, including when Code Conductor exits or is interrupted. This is
// containment, not a security boundary: a same-user descendant can start its own
// session to leave the group, and can still reach the person's terminal through /proc.
// Approval integrity does not rest on it. Windows has no process-group isolation here.
export const ISOLATE_PROCESS_GROUPS = process.platform !== 'win32';
/** How long a process gets to exit after SIGTERM, and to release its output pipes after exiting. */
export const KILL_GRACE_MS = 5000;
const liveGroups = new Set<number>();
let reaperInstalled = false;

function reapGroups(): void {
  for (const pid of liveGroups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ } }
  liveGroups.clear();
}

/** Spawn a process isolated from the controlling terminal and registered with the exit/signal reaper. */
export function spawnIsolated(command: string, args: readonly string[], options: Parameters<typeof spawn>[2]): ReturnType<typeof spawn> {
  const child = spawn(command, [...args], { ...options, detached: ISOLATE_PROCESS_GROUPS, windowsHide: true });
  if (ISOLATE_PROCESS_GROUPS && child.pid) {
    liveGroups.add(child.pid);
    if (!reaperInstalled) {
      reaperInstalled = true;
      process.once('exit', reapGroups);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        const onSignal = (): void => {
          reapGroups();
          // Re-raise for the default action only when nothing else handles the signal;
          // an embedding host (for example an editor extension) decides for itself.
          if (process.listenerCount(signal) === 1) {
            process.removeListener(signal, onSignal);
            process.kill(process.pid, signal);
          }
        };
        process.on(signal, onSignal);
      }
    }
  }
  return child;
}

/** Signal an isolated process and everything it started. */
export function terminateGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (ISOLATE_PROCESS_GROUPS && child.pid) {
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    if (signal === 'SIGKILL') liveGroups.delete(child.pid);
  } else child.kill(signal);
}

export interface BoundedRunOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output beyond the capture limit was discarded; `sha256` still covers all of it. */
  truncated: boolean;
  /** SHA-256 over the full, untruncated stdout bytes followed by the full stderr bytes. */
  sha256: string;
}

/**
 * Run a command without a shell in an isolated process group, with:
 * - a wall-clock timeout (SIGTERM, then SIGKILL after a grace period);
 * - captured output bounded to `maxBytes` per stream, decoded once at the end so
 *   multi-byte characters are not split, while the digest covers every byte;
 * - termination of the group as soon as the command exits, and a bounded wait for a
 *   descendant that left the group but still holds the output pipes.
 */
export function runIsolated(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }): Promise<BoundedRunOutcome> {
  return new Promise((resolve) => {
    const capture = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let release: NodeJS.Timeout | undefined;
    const child = spawnIsolated(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      hashes[stream].update(chunk);
      const room = options.maxBytes - sizes[stream];
      if (room <= 0) { truncated = true; return; }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      capture[stream].push(kept);
      sizes[stream] += kept.length;
    };
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(release);
      terminateGroup(child, 'SIGKILL');
      const stderr = Buffer.concat(capture.stderr).toString('utf8');
      const stdoutDigest = hashes.stdout.digest();
      const stderrDigest = hashes.stderr.digest();
      resolve({
        status, timedOut, truncated,
        stdout: Buffer.concat(capture.stdout).toString('utf8'),
        stderr: error ? `${stderr}${stderr ? '\n' : ''}${error.message}` : stderr,
        sha256: createHash('sha256').update(stdoutDigest).update(stderrDigest).digest('hex'),
      });
    };
    child.stdout!.on('data', collect('stdout'));
    child.stderr!.on('data', collect('stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child, 'SIGTERM');
      escalation = setTimeout(() => terminateGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    }, options.timeoutMs);
    child.on('error', (error) => finish(null, error));
    child.on('close', (status) => finish(status));
    // A descendant can keep the pipes open after the command exits, so 'close' would not
    // come: terminate the group at once and stop reading after a grace period.
    child.on('exit', (status) => {
      // It exited in time: no timeout verdict, and no later signal to a group that is gone.
      clearTimeout(timer); clearTimeout(escalation);
      terminateGroup(child, 'SIGKILL');
      release = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(status); }, KILL_GRACE_MS);
    });
  });
}

/**
 * An environment with PATH reduced to its absolute entries: tools a child starts itself
 * (for example `#!/usr/bin/env node` in npm) follow the same rule as the child, so nothing
 * is found through the current directory or a relative entry.
 */
export function absolutePathEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result).filter((name) => name.toUpperCase() === 'PATH')) {
    result[key] = (result[key] ?? '').split(delimiter).filter((entry) => entry && isAbsolute(entry)).join(delimiter);
  }
  return result;
}

export interface ResolvedExecutable {
  path?: string;
  /** Arguments that go before the caller's own, when `path` is an interpreter running the command's script (Windows npm and npx). */
  prefixArgs?: string[];
  problem?: string;
}

/**
 * npm and npx are scripts shipped inside Node's own installation, next to `node.exe`.
 * On Windows their PATH entries are batch shims, so the bundled script runs under that
 * `node.exe` instead (D-074). Only these two: their location is fixed by Node's layout.
 */
const NODE_BUNDLED_SCRIPTS: Readonly<Record<string, string>> = {
  npm: join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  npx: join('node_modules', 'npm', 'bin', 'npx-cli.js'),
};

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * The absolute file a plain command name resolves to, searching absolute PATH entries
 * only: never the current directory, an empty entry or a relative entry, which the
 * repository a child runs in could control (on Windows, a bare name passed to spawn is
 * looked up in the child's working directory first). On Windows only .exe and .com files
 * run without a shell. A batch shim (.cmd/.bat, as npm, pnpm and yarn install) would need
 * cmd.exe: for npm and npx the script the shim would start is run under the `node.exe`
 * found the same way (both files are returned and bound by the approval); any other shim
 * is reported as unsupported instead of being run.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ResolvedExecutable {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return { problem: `\`${command}\` is not a plain command name` };
  const windows = platform === 'win32';
  const runnable = windows ? ['.exe', '.com'] : [''];
  let batch: string | undefined;
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of runnable) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return { path: candidate };
      } catch { /* keep looking */ }
    }
    if (windows) for (const extension of ['.cmd', '.bat']) { try { if (statSync(join(directory, `${command}${extension}`)).isFile()) batch ??= `${command}${extension}`; } catch { /* keep looking */ } }
  }
  if (batch && Object.hasOwn(NODE_BUNDLED_SCRIPTS, command)) {
    const node = resolveExecutable('node', env, platform).path;
    const script = node ? join(dirname(node), NODE_BUNDLED_SCRIPTS[command]!) : undefined;
    if (node && script && isRegularFile(script)) return { path: node, prefixArgs: [script] };
    return { problem: `\`${command}\` is a batch script (${batch}) and the ${command} bundled with Node was not found (${script ?? 'no node.exe on an absolute PATH entry'}), so it cannot run without cmd.exe` };
  }
  return { problem: batch ? `\`${command}\` is a batch script (${batch}), which cannot run without cmd.exe and is not supported on Windows` : `command \`${command}\` not found on PATH` };
}
