import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawnIsolated, terminateGroup } from '../../packages/adapters/src/index.js';

// /proc/<pid>/stat: "pid (comm) state ppid pgrp ...". A killed process whose new parent
// does not reap it (common for PID 1 in containers) stays a zombie ("Z"): it is not running.
function stat(pid: number): { state: string; pgrp: number } | undefined {
  const path = `/proc/${pid}/stat`;
  if (existsSync(path)) {
    const fields = readFileSync(path, 'utf8').slice(readFileSync(path, 'utf8').lastIndexOf(')') + 2).split(' ');
    return { state: fields[0]!, pgrp: Number(fields[2]) };
  }
  try { process.kill(pid, 0); return { state: 'R', pgrp: Number.NaN }; } catch { return undefined; }
}
const alive = (pid: number): boolean => { const info = stat(pid); return Boolean(info && info.state !== 'Z' && info.state !== 'X'); };

describe.skipIf(process.platform === 'win32')('provider process isolation', () => {
  it('runs clients in their own process group and terminates what they leave behind', async () => {
    // The "client" starts a long-lived grandchild, reports its pid and exits.
    const script = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); g.unref(); console.log(g.pid);";
    const child = spawnIsolated(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    const grandchild = Number.parseInt(output.trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    if (existsSync('/proc/self/stat')) expect(stat(grandchild)?.pgrp).toBe(child.pid);
    terminateGroup(child, 'SIGKILL');
    for (let attempt = 0; attempt < 50 && alive(grandchild); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(grandchild)).toBe(false);
  });
});
