import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// Doctor reads VS Code's extensions.json rather than running `code`, which on Windows is a
// batch file that Code Conductor does not run. PATH holds only node here, so no client
// or `code` is found either way. `files` maps a folder under the home folder (or an
// absolute one) to the extensions.json text to write there.
function doctor(files: Record<string, string> = {}, extraEnv: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cc-doctor-home-'));
  temps.push(home);
  for (const [folder, text] of Object.entries(files)) {
    const dir = isAbsolute(folder) ? folder : join(home, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'extensions.json'), text);
  }
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODE_CONDUCTOR_HOME: join(home, 'cc'), PATH: dirname(process.execPath) };
  delete env.VSCODE_EXTENSIONS;
  delete env.VSCODE_PORTABLE;
  delete env.VSCODE_AGENT_FOLDER;
  Object.assign(env, extraEnv);
  return { home, run: spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'doctor', repo], { encoding: 'utf8', timeout: 60_000, env }) };
}
const list = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ identifier: { id }, version: '1.0.0' })));

describe('ccon doctor: VS Code extensions', () => {
  it('lists the known extensions from extensions.json, whatever the case of their IDs', () => {
    const { run } = doctor({ '.vscode/extensions': JSON.stringify([{ identifier: { id: 'Anthropic.claude-code' }, version: '2.0.0' }, { identifier: { id: 'github.copilot' } }, null, { other: true }]) });
    expect(run.stdout).toContain('OK vscode-extension claude: anthropic.claude-code');
    expect(run.stdout).toContain('OK vscode-extension github-copilot: github.copilot');
    expect(run.stdout).toContain('INFO vscode-extension codex: openai.chatgpt');
    expect(run.stdout).not.toMatch(/inventory unavailable|could not read/);
  });

  it('joins every folder VS Code uses: local, remote hosts, Codespaces, VSCODE_EXTENSIONS, VSCODE_PORTABLE and VSCODE_AGENT_FOLDER', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-doctor-dirs-'));
    temps.push(outside);
    const { run } = doctor({
      '.vscode/extensions': list('anthropic.claude-code'),
      '.vscode-server/extensions': list('openai.chatgpt'),
      '.vscode-remote/extensions': list('github.copilot'),
      [join(outside, 'custom')]: list('github.copilot-chat'),
      [join(outside, 'portable', 'extensions')]: list('github.vscode-pull-request-github'),
    }, { VSCODE_EXTENSIONS: join(outside, 'custom'), VSCODE_PORTABLE: join(outside, 'portable') });
    for (const name of ['claude', 'codex', 'github-copilot', 'github-copilot-chat', 'github-pr']) expect(run.stdout).toMatch(new RegExp(`OK vscode-extension ${name}:`));
    // The VS Code server's own data folder, when it is set.
    const agent = doctor({ [join(outside, 'agent', 'extensions')]: list('anthropic.claude-code') }, { VSCODE_AGENT_FOLDER: join(outside, 'agent') });
    expect(agent.run.stdout).toContain('OK vscode-extension claude: anthropic.claude-code');
  });

  it('reads an empty extensions.json as no extensions, as VS Code does', () => {
    const { run } = doctor({ '.vscode/extensions': '' });
    expect(run.stdout).toContain('INFO vscode-extension claude: anthropic.claude-code');
    expect(run.stdout).not.toMatch(/inventory unavailable|could not read/);
  });

  it('warns, naming the file, when one exists but cannot be read', () => {
    const big = list(...Array.from({ length: 30000 }, (_, i) => `publisher.extension-${i}`));
    expect(big.length).toBeGreaterThan(1048576);
    for (const text of [JSON.stringify({ not: 'a list' }), '{ not json', big]) {
      const { run } = doctor({ '.vscode/extensions': text });
      expect(run.stdout).toContain(`WARN vscode-extension inventory: could not read ${join('~', '.vscode', 'extensions', 'extensions.json')} (over 1 MiB, a symlink, or not a JSON list).`);
      expect(run.stdout).not.toMatch(/(OK|INFO) vscode-extension claude:/);
    }
    // Only a path inside the home folder is shortened to ~, not a sibling whose name starts the same.
    const home = mkdtempSync(join(tmpdir(), 'cc-doctor-own-home-'));
    temps.push(home, `${home}-other`);
    mkdirSync(join(`${home}-other`, 'ext'), { recursive: true });
    writeFileSync(join(`${home}-other`, 'ext', 'extensions.json'), '{ not json');
    const { run } = doctor({}, { HOME: home, USERPROFILE: home, VSCODE_EXTENSIONS: join(`${home}-other`, 'ext') });
    expect(run.stdout).toContain(`could not read ${join(`${home}-other`, 'ext', 'extensions.json')} (over 1 MiB`);
  });

  it('says the inventory is unavailable when VS Code has recorded none, naming where it looked', () => {
    const { run } = doctor();
    expect(run.stdout).toContain('INFO vscode-extension inventory unavailable: no extensions.json in ~/.vscode/extensions, ~/.vscode-insiders/extensions, ~/.vscode-server/extensions, ~/.vscode-server-insiders/extensions, ~/.vscode-remote/extensions, VSCODE_EXTENSIONS, VSCODE_PORTABLE or VSCODE_AGENT_FOLDER.');
  });
});
