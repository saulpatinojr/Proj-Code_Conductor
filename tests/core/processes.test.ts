import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runIsolated } from '../../packages/core/src/processes.js';
import { isRunning } from '../process-state.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), 'cc-processes-')); temps.push(path); return path; };
const digest = (stdout: Buffer, stderr: Buffer): string => createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update(stderr).digest()).digest('hex');

describe('bounded isolated runs', () => {
  it('decodes output once, so a character split across pipe writes stays intact', async () => {
    const script = "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50);";
    const outcome = await runIsolated(process.execPath, ['-e', script], { cwd: scratch(), timeoutMs: 10_000, maxBytes: 1024 });
    expect(outcome.stdout).toBe('café');
    expect(outcome.sha256).toBe(digest(Buffer.from('café'), Buffer.alloc(0)));
  });

  it('bounds captured bytes per stream while the digest covers the whole output', async () => {
    const outcome = await runIsolated(process.execPath, ['-e', "process.stdout.write('é'.repeat(4096))"], { cwd: scratch(), timeoutMs: 10_000, maxBytes: 1000 });
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(1000);
    expect(outcome.sha256).toBe(digest(Buffer.from('é'.repeat(4096)), Buffer.alloc(0)));
  });

  it.skipIf(process.platform === 'win32')('does not report a timeout for a command that exited in time while a descendant holds the pipes', async () => {
    const script = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();";
    const outcome = await runIsolated(process.execPath, ['-e', script], { cwd: scratch(), timeoutMs: 1500, maxBytes: 1024 });
    expect(outcome).toMatchObject({ status: 0, timedOut: false });
  }, 20_000);

  it.skipIf(process.platform === 'win32')('terminates isolated runs when Code Conductor is interrupted', async () => {
    const root = scratch();
    const processes = pathToFileURL(resolve('packages/core/dist/processes.js')).href;
    // The "parent" starts a long gate, then is interrupted; nothing else handles SIGTERM.
    // The gate renames its pid file into place, so once it exists it is complete.
    const parentScript = `import { runIsolated } from ${JSON.stringify(processes)};
void runIsolated(process.execPath, ['-e', "const fs = require('node:fs'); fs.writeFileSync('gate.pid.tmp', String(process.pid)); fs.renameSync('gate.pid.tmp', 'gate.pid'); setInterval(() => {}, 1000)"], { cwd: ${JSON.stringify(root)}, timeoutMs: 60000, maxBytes: 1024 });
setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], { stdio: 'ignore' });
    const pidFile = join(root, 'gate.pid');
    let gate = 0;
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) await new Promise((done) => setTimeout(done, 25));
      gate = Number(readFileSync(pidFile, 'utf8'));
      expect(isRunning(gate)).toBe(true);
      const exited = new Promise<NodeJS.Signals | null>((done) => parent.once('exit', (_code, signal) => done(signal)));
      parent.kill('SIGTERM');
      expect(await exited).toBe('SIGTERM');
      for (let attempt = 0; attempt < 100 && isRunning(gate); attempt += 1) await new Promise((done) => setTimeout(done, 20));
      expect(isRunning(gate)).toBe(false);
    } finally {
      // If an assertion failed, the gate's group may still run. Kill it and the parent,
      // reading the pid file again in case it appeared after the wait gave up.
      if (!gate && existsSync(pidFile)) gate = Number(readFileSync(pidFile, 'utf8'));
      for (const pid of [gate ? -gate : 0, parent.pid ?? 0]) { try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }, 20_000);
});
