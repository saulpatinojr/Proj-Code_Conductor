import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// A fake Claude Code whose --version answer is read from a file the test controls, so
// the client can be "upgraded" in the middle of a smoke test.
function fakeClaude(): { root: string; env: NodeJS.ProcessEnv; setVersion: (version: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'cc-smoke-cli-'));
  temps.push(root);
  const versionFile = join(root, 'version');
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'READ_OK\nCC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"ready"}' });
  writeFileSync(join(root, 'claude'), [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then cat '${versionFile}'; exit 0; fi`,
    'if [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
    // The run itself: the client is upgraded while the smoke test is running.
    `echo '2.0.0 (Claude Code)' > '${versionFile}'`,
    `cat <<'JSON'\n${result}\nJSON`,
  ].join('\n'));
  chmodSync(join(root, 'claude'), 0o755);
  return {
    root,
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
});
