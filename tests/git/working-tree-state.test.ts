import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAgentChanges, commitsSince, DISABLED_HOOKS_PATH, gitControlState, treeChangedFiles, workingTreeState, WorktreeManager } from '../../packages/git/src/index.js';

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

  it('refuses without an approved tree and when the branch moved after approval', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'agent.txt'), 'change\n');
    expect(() => commitAgentChanges(handle, 'x', undefined as never)).toThrow('without an approved tree');
    expect(() => commitAgentChanges(handle, 'x', { expectedTree: '' })).toThrow('without an approved tree');
    const approved = workingTreeState(handle.path);
    git(handle.path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'concurrent');
    expect(() => commitAgentChanges(handle, 'x', { expectedTree: approved.tree, expectedHead: approved.revision })).toThrow('moved from the approved');
  });

  it('keeps sparse-checkout (skip-worktree) paths out of the change set', () => {
    const handle = agentWorktree();
    git(handle.path, 'update-index', '--skip-worktree', 'tracked.txt');
    rmSync(join(handle.path, 'tracked.txt'));
    expect(workingTreeState(handle.path).tree).toBe(git(handle.path, 'rev-parse', 'HEAD^{tree}'));
  });

  it('still hashes a skip-worktree file that is present on disk, so the index bit cannot hide an edit', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'tracked.txt'), 'edited behind skip-worktree\n');
    git(handle.path, 'update-index', '--skip-worktree', 'tracked.txt');
    expect(git(handle.path, 'status', '--porcelain')).toBe('');
    const state = workingTreeState(handle.path);
    expect(treeChangedFiles(handle.path, handle.baseSha, state.tree)).toEqual(['tracked.txt']);
  });

  it('ignores a skip-worktree entry that is not in HEAD instead of failing', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'staged.txt'), 'index only\n');
    git(handle.path, 'add', 'staged.txt');
    git(handle.path, 'update-index', '--skip-worktree', 'staged.txt');
    rmSync(join(handle.path, 'staged.txt'));
    expect(workingTreeState(handle.path).tree).toBe(git(handle.path, 'rev-parse', 'HEAD^{tree}'));
  });

  it('lists and commits the real tree even when a replace ref substitutes it', () => {
    const handle = agentWorktree();
    mkdirSync(join(handle.path, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(handle.path, '.github', 'workflows', 'exfil.yml'), 'on: push\n');
    writeFileSync(join(handle.path, '.env'), 'TOKEN=secret\n');
    writeFileSync(join(handle.path, 'feature.txt'), 'harmless\n');
    const approved = workingTreeState(handle.path).tree;
    // The agent plants refs/replace/<real tree> -> a tree holding only the harmless file.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: handle.path, input: 'harmless\n', encoding: 'utf8' }).trim();
    const decoy = execFileSync('git', ['mktree'], { cwd: handle.path, input: `100644 blob ${blob}\tfeature.txt\n`, encoding: 'utf8' }).trim();
    git(handle.path, 'replace', approved, decoy);
    expect(workingTreeState(handle.path).tree).toBe(approved);
    expect(treeChangedFiles(handle.path, handle.baseSha, approved)).toEqual(['.env', '.github/workflows/exfil.yml', 'feature.txt']);
    expect(() => commitAgentChanges(handle, 'feat(agent): test', { expectedTree: approved })).toThrow('Sensitive repository paths cannot be automatically committed: .env');
    expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(handle.baseSha);
  });

  it('commits as Code Conductor even when identity variables are inherited', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, 'agent.txt'), 'change\n');
    const approved = workingTreeState(handle.path).tree;
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'Person', GIT_AUTHOR_EMAIL: 'person@example.invalid', GIT_COMMITTER_NAME: 'Person', GIT_COMMITTER_EMAIL: 'person@example.invalid' });
    try { commitAgentChanges(handle, 'feat(agent): test', { expectedTree: approved }); }
    finally { for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
    expect(git(handle.path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe('Code Conductor <code-conductor@users.noreply.github.com>|Code Conductor <code-conductor@users.noreply.github.com>');
  });

  it('lists submodule pointer changes even when .gitmodules says to ignore them', () => {
    const handle = agentWorktree();
    writeFileSync(join(handle.path, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
    git(handle.path, 'add', '.gitmodules');
    git(handle.path, 'update-index', '--add', '--cacheinfo', `160000,${handle.baseSha},sub`);
    git(handle.path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'submodule');
    const before = git(handle.path, 'rev-parse', 'HEAD');
    git(handle.path, 'update-index', '--cacheinfo', `160000,${before},sub`);
    const moved = git(handle.path, 'write-tree');
    expect(treeChangedFiles(handle.path, before, moved)).toEqual(['sub']);
  });
});

describe('agent history and Git control state', () => {
  it('reports every path the commits since base touched, including ones removed again', () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    const commit = (message: string): void => { git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message); };
    writeFileSync(join(repo, '.env'), 'TOKEN=x\n');
    git(repo, 'add', '-f', '.env'); commit('add secret');
    git(repo, 'rm', '-q', '.env'); writeFileSync(join(repo, 'feature.txt'), 'f\n'); git(repo, 'add', 'feature.txt'); commit('remove secret');
    const history = commitsSince(repo, base);
    expect(history.commits).toHaveLength(2);
    expect(history.files).toEqual(['.env', 'feature.txt']);
    expect(commitsSince(repo, git(repo, 'rev-parse', 'HEAD'))).toEqual({ commits: [], files: [] });
  });

  it('changes when configuration or history files change, not when a value is rewritten unchanged', () => {
    const repo = repository();
    const initial = gitControlState(repo);
    git(repo, 'config', 'core.checkStat', 'minimal');
    expect(gitControlState(repo)).toBe(initial);
    git(repo, 'config', 'filter.agent.clean', 'cat');
    const filtered = gitControlState(repo);
    expect(filtered).not.toBe(initial);
    writeFileSync(join(repo, '.git', 'info', 'grafts'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
    expect(gitControlState(repo)).not.toBe(filtered);
    const plain = mkdtempSync(join(tmpdir(), 'cc-control-plain-'));
    temps.push(plain);
    expect(gitControlState(plain)).toBe('unversioned');
  });
});
