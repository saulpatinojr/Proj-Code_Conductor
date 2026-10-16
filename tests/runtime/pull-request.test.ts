import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';
import { WorktreeManager } from '../../packages/git/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { createTask, githubRepository, openDraftPullRequest, planPullRequest, type GitHubCliRunner } from '../../packages/runtime/src/index.js';
import type { RunManifest } from '../../packages/schemas/src/index.js';
import { git } from './fixtures.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const commit = (cwd: string, message: string): void => { git(cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', message); };

// A repository whose origin is a GitHub URL, with pushes rewritten to a local bare
// repository, and one agent worktree recorded by a completed run.
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
  git(repo, 'config', `url.${remote}.pushInsteadOf`, 'https://github.com/octo/widgets.git');
  const handle = new WorktreeManager(join(temp, 'worktrees')).create(repo, 'T-1', 'builder');
  change(handle.path);
  const task = createTask('Add the widget feature', 'R1', repo);
  const manifest: RunManifest = {
    runId: 'run-1', task, assignments: [], gates: [],
    results: [{ taskId: task.id, assignmentId: 'A1', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', status: 'completed', changes: ['feature.txt'], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'review' }],
    worktrees: [{ assignmentId: 'A1', path: handle.path, branch: handle.branch, baseSha: handle.baseSha }],
    mergeDecision: { decision: 'ready', rationale: 'Gates passed.', evidenceIds: [] },
  };
  return { temp, remote, repo, handle, manifest, store: new RunStore(join(temp, 'runs')) };
}

function fakeGh(calls: string[][] = [], bodies: string[] = []): GitHubCliRunner {
  return (_cwd, args) => {
    calls.push(args);
    const file = args[args.indexOf('--body-file') + 1];
    if (file) bodies.push(readFileSync(file, 'utf8'));
    return { ok: true, status: 0, stdout: 'https://github.com/octo/widgets/pull/7\n', stderr: '' };
  };
}
const approve: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };
const deny: Approver = { decide: async () => ({ approved: false, approver: 'test' }) };
const remoteHas = (remote: string, branch: string): string => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);

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
    expect(plan).toMatchObject({ assignmentId: 'A1', branch: handle.branch, head: git(handle.path, 'rev-parse', 'HEAD'), repository: 'github.com/octo/widgets', base: 'main', files: ['feature.txt'], refusals: [] });
    expect(plan.commits).toHaveLength(1);
    expect(plan.pushUrl).toBe(remote);
    expect(plan.body).toContain('`run-1`');
    expect(plan.body).toContain('Merging remains a GitHub decision');
    expect(remoteHas(remote, handle.branch)).toBe('');
  });

  it('pushes the approved commit and opens a draft with gh, without running hooks', async () => {
    const { manifest, handle, remote, repo, store } = fixture();
    const marker = join(repo, '..', 'pre-push-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    const calls: string[][] = [];
    const bodies: string[] = [];
    const outcome = await openDraftPullRequest(manifest, {}, { gh: fakeGh(calls, bodies), approver: approve, store });
    expect(outcome).toMatchObject({ status: 'created', url: 'https://github.com/octo/widgets/pull/7' });
    expect(remoteHas(remote, handle.branch)).toBe(git(handle.path, 'rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['pr', 'create', '--draft', '--repo', 'github.com/octo/widgets', '--base', 'main', '--head', handle.branch]));
    expect(bodies[0]).toContain('Add the widget feature');
    expect(outcome.approvals).toMatchObject([{ action: 'context_disclosure', status: 'approved', recipient: 'github:github.com/octo/widgets' }]);
    const events = readFileSync(join(store.runDirectory('run-1'), 'events.jsonl'), 'utf8');
    expect(events).toContain('pull_request.created');
  });

  it('pushes and opens nothing when the person declines', async () => {
    const { manifest, handle, remote } = fixture();
    const calls: string[][] = [];
    const outcome = await openDraftPullRequest(manifest, {}, { gh: fakeGh(calls), approver: deny });
    expect(outcome.status).toBe('refused');
    expect(outcome.approvals[0]?.status).toBe('denied');
    expect(remoteHas(remote, handle.branch)).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the branch moves while approval is pending', async () => {
    const { manifest, handle, remote } = fixture();
    const moving: Approver = { decide: async () => { writeFileSync(join(handle.path, 'late.txt'), 'late\n'); git(handle.path, 'add', 'late.txt'); commit(handle.path, 'late'); return { approved: true, approver: 'test' }; } };
    const calls: string[][] = [];
    const outcome = await openDraftPullRequest(manifest, {}, { gh: fakeGh(calls), approver: moving });
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
    const outcome = await openDraftPullRequest(credential.manifest, {}, { gh: fakeGh(calls), approver: approve });
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
