import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// Doctor reads VS Code's extensions.json rather than running `code`, which on Windows is a
// batch file that Code Conductor does not run. PATH holds only node here, so no client
// or `code` is found either way.
function doctor(extensions?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'cc-doctor-home-'));
  temps.push(home);
  if (extensions !== undefined) {
    mkdirSync(join(home, '.vscode', 'extensions'), { recursive: true });
    writeFileSync(join(home, '.vscode', 'extensions', 'extensions.json'), JSON.stringify(extensions));
  }
  const repo = join(home, 'repo');
  mkdirSync(repo);
  return spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'doctor', repo], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODE_CONDUCTOR_HOME: join(home, 'cc'), PATH: dirname(process.execPath) },
  });
}

describe('ccon doctor: VS Code extensions', () => {
  it('lists the known extensions from extensions.json, whatever the case of their IDs', () => {
    const run = doctor([{ identifier: { id: 'Anthropic.claude-code' }, version: '2.0.0' }, { identifier: { id: 'github.copilot' } }, null, { other: true }]);
    expect(run.stdout).toContain('OK vscode-extension claude: anthropic.claude-code');
    expect(run.stdout).toContain('OK vscode-extension github-copilot: github.copilot');
    expect(run.stdout).toContain('INFO vscode-extension codex: openai.chatgpt');
    expect(run.stdout).not.toContain('inventory unavailable');
  });

  it('says the inventory is unavailable when VS Code has recorded none', () => {
    for (const run of [doctor(), doctor({ not: 'a list' })]) {
      expect(run.stdout).toContain('INFO vscode-extension inventory unavailable: no VS Code extensions.json');
      expect(run.stdout).not.toMatch(/(OK|INFO) vscode-extension claude:/);
    }
  });
});
