import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';
import { pushCommit, WorktreeManager } from '../../packages/git/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { createTask, githubRepository, openDraftPullRequest, planPullRequest, pullRequestUrl, type CommitPusher, type GitHubCliRunner, type PullRequestOptions } from '../../packages/runtime/src/index.js';
import type { RunManifest } from '../../packages/schemas/src/index.js';
import { git } from './fixtures.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const commit = (cwd: string, message: string): void => { git(cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', message); };

// A repository whose origin is a GitHub URL and whose base is on origin, and one agent
// worktree recorded by a completed run. Tests never reach GitHub: the injected pusher
// sends the approved push to a local bare repository instead.
function fixture(change: (worktree: string) => void = (worktree) => { writeFileSync(join(worktree, 'feature.txt'), 'feature\n'); git(worktree, 'add', 'feature.txt'); commit(worktree, 'feature'); }) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-pr-test-'));
  temps.push(temp);
  const remote = join(temp, 'remote.git');
  git(temp, 'init', '-q', '--bare', remote);
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', 'README.md');
  commit(repo, 'base');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git');
  git(repo, 'push', '-q', remote, 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const handle = new WorktreeManager(join(temp, 'worktrees')).create(repo, 'T-1', 'builder');
  change(handle.path);
  const task = createTask('Add the widget feature', 'R1', repo);
  const manifest: RunManifest = {
    runId: 'run-1', task, assignments: [], gates: [],
    results: [{ taskId: task.id, assignmentId: 'A1', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', status: 'completed', changes: ['feature.txt'], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'review' }],
    worktrees: [{ assignmentId: 'A1', path: handle.path, branch: handle.branch, baseSha: handle.baseSha }],
    mergeDecision: { decision: 'ready', rationale: 'Gates passed.', evidenceIds: [] },
  };
  const pushes: string[][] = [];
  const push: CommitPusher = (path, name, sha, branch) => { pushes.push([name, sha, branch]); pushCommit(path, remote, sha, branch, ['file']); };
  return { temp, remote, repo, handle, manifest, push, pushes, store: new RunStore(join(temp, 'runs')) };
}
type Fixture = ReturnType<typeof fixture>;
const open = (setup: Fixture, approver: Approver, gh: GitHubCliRunner = fakeGh(), options: PullRequestOptions = {}) => openDraftPullRequest(setup.manifest, options, { gh, push: setup.push, approver, store: setup.store });

function fakeGh(calls: string[][] = [], bodies: string[] = [], directories: string[] = [], stdout = 'https://github.com/octo/widgets/pull/7\n'): GitHubCliRunner {
  return (cwd, args) => {
    calls.push(args);
    directories.push(cwd);
    const file = args[args.indexOf('--body-file') + 1];
    if (file) bodies.push(readFileSync(file, 'utf8'));
    return { ok: true, status: 0, stdout, stderr: '' };
  };
}
const approve: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };
const deny: Approver = { decide: async () => ({ approved: false, approver: 'test' }) };
const remoteHas = (remote: string, branch: string): string => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);
const events = (setup: Fixture): string => { try { return readFileSync(join(setup.store.runDirectory('run-1'), 'events.jsonl'), 'utf8'); } catch { return ''; } };
const synthetic = { github: ['ghp', '_', 'a'.repeat(36)].join(''), aws: ['AKIA', 'Q3EXAMPLEKEY12345'].join('').slice(0, 20) };

