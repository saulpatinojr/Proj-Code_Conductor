import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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

// Repository hooks (pre-commit, post-checkout, ...) and a configured fsmonitor are
// repository-controlled programs. Code Conductor's own Git operations must neither
// execute them without approval nor let a hook restage an approved tree. The hooks
// path must be one nobody can populate: a path name in a shared temporary directory
// is visible in every git child's argv and could be created by another process or
// user. It is therefore an existing non-directory, under which no hook file can ever
// exist: /dev/null on POSIX, and the running executable itself on Windows.
const NO_HOOKS = process.platform === 'win32' ? process.execPath : '/dev/null';
/** The hooks path every Code Conductor git invocation uses (exported for tests). */
export const DISABLED_HOOKS_PATH = NO_HOOKS;
// Replace refs (refs/replace/*) make Git read a substitute for any object, so without
// --no-replace-objects a listing of a tree could show different files from the tree
// that `commit-tree` records. Every Code Conductor git call therefore sees the real
// objects only.
const SAFE_GIT = ['--no-replace-objects', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false'] as const;
// Large repositories list more than spawnSync's 1 MiB default; output past this fails closed.
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

function git(cwd: string, args: string[], allowFailure = false, env: NodeJS.ProcessEnv = withoutGitLocalEnv()): string {
  const result = spawnSync('git', [...SAFE_GIT, ...args], { cwd, encoding: 'utf8', env, shell: false, maxBuffer: MAX_GIT_OUTPUT });
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
// real-index staging of an approved commit compares full stat data and is then checked
// against the approved tree (fsmonitor is disabled for every Code Conductor git call).
const CONTENT_EXACT = ['-c', 'core.checkStat=default', '-c', 'core.trustctime=true', '-c', 'core.untrackedCache=false'] as const;

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
  // The tree always covers the whole work tree, so work from its top level: path
  // listings below are then relative to the same directory `update-index` resolves.
  const top = git(path, ['rev-parse', '--show-toplevel']).trim();
  const revision = git(top, ['rev-parse', '--verify', '-q', 'HEAD'], true).trim() || 'unborn';
  const directory = mkdtempSync(join(tmpdir(), 'cc-tree-'));
  try {
    const temporaryIndex = join(directory, 'index');
    const env = { ...withoutGitLocalEnv(), GIT_INDEX_FILE: temporaryIndex };
    // Seed with HEAD so tracked files that match .gitignore stay tracked, as they do
    // in the real index. read-tree records no stat data, so `add` re-hashes every file.
    if (revision !== 'unborn') git(top, ['read-tree', 'HEAD'], false, env);
    // Sparse checkouts leave skip-worktree paths off disk; keep those at their HEAD
    // content so they are not mistaken for deletions (which an approved commit would
    // then record). Only absent files qualify: a file present on disk is hashed like
    // any other, so setting the index bit cannot hide an edit from the binding.
    const skipped = git(top, ['ls-files', '-t', '-z']).split('\0').filter((entry) => entry.startsWith('S ')).map((entry) => entry.slice(2));
    const atHead = new Set(skipped.length ? git(top, ['ls-files', '-z'], false, env).split('\0') : []);
    const absent = skipped.filter((file) => atHead.has(file) && !presentOnDisk(join(top, file)));
    if (absent.length) {
      const update = spawnSync('git', [...SAFE_GIT, 'update-index', '-z', '--skip-worktree', '--stdin'], { cwd: top, env, input: `${absent.join('\0')}\0`, encoding: 'utf8', shell: false });
      if (update.status !== 0) throw new Error(`git update-index --skip-worktree failed: ${update.stderr || update.error?.message || 'unknown error'}`);
    }
    git(top, [...CONTENT_EXACT, 'add', '--all'], false, env);
    return { revision, tree: git(top, ['write-tree'], false, env).trim() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function presentOnDisk(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Digest of what, outside the work tree, decides which programs Code Conductor's own
 * Git operations run and which history they see: the effective configuration of every
 * scope with includes followed (it defines the clean, smudge and process filters that
 * `git add` runs), plus the grafts, shallow, alternates and info/attributes files. A
 * provider that rewrote them could make Code Conductor run its programs outside the
 * provider's own sandbox, or hide commits from the history check. Only the digest is
 * kept, never the configuration, which can hold credentials.
 */
export function gitControlState(path: string): string {
  if (git(path, ['rev-parse', '--is-inside-work-tree'], true).trim() !== 'true') return 'unversioned';
  const digest = createHash('sha256').update(git(path, ['config', '--list', '--show-scope', '--show-origin', '-z']));
  const files = git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts', '--git-path', 'shallow', '--git-path', 'objects/info/alternates', '--git-path', 'info/attributes']).trim().split(/\r?\n/);
  for (const file of files) {
    digest.update(`\0${file}\0`);
    try { digest.update(readFileSync(file)); } catch (error) { digest.update(`unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
  }
  return digest.digest('hex');
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
  /**
   * The approved tree. Code Conductor commits only this tree: the working tree must
   * still hash to it, and the commit object is created from the tree itself
   * (git commit-tree), so no staging step, stat cache or hook can change what is
   * committed. There is deliberately no unapproved commit path.
   */
  expectedTree: string;
  /** The HEAD the approval was bound to; refuse if the branch moved since. */
  expectedHead?: string;
}

/** Tree of HEAD, used to tell whether a working tree differs from its last commit. */
export function headTree(path: string): string {
  return git(path, ['rev-parse', 'HEAD^{tree}']).trim();
}

/**
 * Paths that differ between a commit and a tree object (both already in the object store).
 * Submodule pointer changes are always listed, whatever `.gitmodules` says to ignore.
 */
export function treeChangedFiles(path: string, from: string, toTree: string): string[] {
  return git(path, ['diff-tree', '-r', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', from, toTree]).split('\0').filter(Boolean).sort();
}

export interface CommitHistory { commits: string[]; files: string[] }

/**
 * Commits on HEAD since `base`, newest first, and every path any of them touched,
 * including paths a later commit removed again (their content stays in history).
 */
export function commitsSince(path: string, base: string): CommitHistory {
  const commits = git(path, ['rev-list', `${base}..HEAD`]).split('\n').filter(Boolean);
  if (!commits.length) return { commits, files: [] };
  const files = git(path, ['log', '-z', '--format=', '--name-only', '--no-renames', '-m', '--ignore-submodules=none', '--no-show-signature', `${base}..HEAD`]).split('\0').filter(Boolean);
  return { commits, files: [...new Set(files)].sort() };
}

// Inherited identity variables override -c user.name/user.email, so a commit could
// otherwise carry the person's own name and email instead of Code Conductor's.
const IDENTITY_ENV_VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'] as const;

export function commitAgentChanges(handle: WorktreeHandle, message: string, options: CommitOptions): AgentCommit | undefined {
  if (!options || typeof options.expectedTree !== 'string' || !/^[a-f0-9]{40,64}$/.test(options.expectedTree)) {
    throw new Error('Refusing to commit agent changes without an approved tree.');
  }
  assertAgentWorktree(handle);
  return commitApprovedTree(handle, message, options.expectedTree, options.expectedHead);
}

function commitApprovedTree(handle: WorktreeHandle, message: string, expectedTree: string, expectedHead?: string): AgentCommit | undefined {
  const files = treeChangedFiles(handle.path, handle.baseSha, expectedTree);
  if (!files.length) return undefined;
  assertSafeChangedPaths(files);
  const current = workingTreeState(handle.path);
  if (current.tree !== expectedTree) {
    throw new Error(`Refusing to commit agent changes in ${handle.path}: the worktree changed after commit approval (approved tree ${expectedTree}, now ${current.tree}). Changes are preserved uncommitted.`);
  }
  const head = gitHead(handle.path);
  if (expectedHead !== undefined && head !== expectedHead) {
    throw new Error(`Refusing to commit agent changes in ${handle.path}: ${handle.branch} moved from the approved ${expectedHead} to ${head}. Changes are preserved uncommitted.`);
  }
  if (headTree(handle.path) === expectedTree) return { sha: head, files, created: false };
  // Code Conductor's own identity; never sign with the person's key on their behalf.
  const identity = ['-c', 'user.name=Code Conductor', '-c', 'user.email=code-conductor@users.noreply.github.com', '-c', 'commit.gpgSign=false'];
  const env = withoutGitLocalEnv();
  for (const name of IDENTITY_ENV_VARS) delete env[name];
  const sha = git(handle.path, [...identity, 'commit-tree', expectedTree, '-p', head, '-m', message], false, env).trim();
  // Compare-and-swap: refuse if the branch moved since it was read.
  git(handle.path, ['update-ref', '-m', 'code-conductor: approved agent commit', `refs/heads/${handle.branch}`, sha, head]);
  // Bring the index in line with the new commit; the working tree already matches it.
  git(handle.path, ['reset', '-q'], true);
  return { sha, files, created: true };
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
