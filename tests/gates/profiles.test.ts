import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blockingGateFailure, commandOnPath, detectGateProfiles, executeGatePlan, forbiddenGateReason, loadGateConfig, planGates, resolveExecutable, type PlannedGate } from '../../packages/gates/src/index.js';
import { validateGateCatalog } from '../../packages/policy/src/index.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-gate-profiles-'));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  return root;
}
const planned = (gate: PlannedGate['gate'], missing: string[] = []): PlannedGate => ({ profile: 'test', gate, timeoutMs: 10_000, missing, explicit: false });

describe('declarative gate profiles', () => {
  it('prefers the lockfile package manager over the generic Node profile', () => {
    expect(detectGateProfiles(workspace({ 'package.json': '{}', 'pnpm-lock.yaml': '' }))).toEqual(['pnpm']);
    expect(detectGateProfiles(workspace({ 'package.json': '{}', 'yarn.lock': '' }))).toEqual(['yarn']);
    expect(detectGateProfiles(workspace({ 'package.json': '{}' }))).toEqual(['node']);
  });

  it('never detects Terraform plan review; it runs only when chosen and is advisory', () => {
    const root = workspace({ 'main.tf': 'terraform {}\n' });
    expect(detectGateProfiles(root)).toEqual(['terraform']);
    const plan = planGates(root, ['terraform-plan']);
    expect(plan.map((item) => [item.gate.id, item.gate.blocking, item.explicit])).toEqual([['terraform-plan', false, true]]);
    expect(plan[0]?.gate.args).not.toContain('apply');
  });

  it('reports unmet prerequisites as blocking failures without executing anything', async () => {
    const root = workspace({ 'package.json': '{"scripts":{"test":"node --test"}}' });
    const plan = planGates(root);
    expect(plan[0]?.missing).toEqual(['node_modules not present']);
    let calls = 0;
    const [result] = await executeGatePlan(root, plan, () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ blocking: true, result: { gate: 'npm-test', status: 'failed' } });
    expect(result?.result.summary).toContain('Code Conductor does not install prerequisites');
    expect(result?.result.summary).toContain('install scripts are repository code');
  });

  it('accepts any one of several prerequisite paths (Yarn Plug n Play)', () => {
    const root = workspace({ 'package.json': '{}', 'yarn.lock': '', '.pnp.cjs': '' });
    const [gate] = planGates(root);
    expect(gate?.missing.filter((item) => !item.startsWith('command'))).toEqual([]);
  });

  it('detects a missing tool without running a shell or `which`', () => {
    expect(commandOnPath('node')).toBe(true);
    expect(commandOnPath('definitely-not-a-real-tool-cc')).toBe(false);
    for (const unsafe of ['../node', 'sh -c', 'node;id', '']) expect(commandOnPath(unsafe)).toBe(false);
    const root = workspace({ 'ansible.cfg': '' });
    const original = process.env.PATH;
    try { process.env.PATH = '/nonexistent'; expect(planGates(root)[0]?.missing).toEqual(['command `ansible-lint` not found on PATH']); }
    finally { process.env.PATH = original; }
  });

  it('refuses unknown profiles with the available list', () => {
    expect(() => planGates(workspace(), ['nope'])).toThrow(/Unknown gate profile: nope\. Available: .*terraform-plan/);
    expect(() => planGates(workspace(), ['__proto__'])).toThrow(/Unknown gate profile/);
  });

  it('never allows a gate that changes infrastructure or auto-approves', () => {
    for (const args of [['apply'], ['apply', '-auto-approve'], ['destroy'], ['-chdir=x', 'state', 'rm', 'a'], ['import', 'a', 'b'], ['workspace', 'delete', 'x']]) {
      expect(forbiddenGateReason({ id: 'x', command: 'terraform', args })).toBeDefined();
    }
    expect(forbiddenGateReason({ id: 'x', command: 'tofu', args: ['apply'] })).toBeDefined();
    expect(forbiddenGateReason({ id: 'x', command: 'helm', args: ['upgrade', '--auto-approve'] })).toBeDefined();
    expect(forbiddenGateReason({ id: 'x', command: 'terraform', args: ['plan', '-input=false'] })).toBeUndefined();
    const config = { version: 1, profiles: { bad: { gates: [{ id: 'deploy', command: 'terraform', args: ['apply', '-auto-approve'] }] } } };
    expect(() => planGates(workspace(), ['bad'], config)).toThrow(/not allowed/);
    expect(validateGateCatalog(config).map((issue) => issue.code)).toEqual(['gates.auto_approve']);
    expect(validateGateCatalog({ profiles: { shell: { gates: [{ id: 's', command: 'sh -c', args: [] }] } } })[0]?.code).toBe('gates.command');
  });

  it('allows only read-only Terraform subcommands and rejects shells and wrappers', () => {
    for (const args of [['refresh'], ['test'], ['init', '-migrate-state', '-force-copy'], ['plan', '-out=tfplan'], ['plan', '-out', 'tfplan'], ['console'], []]) {
      expect(forbiddenGateReason({ id: 'x', command: 'terraform', args }), args.join(' ')).toBeDefined();
    }
    for (const command of ['Terraform', 'terraform.exe', 'TOFU']) expect(forbiddenGateReason({ id: 'x', command, args: ['apply'] })).toBeDefined();
    for (const [command, args] of [['terragrunt', ['apply']], ['env', ['terraform', 'apply']], ['bash', ['-c', 'terraform apply -auto-approve']], ['sudo', ['make']], ['npx', ['something']]] as const) {
      expect(forbiddenGateReason({ id: 'x', command, args: [...args] }), command).toBeDefined();
    }
    for (const args of [['fmt', '-check', '-recursive'], ['validate', '-no-color'], ['plan', '-input=false', '-lock=false', '-no-color'], ['-chdir=infra', 'validate']]) {
      expect(forbiddenGateReason({ id: 'x', command: 'terraform', args })).toBeUndefined();
    }
  });

  it('never reaches readiness from advisory gates alone, and missing prerequisites always block', async () => {
    const root = workspace({ 'main.tf': 'terraform {}\n' });
    const advisoryRan = await executeGatePlan(root, [{ ...planned({ id: 'plan', command: process.execPath, args: ['-e', ''], blocking: false }) }]);
    expect(advisoryRan.map((item) => item.result.gate)).toEqual(['plan', 'no-blocking-gate-passed']);
    expect(blockingGateFailure(advisoryRan)).toBe(true);
    const advisoryMissing = await executeGatePlan(root, [planned({ id: 'plan', command: 'terraform', args: ['plan'], blocking: false }, ['.terraform not present'])]);
    expect(advisoryMissing[0]).toMatchObject({ blocking: true, result: { status: 'failed' } });
    expect(blockingGateFailure(advisoryMissing)).toBe(true);
  });

  it('resolves tools from absolute PATH entries only, so a repository-planted binary never runs', async () => {
    const root = workspace();
    const trusted = join(workspace(), 'trusted');
    mkdirSync(trusted);
    mkdirSync(join(root, 'bin'));
    for (const [directory, label] of [[trusted, 'TRUSTED'], [join(root, 'bin'), 'PLANTED']] as const) {
      writeFileSync(join(directory, 'cc-fake-tool'), `#!/bin/sh\necho ${label}\n`);
      chmodSync(join(directory, 'cc-fake-tool'), 0o755);
    }
    // A relative entry that really reaches the planted binary from this process, and the
    // one a gate running in the repository would see.
    const planted = relative(process.cwd(), join(root, 'bin'));
    for (const path of [`${planted}${delimiter}${trusted}`, `bin${delimiter}${trusted}`, `${delimiter}${trusted}`, `.${delimiter}${trusted}`]) {
      expect(resolveExecutable('cc-fake-tool', { PATH: path }).path, path).toBe(join(trusted, 'cc-fake-tool'));
    }
    expect(resolveExecutable('cc-fake-tool', { PATH: `${planted}${delimiter}bin` }).path).toBeUndefined();
    if (process.platform !== 'win32') {
      const original = process.env.PATH;
      process.env.PATH = `bin${delimiter}${trusted}${delimiter}${original ?? ''}`;
      try {
        const config = { version: 1, profiles: { fake: { gates: [{ id: 'fake', command: 'cc-fake-tool', args: [], blocking: true }] } } };
        const plan = planGates(root, ['fake'], config);
        expect(plan[0]?.executable).toBe(join(trusted, 'cc-fake-tool'));
        const [result] = await executeGatePlan(root, plan);
        expect(result?.evidence.summary).toContain('TRUSTED');
        expect(result?.evidence.source).toContain(join(trusted, 'cc-fake-tool'));
      } finally { process.env.PATH = original; }
    }
  });

  it('keeps the packaged catalog policy-clean', () => {
    expect(validateGateCatalog(loadGateConfig(workspace()))).toEqual([]);
  });
});

