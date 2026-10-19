import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blockingGateFailure, commandOnPath, detectGateProfiles, executeGatePlan, forbiddenGateReason, loadGateConfig, planGates, resolveExecutable, type PlannedGate } from '../../packages/gates/src/index.js';
import { validateGateCatalog } from '../../packages/policy/src/index.js';
import { isRunning } from '../process-state.js';

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
    expect(forbiddenGateReason({ id: 'x', command: 'terraform', args: ['plan', '-input=false', '-lock=false'] })).toBeUndefined();
    const config = { version: 1, profiles: { bad: { gates: [{ id: 'deploy', command: 'terraform', args: ['apply', '-auto-approve'] }] } } };
    expect(() => planGates(workspace(), ['bad'], config)).toThrow(/not allowed/);
    expect(validateGateCatalog(config).map((issue) => issue.code)).toEqual(['gates.auto_approve']);
    expect(validateGateCatalog({ version: 1, profiles: { shell: { gates: [{ id: 's', command: 'sh -c', args: [] }] } } })[0]?.code).toBe('gates.command');
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
    // -chdir stays inside the repository.
    for (const chdir of ['-chdir=../other', '-chdir=/etc', '-chdir=infra/../..', '-chdir=C:\\x']) expect(forbiddenGateReason({ id: 'x', command: 'terraform', args: [chdir, 'validate'] }), chdir).toBeDefined();
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
    // On Windows only .exe and .com files are runnable, so the fixtures carry that name there.
    const tool = process.platform === 'win32' ? 'ansible-lint.exe' : 'ansible-lint';
    for (const [directory, label] of [[trusted, 'TRUSTED'], [join(root, 'bin'), 'PLANTED']] as const) {
      writeFileSync(join(directory, tool), `#!/bin/sh\necho ${label}\n`);
      chmodSync(join(directory, tool), 0o755);
    }
    // A relative entry that really reaches the planted binary from this process, and the
    // one a gate running in the repository would see.
    const planted = relative(process.cwd(), join(root, 'bin'));
    for (const path of [`${planted}${delimiter}${trusted}`, `bin${delimiter}${trusted}`, `${delimiter}${trusted}`, `.${delimiter}${trusted}`]) {
      expect(resolveExecutable('ansible-lint', { PATH: path }).path, path).toBe(join(trusted, tool));
    }
    expect(resolveExecutable('ansible-lint', { PATH: `${planted}${delimiter}bin` }).path).toBeUndefined();
    if (process.platform !== 'win32') {
      const original = process.env.PATH;
      process.env.PATH = `bin${delimiter}${trusted}${delimiter}${original ?? ''}`;
      try {
        const config = { version: 1, profiles: { fake: { gates: [{ id: 'fake', command: 'ansible-lint', args: ['--offline'], blocking: true }] } } };
        const plan = planGates(root, ['fake'], config);
        expect(plan[0]?.executable).toBe(join(trusted, 'ansible-lint'));
        const [result] = await executeGatePlan(root, plan);
        expect(result?.evidence.summary).toContain('TRUSTED');
        expect(result?.evidence.source).toContain(join(trusted, 'ansible-lint'));
      } finally { process.env.PATH = original; }
    }
  });

  it.skipIf(process.platform === 'win32')('gives gate processes only absolute PATH entries, so tools they start come from there too', async () => {
    const root = workspace();
    const trusted = join(workspace(), 'trusted');
    mkdirSync(trusted);
    mkdirSync(join(root, 'bin'));
    // Like npm's `#!/usr/bin/env node`: the tool itself starts an interpreter found on PATH.
    writeFileSync(join(trusted, 'ansible-lint'), '#!/usr/bin/env cc-fake-interp\n');
    for (const [directory, label] of [[trusted, 'TRUSTED'], [join(root, 'bin'), 'PLANTED']] as const) {
      writeFileSync(join(directory, 'cc-fake-interp'), `#!/bin/sh\necho ${label}\n`);
      chmodSync(join(directory, 'cc-fake-interp'), 0o755);
    }
    chmodSync(join(trusted, 'ansible-lint'), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `bin${delimiter}${trusted}${delimiter}${original ?? ''}`;
    try {
      const config = { version: 1, profiles: { fake: { gates: [{ id: 'fake', command: 'ansible-lint', args: ['--offline'], blocking: true }] } } };
      const [result] = await executeGatePlan(root, planGates(root, ['fake'], config));
      expect(result?.evidence.summary).toContain('TRUSTED');
      expect(result?.evidence.summary).not.toContain('PLANTED');
    } finally { process.env.PATH = original; }
  });

  it('refuses every spelling outside the fixed tool shapes', () => {
    const refused: Array<[string, string[]]> = [
      // Interpreter inline code and loaders.
      ['node', ['-pe', 'x']], ['node', ['--import', 'data:text/javascript,x']], ['node', ['--loader', 'data:x']], ['node', ['--eval=x']], ['nodejs', ['-e', 'x']],
      ['node', ['/abs/script.js']], ['node', ['../outside.js']], ['node', ['scripts/../../x.js']], ['node', ['script.sh']],
      // Installed dependencies' command line programs, and scripts in hidden folders.
      ['node', ['node_modules/vite/bin/vite.js', 'build', '--config', '/tmp/outside.mjs']], ['node', ['node_modules/npm/bin/npx-cli.js', '--yes', 'x']],
      ['node', ['packages/app/Node_Modules/x/cli.js']], ['node', ['node_modules\\x\\cli.js']], ['node', ['.yarn/releases/yarn-4.0.0.cjs', 'dlx', 'x']], ['node', ['.git/hooks/x.js']], ['node', ['tools/.cache/x.mjs']],
      // Windows drops a trailing dot, so these can name node_modules there.
      ['node', ['node_modules./vite/bin/vite.js']], ['node', ['node_modules../x.js']], ['node', ['scripts./x.js']],
      ['python3', ['-cx']], ['python3', ['-Ic', 'x']], ['python3', ['-m', 'timeit', 'x']], ['python3.12', ['-c', 'x']], ['py', ['-c', 'x']],
      ['perl', ['-E', 'x']], ['perl', ['-le', 'x']], ['ruby', ['-le', 'x']], ['php', ['-B', 'x']], ['deno', ['eval', 'x']],
      // Package executors and other subcommands that run packages.
      ['npm', ['run', 'env']], ['yarn', ['run', 'env']], ['npm', ['exe', '--call=x']], ['npm', ['EXEC', 'x']], ['npm', ['init', 'x']], ['npm', ['create', 'x']], ['npm', ['explore', 'x']], ['npm', ['run', 'x', '--', '-y']], ['npm', ['--prefix', '/x', 'test']], ['npm', ['run', '$(x)']],
      ['yarn', ['node', '-e', 'x']], ['yarnpkg', ['dlx', 'x']], ['pnpx', ['x']], ['bunx', ['x']], ['bun', ['x', 'y']], ['corepack', ['npm', 'exec', 'x']],
      // Wrappers.
      ...['flock', 'ionice', 'taskset', 'setarch', 'chrt', 'prlimit', 'runuser', 'setpriv', 'strace', 'watch', 'xvfb-run', 'wsl', 'forfiles', 'conhost'].map((command): [string, string[]] => [command, ['terraform', 'apply']]),
      // Terraform forms that would write despite -check, or take other options.
      ['terraform', ['fmt', '-check', '-check=false']], ['terraform', ['fmt', '.', '-check']], ['terraform', ['fmt', '--', '-check']], ['terraform', ['fmt', '-write=true', '-check']],
      ['terraform', ['plan', '-var-file=x', '-input=false']], ['terraform', ['validate', 'dir']], ['tofu', ['plan', '-out=x']],
      // Plan without -lock=false takes the state lock; without -input=false it can prompt.
      ['terraform', ['plan']], ['terraform', ['plan', '-input=false']], ['tofu', ['plan', '-lock=false']],
      // Names on Object.prototype are not subcommands.
      ['terraform', ['hasOwnProperty']], ['terraform', ['constructor', '-x']], ['terraform', ['__proto__']], ['terraform', ['-chdir=x', 'valueOf']], ['tofu', ['isPrototypeOf']],
      // ansible-lint fixes files.
      ['ansible-lint', ['--fix']], ['ansible-lint', ['--write']], ['ansible-lint', ['playbook.yml']],
      // Without --offline, ansible-lint installs what requirements.yml names.
      ['ansible-lint', []], ['ansible-lint', ['--strict']],
    ];
    for (const [command, args] of refused) expect(forbiddenGateReason({ id: 'x', command, args }), `${command} ${args.join(' ')}`).toBeDefined();
    // The shapes the packaged catalog uses.
    for (const [command, args] of [['npm', ['run', 'typecheck']], ['npm', ['test']], ['pnpm', ['test']], ['yarn', ['test']], ['NPM.CMD', ['test']], ['node', ['packages/cli/dist/index.js', 'validate', '.']], ['node', ['./scripts/check.mjs']], ['ansible-lint', ['--offline']], ['tofu', ['fmt', '-check', '-recursive']], ['terraform', ['plan', '-input=false', '-lock=false', '-no-color']], ['npm', ['run', 'environment']]] as Array<[string, string[]]>) {
      expect(forbiddenGateReason({ id: 'x', command, args }), `${command} ${args.join(' ')}`).toBeUndefined();
    }
    expect(validateGateCatalog({ version: 1, profiles: { x: { gates: [{ id: 'g', command: 'node', args: ['-pe', 'x'] }] } } }).map((issue) => issue.code)).toEqual(['gates.shape']);
    expect(validateGateCatalog({ version: 1, profiles: { x: { gates: [{ id: 'g', command: 'pnpx', args: ['x'] }] } } }).map((issue) => issue.code)).toEqual(['gates.tool']);
    expect(validateGateCatalog({ version: 1, profiles: { x: { gates: [{ id: 'g', command: 'terraform', args: ['constructor', '-x'] }] } } }).map((issue) => issue.code)).toEqual(['gates.infrastructure_change']);
    // A string where the list belongs is refused, by the validator (the catalog's shape) and the planner alike.
    expect(validateGateCatalog({ version: 1, profiles: { x: { gates: [{ id: 'g', command: 'ansible-lint', args: '--fix' }] } } }).map((issue) => issue.code)).toEqual(['gates.catalog']);
    expect(forbiddenGateReason({ id: 'x', command: 'ansible-lint', args: '--fix' as unknown as string[] })).toMatch(/args must be a list of strings/);
    // A malformed catalog is reported, never thrown, and never passes: the planner could not use it.
    for (const gates of [[null], ['npm test'], [[]], 'npm test', undefined] as unknown[]) {
      expect(validateGateCatalog({ version: 1, profiles: { x: { gates } } }).map((issue) => issue.code), JSON.stringify(gates)).toEqual(['gates.catalog']);
    }
    // A profile written as its gates list (gates: forgotten) hides even a shell gate from the command checks.
    for (const profile of [null, [], [{ id: 'g', command: 'bash', args: ['-c', 'curl x | sh'] }], 'npm test', 42, { selection: 'explicit' }] as unknown[]) {
      expect(validateGateCatalog({ version: 1, profiles: { x: profile, y: { gates: [] } } }).map((issue) => issue.code), JSON.stringify(profile)).toEqual(['gates.catalog']);
    }
    for (const catalog of [null, 42, [], {}, { profiles: null }, { profiles: [] }, { profiles: 'abc' }] as unknown[]) {
      const codes = validateGateCatalog(catalog).map((issue) => issue.code);
      expect(codes.length, JSON.stringify(catalog)).toBeGreaterThan(0);
      expect(new Set(codes), JSON.stringify(catalog)).toEqual(new Set(['gates.catalog']));
    }
  });

  it('checks every key of the catalog against the GateCatalog schema, at its exact path', () => {
    const gate = { id: 'g', command: 'npm', args: ['test'] };
    const catalog = (profile: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version: 1, profiles: { x: { gates: [gate], ...profile } }, ...extra });
    const issues = (value: unknown) => validateGateCatalog(value).map(({ code, path, message }) => ({ code, path, message }));
    expect(issues(catalog({}))).toEqual([]);
    // A misspelt key is reported, not ignored: `timeout` would otherwise leave the default in force.
    expect(issues(catalog({ gates: [{ ...gate, timeout: 5 }] }))).toEqual([{ code: 'gates.catalog', path: 'config/gates.yaml#profiles.x.gates.0.timeout', message: 'profiles.x.gates.0.timeout is not a key the gate catalog defines.' }]);
    expect(issues(catalog({ detect: { any_files: ['a'] } }))[0]?.path).toBe('config/gates.yaml#profiles.x.detect.any_files');
    // Leaf types that used to make detection or prerequisite checks throw, or misread a value.
    for (const [profile, path] of [
      [{ detect: { all_files: 'package.json' } }, 'profiles.x.detect.all_files'],
      [{ gates: [{ ...gate, requires: { paths: 'node_modules' } }] }, 'profiles.x.gates.0.requires.paths'],
      [{ gates: [{ ...gate, blocking: 'false' }] }, 'profiles.x.gates.0.blocking'],
      [{ gates: [{ ...gate, timeout_ms: '30s' }] }, 'profiles.x.gates.0.timeout_ms'],
      [{ gates: [{ ...gate, timeout_ms: 0 }] }, 'profiles.x.gates.0.timeout_ms'],
      [{ selection: 'auto' }, 'profiles.x.selection'],
      [{ gates: [{ ...gate, requires: { path: ['node_modules'] } }] }, 'profiles.x.gates.0.requires.path'],
      [{ gates: [{ ...gate, command: '' }] }, 'profiles.x.gates.0.command'],
      [{ replaces: ['y', 'y'] }, 'profiles.x.replaces'],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(issues(catalog(profile)).map((issue) => issue.path), JSON.stringify(profile)).toEqual([`config/gates.yaml#${path}`]);
    }
    // An empty file list would match every repository (`[].every` is true), so it is refused.
    expect(issues(catalog({ detect: { all_files: [] } }))[0]?.message).toBe('profiles.x.detect.all_files must not be empty.');
    // A package name alone never selects a profile.
    expect(issues(catalog({ detect: { package_name: 'p' } }))).toEqual([{ code: 'gates.catalog', path: 'config/gates.yaml#profiles.x.detect', message: 'Profile x detect needs all_files, any_file or any_glob; package_name alone never selects it.' }]);
    expect(issues(catalog({ selection: 'auto' }))[0]?.message).toBe('profiles.x.selection must be detected or explicit.');
    expect(issues(catalog({}, { version: 2 }))[0]?.message).toBe('version must be 1.');
    expect(issues(catalog({}, { extra: true }))[0]?.path).toBe('config/gates.yaml#extra');
    // Node runs any longer timer, Infinity included, after 1 ms, so timeouts stay within its range.
    for (const timeout of [Infinity, 2147483648, 0]) {
      expect(issues(catalog({ gates: [{ ...gate, timeout_ms: timeout }] })).map((issue) => issue.path), String(timeout)).toEqual(['config/gates.yaml#profiles.x.gates.0.timeout_ms']);
      expect(issues(catalog({}, { default_timeout_ms: timeout })).map((issue) => issue.path), String(timeout)).toEqual(['config/gates.yaml#default_timeout_ms']);
    }
    expect(issues(catalog({ gates: [{ ...gate, timeout_ms: 2147483647 }] }, { default_timeout_ms: 1 }))).toEqual([]);
    expect(issues({ profiles: {} }).map((issue) => issue.message)).toEqual(['The catalog needs version.']);
    // Names reach `--gate-profiles a,b` and run records, so they stay plain; one issue per bad name.
    const badNames = issues({ version: 1, profiles: { 'a,b': { gates: [{ ...gate, id: 'has space' }] } } });
    expect(badNames.map((issue) => issue.path)).toEqual(['config/gates.yaml#profiles."a,b"', 'config/gates.yaml#profiles."a,b".gates.0.id']);
    expect(badNames[0]?.message).toBe("profiles.\"a,b\" must be a plain name: letters, digits, '.', '_' or '-', starting with a letter or digit.");
    // Keys are unescaped from JSON pointers in RFC 6901 order (~1 before ~0), and shown quoted unless plain,
    // so a `.` cannot blur the path and a line break cannot forge another output line.
    expect(issues({ version: 1, profiles: { 'a/b~1c': { gates: 5 } } }).map((issue) => issue.path)).toEqual(['config/gates.yaml#profiles."a/b~1c"', 'config/gates.yaml#profiles."a/b~1c".gates']);
    const forged = issues(catalog({ gates: [{ ...gate, 'bad\nERROR fake': 1 }] }))[0];
    expect(forged?.path).toBe('config/gates.yaml#profiles.x.gates.0."bad\\nERROR fake"');
    expect(forged?.message).not.toContain('\n');
    // A profile that replaces itself is dropped by its own detection.
    expect(issues({ version: 1, profiles: { 'a.b': { replaces: ['a.b'], gates: [] } } })).toEqual([{ code: 'gates.replaces', path: 'config/gates.yaml#profiles."a.b"', message: 'Profile a.b replaces itself, so it is never selected.' }]);
    // Input deep enough to exhaust the validator's stack is reported, never thrown.
    let deep: unknown[] = [];
    let other: unknown[] = [];
    for (let level = 0; level < 100_000; level += 1) { deep = [deep]; other = [other]; }
    expect(issues(catalog({ replaces: [deep, other] }))[0]?.message).toMatch(/^The catalog could not be checked: /);
    expect(issues(catalog({ replaces: ['nope'] }))).toEqual([{ code: 'gates.replaces', path: 'config/gates.yaml#profiles.x', message: 'Profile x replaces unknown profiles: nope.' }]);
  });

  it('never plans a dependency\'s command line program as a gate', () => {
    const root = workspace({ 'package.json': '{}' });
    const config = { version: 1, profiles: { probe: { gates: [{ id: 'vite', command: 'node', args: ['node_modules/vite/bin/vite.js', 'build', '--config', '/tmp/outside.mjs'], blocking: true }] } } };
    expect(() => planGates(root, ['probe'], config)).toThrow(/Gate probe\/vite is not allowed: .*nothing under node_modules/);
  });

  it('rejects inline interpreter code, package executors and file-writing Terraform forms', () => {
    for (const [command, args] of [['node', ['-e', 'x']], ['python3', ['-c', 'x']], ['perl', ['-e', 'x']], ['npm', ['exec', 'x']], ['pnpm', ['dlx', 'x']], ['yarn', ['dlx', 'x']], ['setsid', ['x']], ['stdbuf', ['-o0', 'x']], ['terraform', ['fmt']], ['terraform', ['plan', '-generate-config-out=x.tf']]] as const) {
      expect(forbiddenGateReason({ id: 'x', command, args: [...args] }), `${command} ${args.join(' ')}`).toBeDefined();
    }
    expect(forbiddenGateReason({ id: 'x', command: 'node', args: ['packages/cli/dist/index.js', 'validate', '.'] })).toBeUndefined();
    expect(forbiddenGateReason({ id: 'x', command: 'npm', args: ['run', 'typecheck'] })).toBeUndefined();
  });

  it('keeps the packaged catalog policy-clean', () => {
    expect(validateGateCatalog(loadGateConfig(workspace()))).toEqual([]);
  });
});

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
      const script = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: ${detached}, stdio: ['ignore', 'inherit', 'inherit'] }); g.unref(); const fs = require('node:fs'); fs.writeFileSync('descendant.pid.tmp', String(g.pid)); fs.renameSync('descendant.pid.tmp', 'descendant.pid');`;
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
    const script = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); const fs = require('node:fs'); fs.writeFileSync('grandchild.pid.tmp', String(g.pid)); fs.renameSync('grandchild.pid.tmp', 'grandchild.pid'); setInterval(() => {}, 1000);";
    const pending = executeGatePlan(root, [{ ...planned({ id: 'hang', command: process.execPath, args: ['-e', script] }), timeoutMs: 1500 }]);
    // The script renames the pid file into place, so once it exists it is complete: a file
    // being written can exist while still empty.
    const pidFile = join(root, 'grandchild.pid');
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    // Running before the timeout, so the check after it is not vacuous.
    expect(isRunning(grandchild)).toBe(true);
    const [result] = await pending;
    expect(result?.result.status).toBe('failed');
    expect(result?.result.summary).toContain('(timeout)');
    for (let attempt = 0; attempt < 50 && isRunning(grandchild); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isRunning(grandchild)).toBe(false);
  }, 15_000);
});

describe('npm and npx on Windows (D-074)', () => {
  it('runs them through the npm-cli.js bundled with the node.exe found on PATH, never the batch shim', () => {
    const nodeDir = join(workspace(), 'nodejs');
    mkdirSync(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    for (const file of ['node.exe', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', join('node_modules', 'npm', 'bin', 'npm-cli.js'), join('node_modules', 'npm', 'bin', 'npx-cli.js')]) writeFileSync(join(nodeDir, file), '');
    const env = { PATH: nodeDir };
    expect(resolveExecutable('npm', env, 'win32')).toEqual({ path: join(nodeDir, 'node.exe'), prefixArgs: [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
    expect(resolveExecutable('npx', env, 'win32')).toEqual({ path: join(nodeDir, 'node.exe'), prefixArgs: [join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')] });
    // Other shims still need cmd.exe and stay unsupported.
    expect(resolveExecutable('pnpm', env, 'win32').problem).toMatch(/batch script \(pnpm\.cmd\).*not supported on Windows/);
    // node.exe must come from an absolute PATH entry like any other tool.
    expect(resolveExecutable('npm', { PATH: `${relative(process.cwd(), nodeDir)}` }, 'win32').problem).toMatch(/not found on PATH/);
    // The shim alone is never run: without the bundled script, npm is reported, not started.
    rmSync(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(resolveExecutable('npm', env, 'win32').problem).toMatch(/npm bundled with Node was not found/);
    // The POSIX rule is unchanged: a plain `npm` file on PATH, or nothing.
    expect(resolveExecutable('npm', env, 'linux').problem).toMatch(/not found on PATH/);
  });

  it('passes the resolution\'s own arguments to the executor first and names them in the evidence and the approval binding', async () => {
    const root = workspace();
    const calls: string[][] = [];
    const node = join(root, 'node.exe');
    const script = join(root, 'npm-cli.js');
    const plan: PlannedGate = { ...planned({ id: 'typecheck', command: 'npm', args: ['run', 'typecheck'], blocking: true }), executable: node, prefixArgs: [script] };
    const executions = await executeGatePlan(root, [plan], (_cwd, command, args, _timeout, executable) => { calls.push([executable, command, ...args]); return { status: 0, stdout: 'ok', stderr: '' }; });
    expect(calls).toEqual([[node, 'npm', script, 'run', 'typecheck']]);
    expect(executions[0]?.result.status).toBe('passed');
    expect(executions[0]?.evidence.source).toBe(`npm run typecheck (${node} ${script})`);
  });
});
