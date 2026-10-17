import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinAdapters, spawnIsolated, terminateGroup, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { isRunning, processState } from '../process-state.js';

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
    expect(isRunning(grandchild)).toBe(true);
    if (existsSync('/proc/self/stat')) expect(processState(grandchild)?.pgrp).toBe(child.pid);
    terminateGroup(child, 'SIGKILL');
    for (let attempt = 0; attempt < 50 && isRunning(grandchild); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isRunning(grandchild)).toBe(false);
  });

  it('reaps provider groups on a signal without overriding an embedding host\'s own handler', () => {
    // Runs in a separate Node process against the built package: the host registers its
    // own SIGTERM handler, so the process must stay alive and the handler run once.
    const adapters = pathToFileURL(resolve('packages/adapters/dist/index.js')).href;
    const script = `import { spawnIsolated } from ${JSON.stringify(adapters)};
const child = spawnIsolated(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
let calls = 0;
process.on('SIGTERM', () => { calls += 1; });
child.once('exit', (code, signal) => { setTimeout(() => { console.log(JSON.stringify({ calls, signal })); process.exit(0); }, 200); });
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    expect(JSON.parse(output.trim())).toEqual({ calls: 1, signal: 'SIGKILL' });
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