// /proc/<pid>/stat state; zombies ("Z") left for a non-reaping PID 1 are not running.
function running(pid: number): boolean {
  const path = `/proc/${pid}/stat`;
  if (existsSync(path)) { const stat = readFileSync(path, 'utf8'); return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)); }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('bounded gate execution', () => {
  it('caps captured output and says so in the evidence', async () => {
    const [result] = await executeGatePlan(workspace(), [planned({ id: 'loud', command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(6 * 1024 * 1024))"] })]);
    expect(result?.result.status).toBe('passed');
    expect(result?.result.summary).toContain('truncated');
    expect(Buffer.byteLength(result?.evidence.summary ?? '')).toBeLessThan(9000);
  });

  it.skipIf(process.platform === 'win32')('finishes promptly when a descendant keeps the output pipes open after the gate exits', async () => {
    for (const detached of [true, false]) {
      const root = workspace();
      const script = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: ${detached}, stdio: ['ignore', 'inherit', 'inherit'] }); g.unref(); require('node:fs').writeFileSync('descendant.pid', String(g.pid));`;
      const started = Date.now();
      const [result] = await executeGatePlan(root, [{ ...planned({ id: 'holder', command: process.execPath, args: ['-e', script] }), timeoutMs: 60_000 }]);
      const descendant = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'));
      try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
      expect(result?.result.status, `detached=${detached}`).toBe('passed');
      expect(Date.now() - started).toBeLessThan(15_000);
    }
  }, 40_000);

  it.skipIf(process.platform === 'win32')('times out and terminates everything the gate started', async () => {
    const root = workspace();
    const script = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync('grandchild.pid', String(g.pid)); setInterval(() => {}, 1000);";
    const [result] = await executeGatePlan(root, [{ ...planned({ id: 'hang', command: process.execPath, args: ['-e', script] }), timeoutMs: 1500 }]);
    expect(result?.result.status).toBe('failed');
    expect(result?.result.summary).toContain('(timeout)');
    const grandchild = Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'));
    for (let attempt = 0; attempt < 50 && running(grandchild); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running(grandchild)).toBe(false);
  }, 15_000);
});
