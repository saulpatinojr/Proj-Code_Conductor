import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, type WorktreeHandle } from '../../packages/git/src/index.js';
import type { RunManifest } from '../../packages/schemas/src/index.js';

// Runs the built CLI against a private run store and real agent worktrees.
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'cc-worktrees-cli-'));
  temps.push(home);
  const repo = join(home, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture');
  const manager = new WorktreeManager(join(home, 'worktrees'));
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'worktrees', ...args], { encoding: 'utf8', env: { ...process.env, CODE_CONDUCTOR_HOME: home } });
  const store = (runId: string, handles: WorktreeHandle[], extra: Partial<RunManifest> = {}): void => {
    const manifest: RunManifest = {
      runId, gates: [], assignments: [], results: [],
      task: { id: 'T-1', objective: 'Fix it', repository: repo, acceptanceCriteria: [], risk: 'R1', constraints: [], createdAt: '2026-10-16T00:00:00Z' },
      worktrees: handles.map((handle) => ({ assignmentId: 'A-1', path: handle.path, branch: handle.branch, baseSha: handle.baseSha })),
      mergeDecision: { decision: 'human_required', rationale: 'test', evidenceIds: [] },
      ...extra,
    };
    mkdirSync(join(home, 'runs', runId), { recursive: true });
    writeFileSync(join(home, 'runs', runId, 'manifest.json'), JSON.stringify(manifest));
  };
  return { home, repo, manager, cli, store };
}

describe('ccon worktrees', () => {
  it('lists clean and dirty worktrees by content and removes only clean ones, keeping branches', () => {
    const { repo, manager, cli, store } = setup();
    const clean = manager.create(repo, 'T-1', 'clean');
    const dirty = manager.create(repo, 'T-1', 'dirty');
    writeFileSync(join(dirty.path, 'wip.txt'), 'not committed\n');
    store('RUN-1', [clean, dirty]);
    const listed = cli();
    expect(listed.stdout).toMatch(new RegExp(`^CLEAN .*${clean.branch}`, 'm'));
    expect(listed.stdout).toMatch(new RegExp(`^KEEP .*${dirty.branch}.*uncommitted changes`, 'm'));
    const removed = cli('--remove-clean');
    expect(removed.status).toBe(0);
    expect(removed.stdout).toMatch(/^REMOVED /m);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    expect(git(repo, 'branch', '--list', clean.branch)).toContain(clean.branch);
  });

  it('runs no Git in worktrees of a run stopped for a Git configuration change', () => {
    const { home, repo, manager, cli, store } = setup();
    const handle = manager.create(repo, 'T-1', 'builder');
    const marker = join(home, 'filter-ran');
    git(handle.path, 'config', 'filter.agent.clean', `touch '${marker}'; cat`);
    writeFileSync(join(handle.path, '.gitattributes'), '* filter=agent\n');
    const blocker = 'Git configuration or history files (config of any scope) for the worktree changed since Code Conductor first read them in this run.';
    store('RUN-STOPPED', [handle], { results: [{ taskId: 'T-1', assignmentId: 'A-1', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', status: 'blocked', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [blocker], recommendation: 'human_required' }] });
    for (const args of [[], ['--remove-clean']]) {
      const result = cli(...args);
      expect(result.stdout).toMatch(/^INSPECT .*config --list --show-origin/m);
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(handle.path)).toBe(true);
  });

  it('leaves runs without an outcome alone and ignores records outside the worktree root', () => {
    const { home, repo, manager, cli, store } = setup();
    const active = manager.create(repo, 'T-1', 'active');
    store('RUN-ACTIVE', [active], { mergeDecision: undefined });
    const outside = new WorktreeManager(join(home, 'elsewhere')).create(repo, 'T-2', 'outside');
    store('RUN-OUTSIDE', [outside]);
    const result = cli('--remove-clean');
    expect(result.stdout).toMatch(/^ACTIVE .*no outcome/m);
    expect(result.stdout).not.toContain(outside.path);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(outside.path)).toBe(true);
  });
});
