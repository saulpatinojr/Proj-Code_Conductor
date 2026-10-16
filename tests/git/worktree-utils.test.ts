import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeManager, assertSafeChangedPaths, commitAgentChanges, gitChangedFiles, isSensitiveRepositoryPath, resolveRepositoryRoot, safeGitRefSegment, workingTreeState } from '../../packages/git/src/index.js';

// Every agent commit is bound to an approved tree (ADR 0013); these tests approve the current one.
const approved = (path: string) => ({ expectedTree: workingTreeState(path).tree === 'unversioned' ? 'f'.repeat(40) : workingTreeState(path).tree });

describe('git helpers', () => {
  it('can inspect the current repository without mutating it', () => {
    expect(Array.isArray(gitChangedFiles('.'))).toBe(true);
  });

  it('blocks common secret/state paths while allowing templates', () => {
    expect(isSensitiveRepositoryPath('.env')).toBe(true);
    expect(isSensitiveRepositoryPath('ops/prod.tfstate')).toBe(true);
    expect(isSensitiveRepositoryPath('certs/client.pem')).toBe(true);
    expect(isSensitiveRepositoryPath('.env.example')).toBe(false);
    expect(isSensitiveRepositoryPath('src/index.ts')).toBe(false);
  });

  it('returns the destination path for Git renames so sensitive-path checks cannot be bypassed', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-rename-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'safe.txt'), 'fixture\n');
      execFileSync('git', ['add', 'safe.txt'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      execFileSync('git', ['mv', 'safe.txt', '.env'], { cwd: repositoryRoot });

      const files = gitChangedFiles(repositoryRoot);
      expect(files).toContain('.env');
      expect(files.some((path) => path.includes(' -> '))).toBe(false);
      expect(() => assertSafeChangedPaths(files)).toThrow(/Sensitive repository paths/);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('sanitizes externally supplied task and agent IDs into valid ref components', () => {
    expect(safeGitRefSegment('../release..candidate.lock')).toBe('release-candidate-lock');
    expect(safeGitRefSegment('.lock')).toBe('lock');
    expect(safeGitRefSegment('...')).toBe('agent');
    expect(safeGitRefSegment('feature@{bad}')).not.toMatch(/\.\.|@\{|\.lock$/i);
  });

  it('preserves spawn diagnostics when Git cannot be found', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => resolveRepositoryRoot('.')).toThrow('Git was not found on an absolute PATH entry');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('creates modifying worktree directories as owner-only on POSIX systems', () => {
    if (process.platform === 'win32') return;

    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-worktree-repo-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'cc-worktrees-'));
    let handle: ReturnType<WorktreeManager['create']> | undefined;

    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });

      const manager = new WorktreeManager(worktreeRoot);
      handle = manager.create(repositoryRoot, 'T-PERM', 'builder');

      const repoDirectory = join(worktreeRoot, handle.path.split('/').at(-3) ?? '');
      const taskDirectory = join(repoDirectory, 'T-PERM');
      const mode = (path: string) => statSync(path).mode & 0o777;

      expect(mode(worktreeRoot)).toBe(0o700);
      expect(mode(repoDirectory)).toBe(0o700);
      expect(mode(taskDirectory)).toBe(0o700);
      expect(mode(handle.path)).toBe(0o700);

      manager.remove(handle, true, true);
      handle = undefined;
    } finally {
      if (handle) {
        try {
          new WorktreeManager(worktreeRoot).remove(handle, true, true);
        } catch {
          // Best-effort cleanup for a failed assertion or git operation.
        }
      }
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses to commit agent changes in a primary working tree (#48)', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-primary-tree-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'uncommitted-notes.txt'), 'work in progress\n');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

      const handle = { repositoryRoot, path: repositoryRoot, branch: 'cc/T-48/builder', baseRef: 'HEAD', baseSha: head, taskId: 'T-48', agentId: 'builder' };
      expect(() => commitAgentChanges(handle, 'feat(agent): builder for T-48', approved(handle.path))).toThrow(/primary working tree/);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(repositoryRoot)).toEqual(['uncommitted-notes.txt']);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('commits agent changes inside a managed linked worktree without touching the primary tree', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-linked-tree-repo-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'cc-linked-worktrees-'));
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

      const handle = new WorktreeManager(worktreeRoot).create(repositoryRoot, 'T-LINKED', 'builder');
      writeFileSync(join(handle.path, 'agent-output.txt'), 'agent change\n');
      const commit = commitAgentChanges(handle, 'feat(agent): builder for T-LINKED', approved(handle.path));

      expect(commit?.created).toBe(true);
      expect(commit?.files).toEqual(['agent-output.txt']);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(repositoryRoot)).toEqual([]);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses to commit agent changes in a linked worktree that is not on the agent branch (#48)', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-foreign-worktree-repo-'));
    const contributorWorktree = join(mkdtempSync(join(tmpdir(), 'cc-foreign-worktree-')), 'feature');
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      // A person's own linked worktree, like the one #48 was reproduced in.
      execFileSync('git', ['worktree', 'add', '-b', 'contributor-feature', contributorWorktree], { cwd: repositoryRoot });
      writeFileSync(join(contributorWorktree, 'uncommitted-notes.txt'), 'work in progress\n');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: contributorWorktree, encoding: 'utf8' }).trim();

      const handle = { repositoryRoot, path: contributorWorktree, branch: 'cc/T-48/builder', baseRef: 'HEAD', baseSha: head, taskId: 'T-48', agentId: 'builder' };
      expect(() => commitAgentChanges(handle, 'feat(agent): builder for T-48', approved(handle.path))).toThrow(/refs\/heads\/contributor-feature checked out, not a Code Conductor agent branch matching cc\/T-48\/builder/);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: contributorWorktree, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(contributorWorktree)).toEqual(['uncommitted-notes.txt']);
    } finally {
      rmSync(join(contributorWorktree, '..'), { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when Git cannot report absolute worktree paths', () => {
    if (process.platform === 'win32') return;

    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-old-git-repo-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'cc-old-git-worktrees-'));
    const shimDirectory = mkdtempSync(join(tmpdir(), 'cc-old-git-shim-'));
    const originalPath = process.env.PATH;
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      const handle = new WorktreeManager(worktreeRoot).create(repositoryRoot, 'T-OLD-GIT', 'builder');
      writeFileSync(join(handle.path, 'agent-output.txt'), 'agent change\n');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: handle.path, encoding: 'utf8' }).trim();

      // Git before 2.31 does not know --path-format and echoes it back as output.
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const shim = join(shimDirectory, 'git');
      writeFileSync(shim, `#!/bin/sh\nfor arg; do shift; [ "$arg" = --path-format=absolute ] && arg=--path-format-unknown; set -- "$@" "$arg"; done\nexec "${realGit}" "$@"\n`);
      chmodSync(shim, 0o755);
      process.env.PATH = `${shimDirectory}${delimiter}${originalPath ?? ''}`;

      expect(() => commitAgentChanges(handle, 'feat(agent): builder for T-OLD-GIT', approved(handle.path))).toThrow(/Git 2\.31 or later is required/);
      process.env.PATH = originalPath;
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: handle.path, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(handle.path)).toEqual(['agent-output.txt']);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(shimDirectory, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses a handle that names a person\'s own branch instead of a Code Conductor agent branch', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-foreign-branch-repo-'));
    const contributorWorktree = join(mkdtempSync(join(tmpdir(), 'cc-foreign-branch-')), 'feature');
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      execFileSync('git', ['worktree', 'add', '-b', 'feature/human', contributorWorktree], { cwd: repositoryRoot });
      writeFileSync(join(contributorWorktree, 'uncommitted-notes.txt'), 'work in progress\n');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: contributorWorktree, encoding: 'utf8' }).trim();

      const handle = { repositoryRoot, path: contributorWorktree, branch: 'feature/human', baseRef: 'HEAD', baseSha: head, taskId: 'T-48', agentId: 'builder' };
      expect(() => commitAgentChanges(handle, 'feat(agent): builder for T-48', approved(handle.path))).toThrow(/not a Code Conductor agent branch/);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: contributorWorktree, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(contributorWorktree)).toEqual(['uncommitted-notes.txt']);
    } finally {
      rmSync(join(contributorWorktree, '..'), { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  // Git exports GIT_DIR/GIT_INDEX_FILE to hooks and dotfiles shells set GIT_WORK_TREE,
  // so a run launched from either must not have its git commands redirected to the
  // person's own checkout or index.
  it.each([
    ['GIT_WORK_TREE', (primary: string) => primary],
    ['GIT_INDEX_FILE', (primary: string) => join(primary, '.git', 'index')],
  ])('ignores an inherited %s pointing at a person\'s checkout', (name, value) => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-inherited-env-repo-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'cc-inherited-env-worktrees-'));
    const original = process.env[name];
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'staged.txt'), 'staged by a person\n');
      execFileSync('git', ['add', 'staged.txt'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'uncommitted-notes.txt'), 'work in progress\n');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' });

      process.env[name] = value(repositoryRoot);
      const handle = new WorktreeManager(worktreeRoot).create(repositoryRoot, 'T-ENV', 'builder');
      writeFileSync(join(handle.path, 'agent-output.txt'), 'agent change\n');
      const commit = commitAgentChanges(handle, 'feat(agent): builder for T-ENV', approved(handle.path));
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;

      expect(commit?.files).toEqual(['agent-output.txt']);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()).toBe(head);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' })).toBe(status);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses a handle whose path is a primary tree even when GIT_DIR names an agent worktree', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'cc-inherited-gitdir-repo-'));
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'cc-inherited-gitdir-worktrees-'));
    const original = process.env.GIT_DIR;
    try {
      execFileSync('git', ['init'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
      execFileSync('git', ['-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repositoryRoot });
      writeFileSync(join(repositoryRoot, 'uncommitted-notes.txt'), 'work in progress\n');
      const agent = new WorktreeManager(worktreeRoot).create(repositoryRoot, 'T-GITDIR', 'builder');
      const agentGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: agent.path, encoding: 'utf8' }).trim();
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

      process.env.GIT_DIR = agentGitDir;
      expect(() => commitAgentChanges({ ...agent, path: repositoryRoot }, 'feat(agent): builder for T-GITDIR', approved(repositoryRoot))).toThrow(/primary working tree/);
      if (original === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = original;

      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: agent.path, encoding: 'utf8' }).trim()).toBe(agent.baseSha);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()).toBe(head);
      expect(gitChangedFiles(repositoryRoot)).toEqual(['uncommitted-notes.txt']);
    } finally {
      if (original === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = original;
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