describe('draft pull requests (#35)', () => {
  it('recognizes GitHub remote URLs only', () => {
    expect(githubRepository('https://github.com/octo/widgets.git')).toBe('github.com/octo/widgets');
    expect(githubRepository('git@github.com:octo/widgets.git')).toBe('github.com/octo/widgets');
    expect(githubRepository('ssh://git@ghe.example.com/octo/widgets')).toBe('ghe.example.com/octo/widgets');
    expect(githubRepository('/srv/git/widgets.git')).toBeUndefined();
    expect(githubRepository('https://github.com/octo/widgets/extra')).toBeUndefined();
  });

  it('previews the exact push and pull request without changing anything', () => {
    const { manifest, handle, remote } = fixture();
    const plan = planPullRequest(manifest);
    expect(plan).toMatchObject({ assignmentId: 'A1', branch: handle.branch, head: git(handle.path, 'rev-parse', 'HEAD'), repository: 'github.com/octo/widgets', base: 'main', files: ['feature.txt'], refusals: [], redacted: 0 });
    expect(plan.commits).toHaveLength(1);
    expect(plan.pushUrls).toEqual(['https://github.com/octo/widgets.git']);
    expect(plan.textDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.body).toContain('`run-1`');
    expect(plan.body).toContain('Merging remains a GitHub decision');
    expect(remoteHas(remote, handle.branch)).toBe('');
  });

  it('pushes the approved commit and opens a draft with gh, without running hooks', async () => {
    const setup = fixture();
    const { handle, remote, repo } = setup;
    const marker = join(repo, '..', 'pre-push-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    const calls: string[][] = [];
    const bodies: string[] = [];
    const directories: string[] = [];
    const outcome = await open(setup, approve, fakeGh(calls, bodies, directories));
    expect(outcome).toMatchObject({ status: 'created', url: 'https://github.com/octo/widgets/pull/7' });
    expect(setup.pushes).toEqual([['origin', git(handle.path, 'rev-parse', 'HEAD'), handle.branch]]);
    expect(remoteHas(remote, handle.branch)).toBe(git(handle.path, 'rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(calls).toHaveLength(1);
    // gh never runs in the agent worktree, where a planted gh could be found first on Windows.
    expect(directories[0]).not.toBe(handle.path);
    expect(existsSync(directories[0]!)).toBe(false);
    expect(calls[0]).toEqual(expect.arrayContaining(['pr', 'create', '--draft', '--repo', 'github.com/octo/widgets', '--base', 'main', '--head', handle.branch]));
    expect(bodies[0]).toContain('Add the widget feature');
    expect(outcome.approvals).toMatchObject([{ action: 'context_disclosure', status: 'approved', recipient: 'github:github.com/octo/widgets' }]);
    expect(events(setup)).toContain('pull_request.created');
  });

  it('pushes and opens nothing when the person declines', async () => {
    const setup = fixture();
    const { handle, remote } = setup;
    const calls: string[][] = [];
    const outcome = await open(setup, deny, fakeGh(calls));
    expect(outcome.status).toBe('refused');
    expect(outcome.approvals[0]?.status).toBe('denied');
    expect(remoteHas(remote, handle.branch)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the branch moves while approval is pending', async () => {
    const setup = fixture();
    const { handle, remote } = setup;
    const moving: Approver = { decide: async () => { writeFileSync(join(handle.path, 'late.txt'), 'late\n'); git(handle.path, 'add', 'late.txt'); commit(handle.path, 'late'); return { approved: true, approver: 'test' }; } };
    const calls: string[][] = [];
    const outcome = await open(setup, moving, fakeGh(calls));
    expect(outcome.status).toBe('refused');
    expect(outcome.approvals[0]?.status).toBe('changed');
    expect(remoteHas(remote, handle.branch)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('refuses branches whose history touched a sensitive path or adds a credential', async () => {
    const secretHistory = fixture((worktree) => {
      writeFileSync(join(worktree, '.env'), 'TOKEN=x\n'); git(worktree, 'add', '-f', '.env'); commit(worktree, 'add');
      git(worktree, 'rm', '-q', '.env'); commit(worktree, 'remove');
    });
    expect(planPullRequest(secretHistory.manifest).refusals.join(' ')).toContain('sensitive repository paths: .env');
    const credential = fixture((worktree) => {
      writeFileSync(join(worktree, 'config.ts'), `export const token = 'ghp_${'a'.repeat(36)}';\n`); git(worktree, 'add', 'config.ts'); commit(worktree, 'token');
      writeFileSync(join(worktree, 'config.ts'), 'export const token = process.env.TOKEN;\n'); git(worktree, 'add', 'config.ts'); commit(worktree, 'remove token');
    });
    const calls: string[][] = [];
    const outcome = await open(credential, approve, fakeGh(calls));
    expect(outcome.status).toBe('refused');
    expect(outcome.blocker).toContain('config.ts:1 (GitHub token)');
    expect(outcome.blocker).not.toContain('ghp_');
    expect(remoteHas(credential.remote, credential.handle.branch)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('runs no Git for a run that stopped for a Git configuration change, has no outcome, or names a worktree elsewhere', () => {
    const stopped = fixture();
    const marker = join(stopped.temp, 'filter-ran');
    git(stopped.handle.path, 'config', 'filter.agent.clean', `touch '${marker}'; cat`);
    writeFileSync(join(stopped.handle.path, '.gitattributes'), '* filter=agent\n');
    stopped.manifest.results[0]!.blockers = ['Git configuration or history files (config of any scope) for the worktree changed since Code Conductor first read them in this run.'];
    expect(() => planPullRequest(stopped.manifest)).toThrow('no Git command was run');
    expect(existsSync(marker)).toBe(false);
    const active = fixture();
    delete active.manifest.mergeDecision;
    expect(() => planPullRequest(active.manifest)).toThrow('no outcome yet');
    const elsewhere = fixture();
    expect(() => planPullRequest(elsewhere.manifest, { worktreeRoot: join(elsewhere.temp, 'other-root') })).toThrow('no completed agent worktree');
    expect(planPullRequest(elsewhere.manifest, { worktreeRoot: join(elsewhere.temp, 'worktrees') }).refusals).toEqual([]);
  });

  it('refuses a branch with nothing to push and a non-GitHub remote', () => {
    const empty = fixture(() => {});
    expect(planPullRequest(empty.manifest).refusals.join(' ')).toContain('nothing to push');
    const local = fixture();
    git(local.repo, 'remote', 'set-url', 'origin', local.remote);
    expect(planPullRequest(local.manifest).refusals.join(' ')).toContain('is not a GitHub repository URL');
  });
});

describe('draft pull request destination and content (#35 review)', () => {
  it('pushes only to one push URL that names the pull request repository', () => {
    const two = fixture();
    git(two.repo, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/octo/widgets.git');
    git(two.repo, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/someone-else/widgets.git');
    expect(planPullRequest(two.manifest).refusals.join(' ')).toContain('pushes to 2 URLs (https://github.com/octo/widgets.git, https://github.com/someone-else/widgets.git)');
    const urls = fixture();
    git(urls.repo, 'config', '--add', 'remote.origin.url', 'https://github.com/octo/mirror.git');
    expect(planPullRequest(urls.manifest).refusals.join(' ')).toContain('pushes to 2 URLs');
    for (const elsewhere of ['https://github.com/someone-else/widgets.git', 'https://gitlab.example.com/octo/widgets.git', '/srv/elsewhere.git']) {
      const setup = fixture();
      git(setup.repo, 'config', 'remote.origin.pushurl', elsewhere);
      expect(planPullRequest(setup.manifest).refusals.join(' '), elsewhere).toContain('which is not github.com/octo/widgets');
    }
    // Same repository in another form (SSH, other letter case) is the same destination.
    const ssh = fixture();
    git(ssh.repo, 'config', 'remote.origin.pushurl', 'git@github.com:Octo/Widgets.git');
    expect(planPullRequest(ssh.manifest).refusals).toEqual([]);
  });

  it('refuses when a push URL is added while approval is pending', async () => {
    const setup = fixture();
    const adding: Approver = { decide: async () => { git(setup.repo, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/octo/widgets.git'); git(setup.repo, 'config', '--add', 'remote.origin.pushurl', '/srv/second.git'); return { approved: true, approver: 'test' }; } };
    const calls: string[][] = [];
    const outcome = await open(setup, adding, fakeGh(calls));
    expect(outcome.status).toBe('refused');
    expect(outcome.approvals[0]?.status).toBe('changed');
    expect(setup.pushes).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('checks the push URL once more right before pushing', async () => {
    const setup = fixture();
    // The approval is recorded after the rebuilt request matched; change the remote just then.
    const store = { appendEvent: (event: { type: string }) => { if (event.type === 'approval.decided') git(setup.repo, 'config', 'remote.origin.pushurl', 'https://github.com/octo/widgets-fork.git'); return ''; } } as unknown as RunStore;
    const outcome = await openDraftPullRequest(setup.manifest, {}, { gh: fakeGh(), push: setup.push, approver: approve, store });
    expect(outcome.status).toBe('refused');
    expect(outcome.blocker).toContain('push URLs of origin changed after approval');
    expect(setup.pushes).toEqual([]);
  });

  it('refuses when the base is not on the remote, so unlisted commits would be published', () => {
    const setup = fixture();
    git(setup.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(planPullRequest(setup.manifest).refusals.join(' ')).toContain(`Base ${setup.handle.baseSha.slice(0, 12)} is not on any origin branch`);
  });

  it('never runs a nested repository\'s programs, for the preview or the push', async () => {
    const setup = fixture((worktree) => {
      git(worktree, 'init', '-q', 'vendor-lib');
      writeFileSync(join(worktree, 'vendor-lib', 'lib.txt'), 'lib\n');
      git(join(worktree, 'vendor-lib'), 'add', 'lib.txt');
      commit(join(worktree, 'vendor-lib'), 'lib');
      git(worktree, 'add', 'vendor-lib');
      commit(worktree, 'gitlink');
    });
    const nested = join(setup.handle.path, 'vendor-lib');
    const marker = join(setup.temp, 'nested-filter-ran');
    git(nested, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
    mkdirSync(join(nested, '.git', 'info'), { recursive: true });
    writeFileSync(join(nested, '.git', 'info', 'attributes'), '* filter=x\n');
    // Same size, new time: Git can only tell by re-reading the file through the filter.
    const touch = (): void => { const later = new Date(Date.now() + 5000); utimesSync(join(nested, 'lib.txt'), later, later); };
    touch();
    expect(planPullRequest(setup.manifest).refusals).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    touch();
    expect((await open(setup, approve)).status).toBe('created');
    expect(existsSync(marker)).toBe(false);
  });

  it('pushes the branch and nothing else, even with push.followTags', async () => {
    const setup = fixture();
    git(setup.repo, 'config', 'push.followTags', 'true');
    git(setup.handle.path, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'tag', '-a', 'v9.9.9-agent', '-m', `release ${synthetic.github}`);
    expect((await open(setup, approve)).status).toBe('created');
    expect(git(setup.remote, 'for-each-ref', '--format=%(refname)')).toBe(['refs/heads/cc/T-1/builder', 'refs/heads/main'].sort().join('\n'));
  });

  it('redacts credential-looking strings agents reported from the published text, and makes agent text inert', () => {
    const setup = fixture();
    const result = setup.manifest.results[0]!;
    result.risks = [`token ${synthetic.github} was used`, 'Closes #1 @octocat ![x](https://example.invalid/x.png)'];
    result.notVerified = [`key ${synthetic.aws}`];
    result.agentId = 'builder | injected';
    const plan = planPullRequest(setup.manifest);
    expect(plan.redacted).toBe(2);
    expect(plan.body).not.toContain(synthetic.github);
    expect(plan.body).not.toContain(synthetic.aws);
    expect(plan.body).toContain('[redacted GitHub token]');
    expect(plan.body).toContain('` Closes #1 @octocat ![x](https://example.invalid/x.png) `');
    expect(plan.body).toContain('` builder \\| injected (openai/codex) `');
  });

  it('redacts before shortening a long body, so a credential cut in two is still removed', () => {
    const setup = fixture();
    setup.manifest.results[0]!.risks = ['MARKER'];
    const offset = planPullRequest(setup.manifest).body.indexOf('MARKER');
    setup.manifest.results[0]!.risks = [`${'x'.repeat(60_000 - offset - 11)} ${synthetic.github}`];
    const plan = planPullRequest(setup.manifest);
    expect(plan.body).toContain('[Truncated;');
    expect(plan.body).not.toContain('ghp_');
    expect(plan.redacted).toBe(1);
  });

  it('refuses a credential-looking file name, without repeating it', async () => {
    const setup = fixture((worktree) => { writeFileSync(join(worktree, `${synthetic.github}.txt`), 'x\n'); git(worktree, 'add', '.'); commit(worktree, 'named'); });
    const refusals = planPullRequest(setup.manifest).refusals.join(' ');
    expect(refusals).toContain('[redacted GitHub token].txt:0 (GitHub token in its name)');
    expect(refusals).not.toContain(synthetic.github);
  });

  it('opens a pull request only for a completed assignment', () => {
    const setup = fixture();
    setup.manifest.results[0]!.status = 'blocked';
    expect(() => planPullRequest(setup.manifest, { assignmentId: 'A1' })).toThrow('is blocked, not completed');
    setup.manifest.results = [];
    expect(() => planPullRequest(setup.manifest, { assignmentId: 'A1' })).toThrow('is without a result, not completed');
  });

  it('accepts only a pull request URL in the approved repository from gh, and records failures', async () => {
    expect(pullRequestUrl('Creating draft…\nhttps://github.com/Octo/Widgets/pull/12\n', 'github.com/octo/widgets')).toBe('https://github.com/Octo/Widgets/pull/12');
    for (const printed of ['https://evil.example/octo/widgets/pull/1', 'https://github.com/octo/other/pull/1', 'http://github.com/octo/widgets/pull/1', 'https://github.com/octo/widgets/pull/1?x=1', 'https://github.com/octo/widgets/issues/1', '\u001b]8;;https://github.com/octo/widgets/pull/1\u0007']) {
      expect(pullRequestUrl(printed, 'github.com/octo/widgets'), printed).toBeUndefined();
    }
    const odd = fixture();
    const outcome = await open(odd, approve, fakeGh([], [], [], 'https://evil.example/pull/1\u001b[2J\n'));
    expect(outcome).toMatchObject({ status: 'refused' });
    expect(outcome.blocker).toContain('printed no pull request URL in github.com/octo/widgets');
    expect(events(odd)).toContain('pull_request.unconfirmed');
    expect(events(odd)).not.toContain('\\u001b');
    const failing = fixture();
    const failed = await open(failing, approve, () => ({ ok: false, status: 1, stdout: '', stderr: 'boom' }));
    expect(failed.blocker).toContain('gh could not open the draft pull request: boom');
    expect(events(failing)).toContain('pull_request.failed');
    const rejected = fixture();
    // The remote already has the agent branch with other history, so the push is not a fast-forward.
    git(rejected.remote, 'update-ref', `refs/heads/${rejected.handle.branch}`, git(rejected.remote, '-c', 'user.name=other', '-c', 'user.email=other@example.invalid', 'commit-tree', '-m', 'other', `${git(rejected.repo, 'rev-parse', 'HEAD')}^{tree}`));
    const refusedPush = await open(rejected, approve);
    expect(refusedPush.blocker).toContain('Push was refused');
    expect(events(rejected)).toContain('branch.push_refused');
  });
});
