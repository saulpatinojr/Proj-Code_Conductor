import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cliProcessSpec, localCommandName, missingBaselineCommands } from '../../apps/vscode/src/execution.js';

describe('native VS Code process boundary', () => {
  const root = resolve('workspace with spaces');
  const runtime = join(root, 'extension', 'dist', 'ccon.js');
  it('keeps shell metacharacters and quotes as literal argument values', () => {
    const objective = '$(touch HACKED); `echo nope` & %PATH% "quoted"\nsecond line';
    const spec = cliProcessSpec(root, runtime, ['plan', '--objective', objective], true);
    expect(JSON.parse(Buffer.from(spec.args.at(-1)!, 'base64url').toString())).toEqual({ args: [runtime, 'plan', '--objective', objective], cwd: root });
  });
  it('copies the supplied argument vector rather than sharing mutable caller state', () => {
    const args = ['doctor'];
    const spec = cliProcessSpec(root, runtime, args, true);
    args.push('--other');
    expect(JSON.parse(Buffer.from(spec.args.at(-1)!, 'base64url').toString()).args).toEqual([runtime, 'doctor']);
  });
  it('rejects every command in an untrusted workspace', () => {
    expect(() => cliProcessSpec(root, runtime, ['doctor'], false)).toThrow(/Trust/);
  });
  it('rejects relative working directories, relative runtimes and null bytes', () => {
    expect(() => cliProcessSpec('relative', runtime, [], true)).toThrow(/absolute/);
    expect(() => cliProcessSpec(root, 'relative.js', [], true)).toThrow(/absolute/);
    expect(() => cliProcessSpec(root, runtime, ['bad\0value'], true)).toThrow(/null/);
  });
  it('does not require APM or every AI client for the baseline', () => {
    expect(missingBaselineCommands({ node: true, git: true, gh: true, apm: false })).toEqual([]);
    expect(missingBaselineCommands({ git: true })).toEqual(['node', 'gh']);
  });
  it.each(['--help', '-a', '../node', 'node --flag', '$(node)', 'node;other', ''])('rejects option/path/script-like probe %s', (value) => {
    expect(localCommandName(value)).toBe(false);
  });
  it.each(['node', 'gh', 'kiro-cli', 'pwsh', 'python3.12'])('permits plain command name %s', (value) => {
    expect(localCommandName(value)).toBe(true);
  });
});


describe('task-variable substitution boundary', () => {
  it('never exposes variable markers in data or cwd to the task resolver', () => {
    const root = resolve('${env:OPENAI_API_KEY}');
    const runtime = join(root, '${command:dangerous}', 'ccon.js');
    const spec = cliProcessSpec(root, runtime, ['${env:OPENAI_API_KEY}', '${workspaceFolder}', '${input:foo}'], true);
    expect(spec.args.every((arg) => !arg.includes('${'))).toBe(true);
    expect('cwd' in spec).toBe(false);
  });
  it('real bootstrap preserves task markers, Unicode, spaces, quotes and runtime argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-literal-${workspaceFolder}-'));
    try {
      const runtime = join(root, 'fixture.mjs');
      writeFileSync(runtime, 'console.log(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(1)}));');
      const args = ['${env:OPENAI_API_KEY}', '${command:dangerous}', '\u2603', '$(touch nope); `echo nope`', '"quote"\nline'];
      const spec = cliProcessSpec(root, runtime, args, true);
      const result = spawnSync(process.execPath, spec.args, { encoding: 'utf8', shell: false, timeout: 10000, env: { ...process.env, OPENAI_API_KEY: 'MUST_NOT_EXPAND' } });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ cwd: root, args: [runtime, ...args] });
      expect(result.stdout).not.toContain('MUST_NOT_EXPAND');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
