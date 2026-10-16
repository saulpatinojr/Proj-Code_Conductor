import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// A fake Claude Code whose --version answer is read from a file the test controls, so
// the client can be "upgraded" in the middle of a smoke test.
function fakeClaude(): { root: string; log: string; env: NodeJS.ProcessEnv; setVersion: (version: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'cc-smoke-cli-'));
  temps.push(root);
  const versionFile = join(root, 'version');
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'READ_OK\nCC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"ready"}' });
  writeFileSync(join(root, 'claude'), [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    `if [ "$1" = "--version" ]; then cat '${versionFile}' 2>/dev/null || exit 1; exit 0; fi`,
    'if [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
    // The run itself: the client is upgraded while the smoke test is running.
    `echo '2.0.0 (Claude Code)' > '${versionFile}'`,
    `cat <<'JSON'\n${result}\nJSON`,
  ].join('\n'));
  chmodSync(join(root, 'claude'), 0o755);
  return {
    root,
    log,
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, CODE_CONDUCTOR_HOME: join(root, 'home') },
    setVersion: (version) => writeFileSync(versionFile, `${version}\n`),
  };
}

describe.skipIf(process.platform === 'win32')('cc harness-smoke', () => {
  it('records no trust when the client changes during the smoke test', () => {
    const client = fakeClaude();
    client.setVersion('1.0.0 (Claude Code)');
    const run = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { encoding: 'utf8', env: client.env, timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the client changed during the smoke test (1.0.0 (Claude Code) before, 2.0.0 (Claude Code) after)');
    const state = join(client.root, 'home', 'workstation.json');
    expect(existsSync(state) ? readFileSync(state, 'utf8') : '').not.toContain('ValidatedAt');
  });

  it('refuses, before asking the client anything, when its configuration is inside the repository', () => {
    const client = fakeClaude();
    client.setVersion('1.0.0 (Claude Code)');
    // Started in this repository, a relative CLAUDE_CONFIG_DIR names a folder in it.
    const run = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { encoding: 'utf8', env: { ...client.env, CLAUDE_CONFIG_DIR: '.' }, timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('would read its user configuration from inside the repository: CLAUDE_CONFIG_DIR');
    expect(readFileSync(client.log, 'utf8')).not.toMatch(/auth status|-p /);
  });

  it('checks the folder it was started in too, so Git metadata there cannot move the repository', () => {
    const client = fakeClaude();
    client.setVersion('1.0.0 (Claude Code)');
    // A folder whose own .git points its work tree at an unrelated directory.
    const folder = mkdtempSync(join(tmpdir(), 'cc-smoke-worktree-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'cc-smoke-elsewhere-'));
    temps.push(folder, elsewhere);
    spawnSync('git', ['init', '-q', folder]);
    spawnSync('git', ['-C', folder, 'config', 'core.worktree', elsewhere]);
    const run = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { cwd: folder, encoding: 'utf8', env: { ...client.env, CLAUDE_CONFIG_DIR: '.' }, timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('would read its user configuration from inside the repository');
    expect(readFileSync(client.log, 'utf8')).not.toMatch(/auth status|-p /);
  });

  it('outside a repository, refuses only a relative configuration directory', () => {
    const client = fakeClaude();
    client.setVersion('1.0.0 (Claude Code)');
    const folder = mkdtempSync(join(tmpdir(), 'cc-smoke-plain-'));
    temps.push(folder);
    const absolute = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { cwd: folder, encoding: 'utf8', env: { ...client.env, CLAUDE_CONFIG_DIR: join(folder, 'claude-work') }, timeout: 60_000 });
    expect(absolute.stderr).not.toContain('inside the repository');
    const relative = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { cwd: folder, encoding: 'utf8', env: { ...client.env, CLAUDE_CONFIG_DIR: 'claude-work' }, timeout: 60_000 });
    expect(relative.status).toBe(1);
    expect(relative.stderr).toContain('would read its user configuration from inside the repository');
  });

  it('refuses to smoke-test a client whose version cannot be read', () => {
    const client = fakeClaude();
    // No version file: `claude --version` fails.
    const run = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', 'read'], { encoding: 'utf8', env: client.env, timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('does not report its version');
    expect(run.stdout).not.toContain('SMOKE PASS');
  });
});
