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

// A fake Claude Code that, in the smoke test's workspace, runs the shell lines in `write`
// and then reports the result `reply` (CC_RESULT_JSON by default).
function writingClaude(write: string, reply = 'Done.\nCC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"ready"}'): { home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'cc-smoke-modify-'));
  temps.push(root);
  writeFileSync(join(root, 'write.sh'), `${write}\n`);
  writeFileSync(join(root, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "1.0.0 (Claude Code)"; exit 0; fi',
    'if [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
    `. '${join(root, 'write.sh')}'`,
    `cat <<'JSON'\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply })}\nJSON`,
  ].join('\n'));
  chmodSync(join(root, 'claude'), 0o755);
  const home = join(root, 'home');
  return { home, env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, CODE_CONDUCTOR_HOME: home } };
}

// Each test starts the CLI and gives it 60 s; creating 10,001 files alone can take seconds
// on a slow file system. SIGKILL, because a CLI blocked in a system call (opening a FIFO,
// say) never runs its own SIGTERM handler, and spawnSync would wait for it forever.
describe.skipIf(process.platform === 'win32')('ccon harness-smoke --mode modify', { timeout: 90_000 }, () => {
  const smoke = (env: NodeJS.ProcessEnv, mode = 'modify') => spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'harness-smoke', 'claude', '--mode', mode], { encoding: 'utf8', env, timeout: 60_000, killSignal: 'SIGKILL' });
  const trusted = (home: string) => (existsSync(join(home, 'workstation.json')) ? readFileSync(join(home, 'workstation.json'), 'utf8') : '').includes('ValidatedAt');

  it.each([
    ['LF', `printf 'WRITE_OK\\n' > OUTPUT.txt`],
    ['CRLF, as a client on Windows may write it', `printf 'WRITE_OK\\r\\n' > OUTPUT.txt`],
    ['a UTF-8 byte-order mark and CRLF (PowerShell 5.1 Out-File -Encoding utf8)', `printf '\\357\\273\\277WRITE_OK\\r\\n' > OUTPUT.txt`],
    ['UTF-16LE (PowerShell 5.1 redirection)', `printf '\\377\\376W\\000R\\000I\\000T\\000E\\000_\\000O\\000K\\000\\r\\000\\n\\000' > OUTPUT.txt`],
  ])('passes when OUTPUT.txt holds WRITE_OK and a line ending: %s', (_, write) => {
    const client = writingClaude(write);
    const run = smoke(client.env);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('SMOKE PASS claude cli modify');
    expect(trusted(client.home)).toBe(true);
  });

  it.each([
    ['the content differs', `printf 'WRITE_OK' > OUTPUT.txt`, undefined, 'result=completed changed=+OUTPUT.txt output="WRITE_OK"'],
    ['another file was created too', `printf 'WRITE_OK\\n' > OUTPUT.txt; printf x > EXTRA.txt`, undefined, 'changed=+EXTRA.txt,+OUTPUT.txt output="WRITE_OK\\n"'],
    ['a tracked file was changed', `printf 'WRITE_OK\\n' > OUTPUT.txt; printf changed > INPUT.txt`, undefined, 'changed=~INPUT.txt,+OUTPUT.txt'],
    ['the file is missing', ':', undefined, 'changed=none output=missing'],
    ['OUTPUT.txt is a symlink', `printf 'WRITE_OK\\n' > real.txt; ln -s real.txt OUTPUT.txt`, undefined, 'changed=+OUTPUT.txt,+real.txt output=unreadable (not a regular file of at most 1 KiB)'],
    ['OUTPUT.txt is a folder', 'mkdir OUTPUT.txt', undefined, 'changed=+OUTPUT.txt/ output=unreadable (not a regular file of at most 1 KiB)'],
    ['OUTPUT.txt is over 1 KiB', `printf 'WRITE_OK\\n' > OUTPUT.txt; head -c 1100 /dev/zero >> OUTPUT.txt`, undefined, 'changed=+OUTPUT.txt output=unreadable (not a regular file of at most 1 KiB)'],
    ['UTF-16LE OUTPUT.txt has a stray odd byte', `printf '\\377\\376W\\000R\\000I\\000T\\000E\\000_\\000O\\000K\\000\\r\\000\\n\\000Z' > OUTPUT.txt`, undefined, 'changed=+OUTPUT.txt output="WRITE_OK\\r\\n\\u{fffd}" (utf-16le)'],
    ['an empty folder was created too', `printf 'WRITE_OK\\n' > OUTPUT.txt; mkdir -p a/b`, undefined, 'changed=+a/,+a/b/,+OUTPUT.txt'],
    // Opening a FIFO blocks until a writer comes, so the check must never open one.
    ['a FIFO was left behind', `printf 'WRITE_OK\\n' > OUTPUT.txt; mkfifo pipe`, undefined, 'changed=+OUTPUT.txt,+pipe'],
    ['the workspace holds too many entries to list', `printf 'WRITE_OK\\n' > OUTPUT.txt; mkdir many; (cd many && seq 1 10001 | xargs touch)`, undefined, 'changed=(the workspace could not be listed: The smoke workspace holds more than 10,000 entries.)'],
    ['there is no structured result', `printf 'WRITE_OK\\n' > OUTPUT.txt`, 'Done.', 'result=failed (Agent did not return a valid CC_RESULT_JSON structured result.)'],
    ['the structured result breaks the contract', `printf 'WRITE_OK\\n' > OUTPUT.txt`,
      'Done.\nCC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":["OUTPUT.txt now holds WRITE_OK"],"findings":[],"risks":[],"blockers":[],"recommendation":"ready"}',
      'result=failed (Agent returned CC_RESULT_JSON that failed AgentResult contract validation: /evidence/0 must be object)'],
  ])('fails, naming the failed check, when %s', (_, write, reply, detail) => {
    const client = writingClaude(write, reply);
    const run = smoke(client.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('SMOKE FAIL claude cli modify: exit=0 signal=null timeout=false');
    expect(run.stderr).toContain(detail);
    expect(trusted(client.home)).toBe(false);
  });

  it('shows terminal control characters in OUTPUT.txt as escapes, never raw', () => {
    const client = writingClaude(`printf '\\033]0;title\\007\\033[2JWRITE' > OUTPUT.txt`);
    const run = smoke(client.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('output="\\u001b]0;title\\u0007\\u001b[2JWRITE"');
    expect(run.stderr).not.toMatch(/[\u0007\u001b]/);
  });

  it('sees what the client wrote even when Git is set to hide it', () => {
    // status.showUntrackedFiles=no and a global exclude make `git status` print nothing.
    const client = writingClaude(`printf x > SNEAKY.txt; printf 'WRITE_OK\\n' > OUTPUT.txt`);
    const config = join(client.home, '..', 'gitconfig');
    writeFileSync(join(client.home, '..', 'excludes'), '*.txt\n');
    writeFileSync(config, `[status]\n\tshowUntrackedFiles = no\n[core]\n\texcludesFile = ${join(client.home, '..', 'excludes')}\n`);
    const env = { ...client.env, GIT_CONFIG_GLOBAL: config };
    const read = smoke(env, 'read');
    expect(read.status).toBe(1);
    expect(read.stderr).toContain('changed=+OUTPUT.txt,+SNEAKY.txt');
    const modify = smoke(env);
    expect(modify.status).toBe(1);
    expect(modify.stderr).toContain('changed=+OUTPUT.txt,+SNEAKY.txt');
    expect(trusted(client.home)).toBe(false);
  });

  it.each([
    ['nothing changed', ':'],
    ['the client ran Git, which rewrites only its own index', 'git status >/dev/null; git add -A'],
  ])('passes read mode when %s', (_, write) => {
    const client = writingClaude(write);
    const run = smoke(client.env, 'read');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('SMOKE PASS claude cli read');
  });

  it.each([
    ['a tracked file was made executable', 'chmod +x INPUT.txt', 'changed=~INPUT.txt'],
    ['a tracked file was deleted', 'rm INPUT.txt', 'changed=-INPUT.txt'],
    ['a file over 1 MiB was created, which is recorded without being read', 'head -c 2097152 /dev/zero > big.bin', 'changed=+big.bin'],
  ])('fails read mode when %s', (_, write, detail) => {
    const client = writingClaude(write);
    const run = smoke(client.env, 'read');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`SMOKE FAIL claude cli read: exit=0 signal=null timeout=false result=completed ${detail}`);
  });

  it('still passes under that Git configuration when only OUTPUT.txt was written', () => {
    const client = writingClaude(`printf 'WRITE_OK\\n' > OUTPUT.txt`);
    const config = join(client.home, '..', 'gitconfig');
    writeFileSync(config, '[status]\n\tshowUntrackedFiles = no\n');
    const run = smoke({ ...client.env, GIT_CONFIG_GLOBAL: config });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('ccon harness-smoke', () => {
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
