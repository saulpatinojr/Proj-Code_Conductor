import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface WorktreeHandle {
  repositoryRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  taskId: string;
  agentId: string;
}

export interface AgentCommit {
  sha: string;
  files: string[];
  created: boolean;
}

export function safeGitRefSegment(value: string): string {
  let segment = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80)
    .replace(/[.-]+$/g, '');
  if (segment.toLowerCase().endsWith('.lock')) segment = `${segment.slice(0, -5)}-lock`;
  segment = segment.replace(/\.\.+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return segment || 'agent';
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// Git's repository-local environment variables (`git rev-parse --local-env-vars`).
// Git exports several of them to hooks, and dotfiles-style shells set them, so an
// inherited value would silently point a command at another repository, index, or
// work tree than the one named by cwd. Child git processes therefore never see them.
export const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
] as const;

export function withoutGitLocalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of GIT_LOCAL_ENV_VARS) delete scrubbed[name];
  return scrubbed;
}

function git(cwd: string, args: string[], allowFailure = false, env: NodeJS.ProcessEnv = withoutGitLocalEnv()): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, shell: false });
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const diagnostic = [result.stderr || '', result.stdout || ''].filter(Boolean).join('\n').trim();
    throw new Error(`git ${args.join(' ')} failed${diagnostic ? `: ${diagnostic}` : ` (exit ${String(result.status)})`}`);
  }
  return result.stdout || '';
}

export function resolveRepositoryRoot(cwd: string): string {
  return resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim());
}

export function gitChangedFiles(cwd: string): string[] {
  const output = git(cwd, ['status', '--porcelain=v1', '-z'], true);
  if (!output) return [];
  const entries = output.split('\0');
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) files.push(path);
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return files;
}

