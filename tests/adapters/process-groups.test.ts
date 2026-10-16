import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinAdapters, spawnIsolated, terminateGroup, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';

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

  // A fake `codex` on PATH runs the given Node script, so the real SubprocessAdapter is exercised.
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  async function runFakeClient(script: string, timeoutMs: number) {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-client-'));
    writeFileSync(join(bin, 'client.js'), script);
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'client.js')}" "$@"\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
    cleanups.push(() => { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); });
    const request = { task: {}, assignment: { authority: [] }, cwd: bin, timeoutMs, prompt: 'p' } as unknown as HarnessExecutionRequest;
    const started = Date.now();
    const outcome = await createBuiltinAdapters().get('codex')!.execute(request);
    return { outcome, elapsed: Date.now() - started };
  }

  it('kills a client that ignores SIGTERM after its timeout instead of hanging', async () => {
    const { outcome, elapsed } = await runFakeClient("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", 300);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.signal).toBe('SIGKILL');
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it('finishes when a descendant that left the process group keeps the output pipes open', async () => {
    const script = "const { spawn } = require('node:child_process'); const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); d.unref(); console.log(`pid:${d.pid}`);";
    const { outcome, elapsed } = await runFakeClient(script, 60_000);
    const escaped = Number(/pid:(\d+)/.exec(outcome.stdout)?.[1]);
    cleanups.push(() => { try { process.kill(escaped, 'SIGKILL'); } catch { /* already gone */ } });
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Number.isInteger(escaped)).toBe(true);
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);
});
