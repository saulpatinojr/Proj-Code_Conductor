import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAgentChanges, DISABLED_HOOKS_PATH, workingTreeState, WorktreeManager } from '../../packages/git/src/index.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'cc-tree-state-'));
  temps.push(path);
  git(path, 'init', '-q');
  // Containers often run with these; the binding must not depend on them.
  git(path, 'config', 'core.checkStat', 'minimal');
  git(path, 'config', 'core.trustctime', 'false');
  writeFileSync(join(path, 'tracked.txt'), 'aaaa\n');
  // Back-date the file so its index entry is not "racily clean" and Git trusts stat data.
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(path, 'tracked.txt'), past, past);
  git(path, 'add', 'tracked.txt');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture');
  return path;
}

describe('workingTreeState', () => {
  it('reports HEAD and the committed tree for a clean checkout without touching the index', () => {
    const path = repository();
    const index = statSync(join(path, '.git', 'index')).mtimeMs;
    expect(workingTreeState(path)).toEqual({ revision: git(path, 'rev-parse', 'HEAD'), tree: git(path, 'rev-parse', 'HEAD^{tree}') });
    expect(statSync(join(path, '.git', 'index')).mtimeMs).toBe(index);
    expect(git(path, 'status', '--porcelain')).toBe('');
  });

  it('detects untracked files and same-size edits that preserve mtime', () => {
    const path = repository();
    const clean = workingTreeState(path).tree;
    const file = join(path, 'tracked.txt');
    const { atime, mtime } = statSync(file);
    writeFileSync(file, 'bbbb\n');
    utimesSync(file, atime, mtime);
    const edited = workingTreeState(path).tree;
    expect(edited).not.toBe(clean);
    writeFileSync(join(path, 'new.txt'), 'new\n');
    expect(workingTreeState(path).tree).not.toBe(edited);
    // The real index still only knows the original commit.
    expect(git(path, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('keeps tracked files that match .gitignore, matching what a real commit stages', () => {
    const path = repository();
    writeFileSync(join(path, '.gitignore'), 'generated.txt\n');
    writeFileSync(join(path, 'generated.txt'), 'v1\n');
    git(path, 'add', '-f', '.gitignore', 'generated.txt');
    git(path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'tracked but ignored');
    expect(workingTreeState(path).tree).toBe(git(path, 'rev-parse', 'HEAD^{tree}'));
    writeFileSync(join(path, 'generated.txt'), 'v2\n');
    const edited = workingTreeState(path).tree;
    git(path, 'add', '--all');
    expect(edited).toBe(git(path, 'write-tree'));
  });

  it('reports unversioned paths without binding content', () => {
    const path = mkdtempSync(join(tmpdir(), 'cc-tree-state-plain-'));
    temps.push(path);
    expect(workingTreeState(path)).toEqual({ revision: 'unversioned', tree: 'unversioned' });
  });

  it('never points git at a hooks path another process could create', () => {
    if (process.platform !== 'win32') expect(DISABLED_HOOKS_PATH).toBe('/dev/null');
  });
});

describe('approved agent commits', () => {
  function agentWorktree() {
    const repo = repository();
    const manager = new WorktreeManager(join(repo, '..', `${repo.split('/').at(-1)}-worktrees`));
    temps.push(manager.root);
    return manager.create(repo, 'T-1', 'builder-test');
  }

  it('commits exactly the approved tree without staging and leaves a clean index', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'agent.txt'), 'change\n');
    const approved = workingTreeState(handle.path).tree;
    const commit = commitAgentChanges(handle, 'feat(agent): test', { expectedTree: approved });
    expect(commit).toMatchObject({ created: true, files: ['agent.txt'] });
    expect(git(handle.path, 'rev-parse', 'HEAD^{tree}')).toBe(approved);
    expect(git(handle.path, 'rev-parse', 'HEAD^')).toBe(handle.baseSha);
    expect(git(handle.path, 'status', '--porcelain')).toBe('');
  });

  it('refuses when the worktree no longer matches the approved tree', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'agent.txt'), 'change\n');
    const approved = workingTreeState(handle.path).tree;
    writeFileSync(join(handle.path, 'agent.txt'), 'other\n');
    expect(() => commitAgentChanges(handle, 'feat(agent): test', { expectedTree: approved })).toThrow('changed after commit approval');
    expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(handle.baseSha);
    expect(git(handle.path, 'status', '--porcelain')).toContain('agent.txt');
  });

  it('refuses sensitive paths in the approved tree', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, '.env'), 'TOKEN=x\n');
    git(handle.path, 'add', '-f', '.env');
    const approved = workingTreeState(handle.path).tree;
    expect(() => commitAgentChanges(handle, 'feat(agent): test', { expectedTree: approved })).toThrow('Sensitive repository paths');
  });
});