export function gitHead(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

export interface WorkingTreeState { revision: string; tree: string }

// Stat-cache shortcuts let Git skip re-reading a file whose cached stat data still
// matches. With core.checkStat=minimal / core.trustctime=false (common in containers)
// or a repository-configured fsmonitor/untracked cache, an edit that preserves size
// and mtime can go unseen. Content binding therefore hashes into a fresh index; the
// real-index staging of an approved commit compares full stat data, never consults a
// repository-configured fsmonitor hook, and is then checked against the approved tree.
const CONTENT_EXACT = ['-c', 'core.checkStat=default', '-c', 'core.trustctime=true', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;

/**
 * Content identity of a working tree for approval binding: HEAD plus the Git
 * tree of every tracked file and every untracked non-ignored file. A temporary
 * index seeded from HEAD without stat data is used, so every file is hashed (no
 * stat-cache shortcut can hide an edit) and the repository's own index and files
 * are never modified.
 * Git may add unreferenced blob objects, which it garbage-collects normally.
 * Paths outside Git report `unversioned`; their content cannot be bound.
 */
export function workingTreeState(path: string): WorkingTreeState {
  if (git(path, ['rev-parse', '--is-inside-work-tree'], true).trim() !== 'true') return { revision: 'unversioned', tree: 'unversioned' };
  const revision = git(path, ['rev-parse', '--verify', '-q', 'HEAD'], true).trim() || 'unborn';
  const directory = mkdtempSync(join(tmpdir(), 'cc-tree-'));
  try {
    const temporaryIndex = join(directory, 'index');
    const env = { ...withoutGitLocalEnv(), GIT_INDEX_FILE: temporaryIndex };
    // Seed with HEAD so tracked files that match .gitignore stay tracked, as they do
    // in the real index. read-tree records no stat data, so `add` re-hashes every file.
    if (revision !== 'unborn') git(path, ['read-tree', 'HEAD'], false, env);
    git(path, [...CONTENT_EXACT, 'add', '--all'], false, env);
    return { revision, tree: git(path, ['write-tree'], false, env).trim() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function isSensitiveRepositoryPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const leaf = normalized.split('/').at(-1) ?? normalized;
  if (leaf === '.env.example' || leaf === '.env.template' || leaf === 'credentials.example') return false;
  if (leaf === '.env' || leaf.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(leaf)) return true;
  if (leaf === 'terraform.tfstate' || leaf.endsWith('.tfstate') || leaf.endsWith('.tfstate.backup')) return true;
  if (normalized.includes('/.terraform/')) return true;
  if (/^(credentials|credentials\..+|id_rsa|id_ed25519)$/.test(leaf)) return true;
  return false;
}

export function assertSafeChangedPaths(files: string[]): void {
  const blocked = files.filter(isSensitiveRepositoryPath);
  if (blocked.length) throw new Error(`Sensitive repository paths cannot be automatically committed: ${blocked.join(', ')}`);
}

export function worktreeChangedFiles(handle: WorktreeHandle): string[] {
  const committed = git(handle.path, ['diff', '--name-only', `${handle.baseSha}..HEAD`], true).trim().split(/\r?\n/).filter(Boolean);
  return [...new Set([...committed, ...gitChangedFiles(handle.path)])].sort();
}

// Agent commits stage everything with `git add --all`, which is only safe inside
// the isolated worktree WorktreeManager created for that agent. Anything else may
// hold a person's uncommitted work, so refuse it outright (issue #48). The handle
// must name the top level of a linked worktree (git-dir differs from the common
// git-dir, so not a primary working tree) that still has the handle's `cc/` agent
// branch checked out; WorktreeManager.create always checks that branch out, and
// Git lets a branch be checked out in only one worktree at a time.
export function assertAgentWorktree(handle: WorktreeHandle): void {
  const refuse = (reason: string): never => {
    throw new Error(`Refusing to commit agent changes in ${handle.path}: ${reason}`);
  };
  const paths = git(handle.path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']).trim().split(/\r?\n/);
  // Git older than 2.31 echoes the unknown --path-format flag back as an extra
  // line, so anything but exactly three absolute paths fails closed.
  if (paths.length !== 3 || !paths.every((path) => isAbsolute(path))) {
    refuse('could not determine its Git worktree layout (Git 2.31 or later is required).');
  }
  const [gitDir, commonDir, topLevel] = paths.map((path) => resolve(path));
  if (gitDir === commonDir) refuse('it is a repository\'s primary working tree, not a Code Conductor agent worktree.');
  if (!topLevel || realpathSync(topLevel) !== realpathSync(handle.path)) {
    refuse(`Git resolves its work tree to ${topLevel ?? 'nothing'}, not the agent worktree itself.`);
  }
  const head = git(handle.path, ['symbolic-ref', '-q', 'HEAD'], true).trim();
  if (!handle.branch.startsWith('cc/') || head !== `refs/heads/${handle.branch}`) {
    refuse(`it has ${head || 'a detached HEAD'} checked out, not a Code Conductor agent branch matching ${handle.branch}.`);
  }
}

export interface CommitOptions {
  /** When set, commit only if the staged tree is exactly this approved tree. */
  expectedTree?: string;
}

export function commitAgentChanges(handle: WorktreeHandle, message: string, options: CommitOptions = {}): AgentCommit | undefined {
  assertAgentWorktree(handle);
  const files = worktreeChangedFiles(handle);
  if (!files.length) return undefined;
  assertSafeChangedPaths(files);
  const dirty = gitChangedFiles(handle.path);
  let created = false;
  if (dirty.length) {
    git(handle.path, [...CONTENT_EXACT, 'add', '--all']);
    if (options.expectedTree !== undefined) {
      const staged = git(handle.path, ['write-tree']).trim();
      if (staged !== options.expectedTree) {
        git(handle.path, ['reset', '-q'], true);
        throw new Error(`Refusing to commit agent changes in ${handle.path}: the worktree changed after commit approval (approved tree ${options.expectedTree}, now ${staged}). Changes are preserved uncommitted.`);
      }
    }
    git(handle.path, ['-c', 'user.name=Code Conductor', '-c', 'user.email=code-conductor@users.noreply.github.com', 'commit', '-m', message]);
    created = true;
  }
  return { sha: gitHead(handle.path), files: worktreeChangedFiles(handle), created };
}

export class WorktreeManager {
  readonly root: string;

  constructor(root = join(homedir(), '.code-conductor', 'worktrees')) {
    this.root = root;
    ensurePrivateDirectory(root);
  }

  create(repositoryRoot: string, taskId: string, agentId: string, baseRef = 'HEAD'): WorktreeHandle {
    const repo = resolveRepositoryRoot(repositoryRoot);
    const baseSha = git(repo, ['rev-parse', baseRef]).trim();
    const repoId = createHash('sha256').update(repo).digest('hex').slice(0, 10);
    const task = safeGitRefSegment(taskId);
    const agent = safeGitRefSegment(agentId);
    const branch = `cc/${task}/${agent}`;
    const repoDirectory = join(this.root, repoId);
    const taskDirectory = join(repoDirectory, task);
    const path = join(taskDirectory, agent);
    ensurePrivateDirectory(repoDirectory);
    ensurePrivateDirectory(taskDirectory);
    git(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
    chmodSync(path, 0o700);
    return { repositoryRoot: repo, path, branch, baseRef, baseSha, taskId, agentId };
  }

  remove(handle: WorktreeHandle, deleteBranch = false, force = false): void {
    if (!force && gitChangedFiles(handle.path).length) {
      throw new Error(`Refusing to remove dirty worktree: ${handle.path}`);
    }
    git(handle.repositoryRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), handle.path]);
    git(handle.repositoryRoot, ['worktree', 'prune']);
    if (deleteBranch) git(handle.repositoryRoot, ['branch', '-D', handle.branch]);
  }
}
