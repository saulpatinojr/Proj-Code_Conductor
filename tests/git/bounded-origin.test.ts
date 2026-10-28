import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn() }));
let githubOriginRepository: typeof import('../../packages/git/src/index.js').githubOriginRepository;
const spawn = vi.mocked(spawnSync);
beforeEach(async () => {
  spawn.mockReset();
  vi.resetModules();
  ({ githubOriginRepository } = await import('../../packages/git/src/index.js'));
});
describe('bounded GitHub origin navigation identity', () => {
  it('retains safe Git flags and absolute executable while bounding time and output', () => {
    spawn.mockReturnValue({ status: 0, stdout: 'https://github.com/Owner/Repo.git\n', stderr: '', signal: null } as never);
    expect(githubOriginRepository('/repository')).toBe('owner/repo');
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(isAbsolute(String(command))).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['--no-replace-objects', 'core.fsmonitor=false', 'remote', 'get-url', '--', 'origin']));
    expect(options).toMatchObject({ timeout: 2000, maxBuffer: 4096, shell: false, killSignal: 'SIGKILL' });
  });
  it('fails closed for timeout, output error or unsupported remote identities', () => {
    spawn.mockReturnValue({ status: null, stdout: '', error: new Error('timeout') } as never);
    expect(githubOriginRepository('/repository')).toBeUndefined();
    spawn.mockReturnValue({ status: 0, stdout: 'https://github.com/owner/repo.git', error: new Error('output overflow') } as never);
    expect(githubOriginRepository('/repository')).toBeUndefined();
    spawn.mockReturnValue({ status: 0, stdout: 'https://other.invalid/owner/repo.git', signal: null } as never);
    expect(githubOriginRepository('/repository')).toBeUndefined();
  });
});
