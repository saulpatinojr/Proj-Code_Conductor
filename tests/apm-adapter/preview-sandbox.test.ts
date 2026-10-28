import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
vi.mock('@code-conductor/core/processes', async (original) => ({ ...await original<typeof import('@code-conductor/core/processes')>(), resolveExecutable: vi.fn((name: string) => ({ path: `/tools/${name}` })), runIsolated: vi.fn() }));
import { runIsolated } from '@code-conductor/core/processes';
import { PREVIEW_PACKS, previewPacks } from '../../packages/apm-adapter/src/projection-preview.js';
const run = vi.mocked(runIsolated);
const roots: string[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const result = (stdout = '') => ({ status: 0, stdout, stderr: '', timedOut: false, truncated: false, sha256: sha(stdout) });
let repository: string; let home: string;
beforeEach(() => {
  const temp = mkdtempSync(join(tmpdir(), 'cc-sandbox-')); roots.push(temp);
  repository = join(temp, 'repository'); home = join(temp, 'private'); mkdirSync(repository);
  vi.stubEnv('CODE_CONDUCTOR_HOME', home); vi.stubEnv('OPENAI_API_KEY', 'must-not-propagate'); vi.stubEnv('GIT_CONFIG_COUNT', '99'); vi.stubEnv('APM_NO_SCRIPTS', '');
  run.mockReset();
  run.mockImplementation(async (_binary, args, options) => {
    const tail = args.slice(args.indexOf('--') + 2);
    if (tail[0] === '--version') return result('APM 0.33.0');
    if (tail[0] === 'install') {
      const stage = options.cwd; const path = '.codex/agents/test.toml'; const text = 'name = "test"';
      mkdirSync(join(stage, '.codex/agents'), { recursive: true }); writeFileSync(join(stage, path), text);
      writeFileSync(join(stage, 'apm.lock.yaml'), stringify({ lockfile_version: '1', apm_version: '0.33.0', dependencies: [{ virtual_path: PREVIEW_PACKS[0], host: 'github.com', repo_url: 'hybridcloudworks/proj-agentpacks', materialization_repo_url: 'hybridcloudworks/Proj-AgentPacks', resolved_commit: '16f41836d65cbf79070ecdb2ef835c78c57b6ae6', deployed_files: [path], deployed_file_hashes: { [path]: 'sha256:' + sha(text) } }] }));
    }
    return result('native evidence');
  });
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe.skipIf(process.platform !== 'linux')('explicit native preview sandbox', () => {
  it('downloads only fixed pins with denied scripts/executables, hidden home and read-only host mounts', async () => {
    const preview = await previewPacks(repository, [PREVIEW_PACKS[0]]);
    expect(preview.audit).toMatchObject({ status: 0, outputSha256: sha('native evidence') });
    expect(preview.digest).toBe(sha(JSON.stringify({ ...preview, digest: undefined })));
    expect(preview.changes[0]?.operation).toBe('add');
    expect(run).toHaveBeenCalledTimes(3);
    const [binary, args, options] = run.mock.calls[1]!;
    expect(binary).toBe('/tools/bwrap');
    expect(args.slice(-8)).toEqual(['--', '/tools/apm', 'install', '--only', 'apm', '--no-trust-bin', '--target', 'codex']);
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', '--tmpfs', '--bind', '--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session']));
    expect(options.env).toMatchObject({ APM_NO_SCRIPTS: '1', APM_NON_INTERACTIVE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY'); expect(options.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(options.env?.TMPDIR).not.toContain(options.cwd);
    expect(existsSync(options.cwd)).toBe(false);
    expect(readdirSync(join(home, 'tmp'))).toEqual([]); expect(readdirSync(repository)).toEqual([]);
  });
  it.each(['version', 'install', 'audit'])('fails closed after %s failure and removes private staging', async (phase) => {
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (binary, args, options) => {
      const tail = args.slice(args.indexOf('--') + 2);
      if ((phase === 'version' && tail[0] === '--version') || tail[0] === phase) return { ...result(), status: 1 };
      return original(binary, args, options);
    });
    await expect(previewPacks(repository, [PREVIEW_PACKS[0]])).rejects.toThrow();
    expect(readdirSync(join(home, 'tmp'))).toEqual([]); expect(readdirSync(repository)).toEqual([]);
  });
  it.each([{ timedOut: true }, { truncated: true }, { status: null }])('refuses nominally successful but incomplete command outcomes %j', async (failure) => {
    run.mockResolvedValue({ ...result('APM 0.33.0'), ...failure });
    await expect(previewPacks(repository, [PREVIEW_PACKS[0]])).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1); expect(readdirSync(join(home, 'tmp'))).toEqual([]);
  });
  it('rejects unsupported/duplicate catalog selections before starting a process', async () => {
    for (const selected of [[], ['arbitrary/url#main'], [PREVIEW_PACKS[0], PREVIEW_PACKS[0]]]) await expect(previewPacks(repository, selected as any)).rejects.toThrow(/Select/);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['private', '..private'])('rejects staging under the selected repository (%s) before creating anything', async (name) => {
    vi.stubEnv('CODE_CONDUCTOR_HOME', join(repository, name));
    await expect(previewPacks(repository, [PREVIEW_PACKS[0]])).rejects.toThrow(/outside/);
    expect(run).not.toHaveBeenCalled(); expect(readdirSync(repository)).toEqual([]);
  });
  it('rejects symlinked staging ancestry into the selected repository without creating anything', async () => {
    const link = join(home, '..', 'alias'); symlinkSync(repository, link); vi.stubEnv('CODE_CONDUCTOR_HOME', join(link, 'private'));
    await expect(previewPacks(repository, [PREVIEW_PACKS[0]])).rejects.toThrow(/outside/);
    expect(run).not.toHaveBeenCalled(); expect(readdirSync(repository)).toEqual([]);
  });
});
