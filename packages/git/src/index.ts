import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { absolutePathEnvironment, resolveExecutable } from '@code-conductor/core/processes';

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
    // A trailing match starts only where a run begins (the lookbehind), so a long run
    // inside the value is scanned once, not once per character.
    .replace(/^[.-]+|(?<![.-])[.-]+$/g, '')
    .slice(0, 80)
    .replace(/(?<![.-])[.-]+$/g, '');
  if (segment.toLowerCase().endsWith('.lock')) segment = `${segment.slice(0, -5)}-lock`;
  segment = segment.replace(/\.\.+/g, '-').replace(/^[.-]+|(?<![.-])[.-]+$/g, '');
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
// submodule.recurse=false keeps checkouts (worktree add) from populating submodules,
// whose repositories would then sit inside an agent worktree (see nestedRepositories).
// core.commitGraph=false: Git trusts the parents a commit-graph file records, so an agent
// that rewrote it could hide commits from the history it is checked by.
const SAFE_GIT = ['--no-replace-objects', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'core.commitGraph=false'] as const;
// Large repositories list more than spawnSync's 1 MiB default; output past this fails closed.
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

/**
 * The Git executable, from an absolute PATH entry only. Many Code Conductor Git calls
 * run with an agent worktree as their working directory, where a bare `git` could
 * otherwise resolve to a program the agent wrote (Windows looks in the working
 * directory first; POSIX does for an empty or relative PATH entry).
 */
export function gitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveExecutable('git', env);
  if (!resolved.path) throw new Error(`Git was not found on an absolute PATH entry (${resolved.problem ?? 'unknown problem'}).`);
  return resolved.path;
}

interface RunGitOptions { env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number }
function runGit(cwd: string, args: readonly string[], options: RunGitOptions & { encoding: 'utf8' }): SpawnSyncReturns<string>;
function runGit(cwd: string, args: readonly string[], options?: RunGitOptions): SpawnSyncReturns<Buffer>;
function runGit(cwd: string, args: readonly string[], options: RunGitOptions & { encoding?: 'utf8' } = {}): SpawnSyncReturns<string | Buffer> {
  // Programs Git starts itself (ssh, filters, credential helpers) follow the same rule.
  const env = absolutePathEnvironment(options.env ?? withoutGitLocalEnv());
  return spawnSync(gitExecutable(env), [...SAFE_GIT, ...args], { cwd, env, shell: false, windowsHide: true, maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT, ...(options.input !== undefined ? { input: options.input } : {}), ...(options.encoding ? { encoding: options.encoding } : {}) });
}

function git(cwd: string, args: string[], allowFailure = false, env: NodeJS.ProcessEnv = withoutGitLocalEnv()): string {
  const result = runGit(cwd, args, { env, encoding: 'utf8' });
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
  // Without --ignore-submodules=all, status runs `git status` inside every checked-out
  // submodule, under that repository's own configuration (filters included).
  const output = git(cwd, ['status', '--porcelain=v1', '-z', '--ignore-submodules=all'], true);
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
      const update = runGit(top, ['update-index', '-z', '--skip-worktree', '--stdin'], { env, input: `${absent.join('\0')}\0`, encoding: 'utf8' });
      if (update.status !== 0) throw new Error(`git update-index --skip-worktree failed: ${update.stderr || update.error?.message || 'unknown error'}`);
    }
    git(top, [...CONTENT_EXACT, 'add', '--all'], false, env);
    return { revision, tree: git(top, ['write-tree'], false, env).trim() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function presentOnDisk(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export interface GitControlState {
  /** The repository's common Git directory, shared by all of its worktrees. */
  commonDir: string;
  /**
   * A digest per source, named by what and where it is and never by its content: each
   * configuration file Git read, by scope and origin as `git config --show-origin` prints
   * them; each control file; and each nested repository with its own sources.
   */
  sources: ReadonlyMap<string, string>;
}

/** Nesting deeper than this is not read, and is reported as unreadable control state. */
export const MAX_NESTED_REPOSITORY_DEPTH = 3;

/**
 * Repositories nested in a work tree that Git would enter, each under its own
 * configuration: gitlinks in HEAD or the index whose path holds a `.git` (a checked-out
 * submodule, which `git status` and `git add` enter), and untracked repositories, which
 * `git add --all` records as gitlinks. Read with ls-tree and ls-files, which never enter
 * them. Paths are relative to `top` and sorted.
 */
export function nestedRepositories(top: string): string[] {
  const gitlinks = (output: string): string[] => output.split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], true).trim();
  const tracked = [...gitlinks(git(top, ['ls-files', '--stage', '-z'])), ...(head ? gitlinks(git(top, ['ls-tree', '-r', '-z', head])) : [])];
  const populated = tracked.filter((file) => presentOnDisk(join(top, file, '.git')));
  // Without --directory, untracked files are listed one by one and a nested repository,
  // which Git does not enter, as its directory with a trailing slash.
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
  return [...new Set([...populated, ...untracked])].sort();
}

// Configuration of every scope with includes followed, and the grafts, shallow,
// alternates and info/attributes files, of the repository whose work tree is `top`, each
// digested in `sources` under its own name, after `prefix`.
function digestControl(top: string, prefix: string, sources: Map<string, Hash>): string {
  const source = (name: string): Hash => {
    let hash = sources.get(`${prefix}${name}`);
    if (!hash) sources.set(`${prefix}${name}`, hash = createHash('sha256'));
    return hash;
  };
  // -z prints scope, origin and "key\nvalue" as three NUL-terminated fields per entry.
  // Origins of a main worktree's own files are relative (file:.git/config). Every path is
  // resolved, so a change names a file the person can open, spelt as the platform spells
  // it (Git writes C:/... on Windows).
  const fields = git(top, ['config', '--list', '--show-scope', '--show-origin', '-z']).split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const origin = fields[index + 1] ?? '';
    const named = origin.startsWith('file:') ? `file:${resolve(top, origin.slice(5))}` : origin;
    source(`${fields[index]} config ${named}`).update(`${fields[index + 2]}\0`);
  }
  const [gitDir = '', commonDir = '', ...files] = git(top, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--git-path', 'info/grafts', '--git-path', 'shallow', '--git-path', 'objects/info/alternates', '--git-path', 'info/attributes']).trim().split(/\r?\n/).map((path) => resolve(path));
  // Named, so a .git file rewritten to another worktree's Git directory, whose HEAD and
  // history the checks would then read, is a change too.
  source(`git directory ${gitDir}`);
  for (const file of files) {
    const hash = source(`file ${file}`);
    try {
      const content = readFileSync(file);
      hash.update('read\0').update(content);
    } catch (error) { hash.update(`unreadable\0${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); }
  }
  return commonDir;
}

/**
 * Digests of what, outside the work tree, decides which programs Code Conductor's own
 * Git operations run and which history they see: the effective configuration of every
 * scope with includes followed (it defines the clean, smudge and process filters that
 * `git add` runs), plus the grafts, shallow, alternates and info/attributes files. A
 * provider that rewrote them could make Code Conductor run its programs outside the
 * provider's own sandbox, or hide commits from the history check. Repositories nested
 * in the work tree (see `nestedRepositories`) count too, with their own configuration:
 * Git runs inside them, so one that appears or changes is a change like any other.
 * A reading is the repository as Git sees it from `path`. Origin paths and conditional
 * includes (`includeIf "gitdir:..."`, `"onbranch:..."`) depend on where Git runs, so the
 * worktrees of one repository legitimately differ: compare a reading only with an earlier
 * reading of the same path (see `controlStateChanges`). Only digests are kept, never the
 * configuration, which can hold credentials. Undefined outside Git.
 */
export function gitControlState(path: string): GitControlState | undefined {
  if (git(path, ['rev-parse', '--is-inside-work-tree'], true).trim() !== 'true') return undefined;
  const sources = new Map<string, Hash>();
  const top = git(path, ['rev-parse', '--show-toplevel']).trim();
  const commonDir = digestControl(top, '', sources);
  const nested = (directory: string, depth: number): void => {
    for (const file of nestedRepositories(directory)) {
      const inner = join(directory, file);
      if (depth >= MAX_NESTED_REPOSITORY_DEPTH) throw new Error(`repositories are nested more than ${MAX_NESTED_REPOSITORY_DEPTH} levels deep at ${inner}`);
      const name = `nested repository ${relative(top, inner)}`;
      sources.set(name, createHash('sha256'));
      digestControl(inner, `${name}: `, sources);
      nested(inner, depth + 1);
    }
  };
  nested(top, 0);
  return { commonDir, sources: new Map([...sources].map(([name, hash]) => [name, hash.digest('hex')])) };
}

/**
 * What differs between two readings of the same path, by source name and never by content,
 * sorted. Names hold the paths Git read, so a path that now reads another repository or
 * another worktree's Git directory (a rewritten `.git` file) differs by name too. A nested
 * repository that appeared or disappeared stands for its own sources.
 */
export function controlStateChanges(before: GitControlState, after: GitControlState): string[] {
  const names = [...new Set([...before.sources.keys(), ...after.sources.keys()])].sort();
  const whole = names.filter((name) => name.startsWith('nested repository ') && before.sources.has(name) !== after.sources.has(name));
  return names.filter((name) => !whole.some((repository) => name.startsWith(`${repository}: `))).flatMap((name) => {
    const was = before.sources.get(name);
    const now = after.sources.get(name);
    return was === now ? [] : [`${name} ${was === undefined ? 'appeared' : now === undefined ? 'disappeared' : 'changed'}`];
  });
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

export interface SecretFinding { path: string; line: number; kind: string }

export interface SecretScan {
  findings: SecretFinding[];
  /** Changed files whose content was not scanned because the scan budget ran out. */
  unscanned: string[];
}

// High-confidence credential formats only; a match is reported by location and kind,
// never by value. Matches already present in the base revision at the same path are
// not new and are not reported.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['Perplexity API key', /\bpplx-[A-Za-z0-9]{32,}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{24,}\b/g],
  ['Azure storage account key', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g],
];
/**
 * Replace credential-looking strings in free text, such as an agent's reported risks,
 * with a marker naming their kind, so they are never passed on to another provider.
 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let result = text;
  for (const [kind, pattern] of SECRET_PATTERNS) result = result.replace(pattern, () => { redacted += 1; return `[redacted ${kind}]`; });
  return { text: result, redacted };
}

const REDACTION_MARKERS = SECRET_PATTERNS.map(([kind]) => `[redacted ${kind}]`);
/**
 * How many of redactSecrets' markers `text` holds. Each marker is matched exactly with
 * indexOf, not a regular expression, so the time stays linear whatever the text holds:
 * it is often what agents wrote.
 */
export function countRedactions(text: string): number {
  let count = 0;
  for (const marker of REDACTION_MARKERS) {
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) count += 1;
  }
  return count;
}

/** Content read by one scan, across all files and both sides of the comparison. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

interface ScanEntry { path: string; after: string; before?: string; type?: 'blob' | 'commit' }
interface ObjectInfo { id: string; type: string; size: number }

// One `cat-file --batch-check` for all names; undefined where an object does not exist.
function objectInfo(cwd: string, names: readonly string[]): Array<ObjectInfo | undefined> {
  if (!names.length) return [];
  const result = runGit(cwd, ['cat-file', '--batch-check'], { input: names.map((name) => `${name}\n`).join(''), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git cat-file --batch-check failed: ${result.stderr || result.error?.message || `exit ${String(result.status)}`}`);
  const lines = result.stdout.split('\n');
  // Found objects print "<id> <type> <size>"; others print the name followed by "missing".
  return names.map((_, index) => {
    const [id, type, size, ...rest] = (lines[index] ?? '').split(' ');
    return id && type && size && !rest.length && OBJECT_ID.test(id) && /^\d+$/.test(size) ? { id, type, size: Number(size) } : undefined;
  });
}

// One `cat-file --batch` for all blobs; output is "<id> <type> <size>\n<content>\n" each.
// Anything short of every object in full fails, so no content is mistaken for empty.
function readObjects(cwd: string, objects: readonly ObjectInfo[]): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  if (!objects.length) return contents;
  const expected = objects.reduce((total, item) => total + item.size + 160, 0);
  const result = runGit(cwd, ['cat-file', '--batch'], { input: objects.map((item) => `${item.id}\n`).join(''), maxBuffer: expected });
  if (result.error || result.status !== 0) throw new Error(`git cat-file --batch failed: ${result.stderr?.toString() || result.error?.message || `exit ${String(result.status)}`}`);
  let offset = 0;
  for (const item of objects) {
    const newline = result.stdout.indexOf(0x0a, offset);
    const [id, , size] = (newline < 0 ? '' : result.stdout.subarray(offset, newline).toString('latin1')).split(' ');
    const length = Number(size);
    if (id !== item.id || length !== item.size || newline + 1 + length > result.stdout.length) throw new Error(`git cat-file --batch did not return ${item.id} in full`);
    contents.set(id, result.stdout.subarray(newline + 1, newline + 1 + length));
    offset = newline + 1 + length + 1;
  }
  return contents;
}

// Credential formats are ASCII. Latin-1 maps every byte to one character, so they are
// found in UTF-8, other ASCII-compatible encodings and binary content alike, and line
// numbers count newline bytes. UTF-16 text with a byte-order mark is decoded first.
function scannable(content: Buffer): string {
  if (content[0] === 0xff && content[1] === 0xfe) return content.subarray(2).toString('utf16le');
  if (content[0] === 0xfe && content[1] === 0xff) {
    const body = Buffer.from(content.subarray(2, 2 + ((content.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  return content.toString('latin1');
}

function scanEntries(cwd: string, entries: readonly ScanEntry[], maxBytes: number): SecretScan {
  const names = [...new Set(entries.flatMap((entry) => (entry.before ? [entry.after, entry.before] : [entry.after])))];
  const infos = objectInfo(cwd, names);
  const byName = new Map(names.map((name, index) => [name, infos[index]]));
  const selected = new Map<string, ObjectInfo>();
  const unscanned: string[] = [];
  let budget = maxBytes;
  const planned: Array<{ path: string; after: ObjectInfo; before?: ObjectInfo }> = [];
  // A path is published with its content, so a credential-looking file or directory name
  // the base did not have counts too (reported redacted, at line 0).
  const named = new Map<string, SecretFinding>();
  for (const entry of entries) {
    if (entry.type !== 'commit' && !(entry.before && byName.get(entry.before))) {
      for (const [kind] of SECRET_PATTERNS.filter(([, pattern]) => entry.path.search(pattern) >= 0)) {
        const path = redactSecrets(entry.path).text;
        named.set(`${path}\0${kind}`, { path, line: 0, kind: `${kind} in its name` });
      }
    }
    const after = byName.get(entry.after);
    // Not what was asked for (for example a submodule pointer): there is no content to scan.
    if (!after || after.type !== (entry.type ?? 'blob')) continue;
    const candidate = entry.before ? byName.get(entry.before) : undefined;
    const before = candidate?.type === 'blob' ? candidate : undefined;
    const fresh = new Map([after, before].filter((item): item is ObjectInfo => item !== undefined && !selected.has(item.id)).map((item) => [item.id, item]));
    const cost = [...fresh.values()].reduce((total, item) => total + item.size, 0);
    if (cost > budget) { unscanned.push(redactSecrets(entry.path).text); continue; }
    budget -= cost;
    for (const item of [after, before]) if (item) selected.set(item.id, item);
    planned.push({ path: entry.path, after, ...(before ? { before } : {}) });
  }
  const contents = readObjects(cwd, [...selected.values()]);
  const findings: SecretFinding[] = [...named.values()];
  const seen = new Set<string>();
  for (const item of planned) {
    const text = scannable(contents.get(item.after.id)!);
    const previous = item.before ? scannable(contents.get(item.before.id)!) : '';
    for (const [kind, pattern] of SECRET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (previous.includes(match[0])) continue;
        const line = text.slice(0, match.index).split('\n').length;
        const key = `${item.path}\0${line}\0${kind}`;
        // A file named like a credential is reported under its redacted name, everywhere.
        if (!seen.has(key)) { seen.add(key); findings.push({ path: redactSecrets(item.path).text, line, kind }); }
      }
    }
  }
  return { findings, unscanned: [...new Set(unscanned)].sort() };
}

/**
 * New credential-looking strings in the files that differ between a commit and a tree.
 * Every changed file is read in full, text or binary, up to MAX_SCAN_BYTES for the
 * whole scan; files past that budget are listed as `unscanned`, never silently skipped.
 */
export function scanForNewSecrets(path: string, base: string, tree: string, maxBytes = MAX_SCAN_BYTES): SecretScan {
  // Raw output names both sides' blobs, so content is read by object id and file names
  // that are not valid UTF-8 (or contain newlines) are still scanned.
  const fields = git(path, ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', '--ignore-submodules=none', base, tree]).split('\0');
  const entries: ScanEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, , before, after] = (fields[index] ?? '').split(' ');
    const file = fields[index + 1] ?? '';
    if (!after || !OBJECT_ID.test(after) || /^0+$/.test(after)) continue;
    entries.push({ path: file, after, ...(before && OBJECT_ID.test(before) && !/^0+$/.test(before) ? { before } : {}) });
  }
  return scanEntries(path, entries, maxBytes);
}

/**
 * New credential-looking strings anywhere in the history from `base` to `head`: every
 * file version any of those commits introduced, including ones a later commit removed
 * again (their content stays in history), and each commit's own message and
 * author/committer fields, which a push publishes too (reported as `commit <id>`).
 * Each object is read once, under the same budget as `scanForNewSecrets`.
 */
export function scanHistoryForNewSecrets(path: string, base: string, head = 'HEAD', maxBytes = MAX_SCAN_BYTES): SecretScan {
  // "<id>" for every commit and "<id> <path>" for every tree and blob reachable from
  // head but not from base.
  const entries: ScanEntry[] = [];
  for (const line of git(path, ['rev-list', '--objects', `${base}..${head}`]).split('\n')) {
    const match = /^([0-9a-f]{40,64})(?: (.*))?$/.exec(line);
    if (!match) continue;
    const [, id, file] = match as unknown as [string, string, string | undefined];
    if (file === undefined) entries.push({ path: `commit ${id.slice(0, 12)}`, after: id, type: 'commit' });
    else if (file) entries.push({ path: file, after: id, ...(/[\r\n]/.test(file) ? {} : { before: `${base}:${file}` }) });
  }
  return scanEntries(path, entries, maxBytes);
}

interface WorktreeLayout { gitDir: string; commonDir: string; topLevel: string }

function worktreeLayout(path: string): WorktreeLayout | undefined {
  const paths = git(path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']).trim().split(/\r?\n/);
  // Git older than 2.31 echoes the unknown --path-format flag back as an extra
  // line, so anything but exactly three absolute paths fails closed.
  if (paths.length !== 3 || !paths.every((item) => isAbsolute(item))) return undefined;
  const [gitDir, commonDir, topLevel] = paths.map((item) => resolve(item)) as [string, string, string];
  return { gitDir, commonDir, topLevel };
}

/**
 * Why a recorded agent worktree must be kept, or undefined when removing it loses
 * nothing: it is a linked worktree strictly under the Code Conductor root (after
 * resolving symlinks), it has exactly its own `cc/` agent branch checked out, so every
 * commit in it stays reachable from that branch, and its content matches that
 * branch's head exactly (content-exact, not git status alone). Runs Git in the worktree.
 */
export function agentWorktreeRemovalProblem(path: string, root: string, branch: string): string | undefined {
  let real: string;
  let realRoot: string;
  try { real = realpathSync(path); realRoot = realpathSync(root); } catch { return 'it does not exist'; }
  const offset = relative(realRoot, real);
  if (!offset || offset.startsWith('..') || isAbsolute(offset)) return 'it is not under the Code Conductor worktree root';
  if (!branch.startsWith('cc/')) return `${branch} is not a Code Conductor agent branch`;
  const layout = worktreeLayout(real);
  if (!layout) return 'its Git worktree layout could not be determined (Git 2.31 or later is required)';
  if (layout.gitDir === layout.commonDir) return 'it is a repository\'s primary working tree';
  if (realpathSync(layout.topLevel) !== real) return 'it is not the top level of a Git worktree';
  const head = git(real, ['symbolic-ref', '-q', 'HEAD'], true).trim();
  if (head !== `refs/heads/${branch}`) return `it has ${head || 'a detached HEAD'} checked out, not ${branch}, so its commits may be on no branch`;
  // Checking content would run Git inside them, under configuration an agent could have written.
  const nested = nestedRepositories(real);
  if (nested.length) return `it contains ${nested.length === 1 ? 'a nested Git repository' : `${nested.length} nested Git repositories`} (${nested.slice(0, 3).join(', ')}${nested.length > 3 ? ', …' : ''}), which Code Conductor runs no Git in; inspect ${nested.length === 1 ? 'it' : 'them'} yourself`;
  if (gitChangedFiles(real).length || workingTreeState(real).tree !== headTree(real)) return 'it has uncommitted changes';
  return undefined;
}

/**
 * Remove an agent worktree that `agentWorktreeRemovalProblem` finds nothing to keep in.
 * Its branch, and so its commits, are kept. Ignored files in it (for example a local
 * `.env` or build output) are deleted with it, as `git worktree remove` does. Other
 * worktrees' registrations are never pruned.
 */
export function removeCleanAgentWorktree(path: string, root: string, branch: string): void {
  const problem = agentWorktreeRemovalProblem(path, root, branch);
  if (problem) throw new Error(`Refusing to remove ${path}: ${problem}.`);
  const real = realpathSync(path);
  // Run from the common Git directory, which also works for --separate-git-dir and
  // bare repositories with linked worktrees.
  git(worktreeLayout(real)!.commonDir, ['worktree', 'remove', real]);
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
  const layout = worktreeLayout(handle.path);
  if (!layout) refuse('could not determine its Git worktree layout (Git 2.31 or later is required).');
  const { gitDir, commonDir, topLevel } = layout!;
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

/** Paths that are gitlinks (nested repositories) in `toTree` and were not, or pointed elsewhere, in `from`. */
export function newGitlinks(path: string, from: string, toTree: string): string[] {
  const fields = git(path, ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', '--ignore-submodules=none', from, toTree]).split('\0');
  const links: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) if ((fields[index] ?? '').split(' ')[1] === '160000') links.push(fields[index + 1] ?? '');
  return links.sort();
}

export interface CommitHistory { commits: string[]; files: string[] }

/**
 * Commits on `head` since `base`, newest first, and every path any of them touched,
 * including paths a later commit removed again (their content stays in history).
 */
export function commitsSince(path: string, base: string, head = 'HEAD'): CommitHistory {
  const commits = git(path, ['rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
  if (!commits.length) return { commits, files: [] };
  const files = git(path, ['log', '-z', '--format=', '--name-only', '--no-renames', '-m', '--ignore-submodules=none', '--no-show-signature', `${base}..${head}`]).split('\0').filter(Boolean);
  return { commits, files: [...new Set(files)].sort() };
}

/**
 * The commit a branch names, looked up by its exact ref: `rev-parse refs/heads/<branch>`
 * alone also accepts near matches such as `refs/tags/refs/heads/<branch>`. Undefined when
 * the branch does not exist or names no commit.
 */
export function branchCommit(path: string, branch: string): string | undefined {
  const ref = git(path, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], true).trim();
  return (ref && git(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], true).trim()) || undefined;
}

export interface WorktreeTips {
  /** The commit HEAD names; undefined for an unborn or orphan HEAD. */
  head?: string;
  /** The ref HEAD is on; undefined when HEAD is detached. */
  headRef?: string;
  /** The commit the agent branch names (see `branchCommit`). */
  branch?: string;
}

/** Where an agent worktree's history ends: HEAD, and the agent's own branch. */
export function worktreeTips(path: string, branch: string): WorktreeTips {
  const head = git(path, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], true).trim();
  const headRef = git(path, ['symbolic-ref', '-q', 'HEAD'], true).trim();
  const tip = branchCommit(path, branch);
  return { ...(head ? { head } : {}), ...(headRef ? { headRef } : {}), ...(tip ? { branch: tip } : {}) };
}

/**
 * A remote URL for display: no user name, password, token, query or fragment. A URL
 * that cannot be parsed keeps nothing before its last `@`, so nothing that might be a
 * credential is shown, and one that also spans lines is not shown at all. Credential-
 * looking strings anywhere else are redacted too.
 */
export function redactUrl(url: string): string {
  let text: string;
  try {
    const parsed = new URL(url);
    // `user:secret@host:path` parses as an opaque URL with scheme `user:`; only a URL with
    // an authority has user information that can be removed field by field.
    if (!parsed.host) throw new Error('no authority');
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    text = parsed.toString();
  } catch {
    // A line break would hide a query from the `$` below, or an earlier line's credential
    // from the `@` strip, and makes that replace quadratic: show nothing.
    if (/[\n\r\u2028\u2029]/.test(url)) return '[redacted]';
    text = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)?.*@/i, (_, scheme: string | undefined) => `${scheme ?? ''}[redacted]@`);
    // Cut the query and fragment at the first marker, by index: linear whatever the input.
    const cut = [text.indexOf('?'), text.indexOf('#')].filter((index) => index >= 0);
    if (cut.length) text = text.slice(0, Math.min(...cut));
  }
  return redactSecrets(text).text;
}

/**
 * Where a remote fetches from, and every URL a push to it goes to, after the person's own
 * URL rewriting. A push goes to all of a remote's push URLs (or all of its URLs when it
 * has none), so every one of them is listed.
 */
export function remoteUrls(path: string, remote: string): { fetch: string; push: string[] } {
  return {
    fetch: git(path, ['remote', 'get-url', '--', remote]).trim(),
    push: git(path, ['remote', 'get-url', '--push', '--all', '--', remote]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

/** Transports a push may use; GIT_ALLOW_PROTOCOL overrides any protocol.* configuration. */
export const PUSH_PROTOCOLS = ['https', 'ssh'] as const;

/**
 * Push exactly `sha` to `refs/heads/<branch>` on `remote`, and nothing else: no tags
 * (push.followTags), no submodules (push.recurseSubmodules), never forced, so a remote
 * branch with other history is rejected. Only the HTTPS and SSH transports are allowed,
 * so no remote helper, local or `ext::` transport runs. Repository hooks such as
 * pre-push do not run (every Code Conductor git call disables them). Credentials are
 * the person's own Git configuration; Code Conductor never sees them.
 */
export function pushCommit(path: string, remote: string, sha: string, branch: string, protocols: readonly string[] = PUSH_PROTOCOLS): void {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`Refusing to push ${sha}: not a full commit SHA.`);
  try { git(path, ['check-ref-format', `refs/heads/${branch}`]); } catch { throw new Error(`Refusing to push to invalid branch name ${branch}.`); }
  git(path, ['push', '--porcelain', '--no-follow-tags', '--no-recurse-submodules', '--', remote, `${sha}:refs/heads/${branch}`], false, { ...withoutGitLocalEnv(), GIT_ALLOW_PROTOCOL: protocols.join(':') });
}

/**
 * Whether `commit` is reachable from a remote-tracking branch of `remote`, as of its last
 * fetch: if it is not, a push of anything descending from it also publishes it and its
 * unpublished ancestors.
 */
export function onRemote(path: string, commit: string, remote: string): boolean {
  return !git(path, ['rev-list', '-n', '1', commit, '--not', `--remotes=${remote}`]).trim();
}

/** Whether `ancestor` is reachable from `descendant` (for example base from an agent's HEAD). */
export function isAncestor(path: string, ancestor: string, descendant = 'HEAD'): boolean {
  const result = runGit(path, ['merge-base', '--is-ancestor', ancestor, descendant], { encoding: 'utf8' });
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw new Error(`git merge-base --is-ancestor failed: ${result.stderr || result.error?.message || `exit ${String(result.status)}`}`);
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

/** Where Code Conductor creates agent worktrees unless a caller chooses otherwise. */
export function defaultWorktreeRoot(): string {
  // Absolute, so a relative CODE_CONDUCTOR_HOME cannot place worktrees inside the
  // repository Git runs in.
  return resolve(process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'worktrees');
}

export class WorktreeManager {
  readonly root: string;

  constructor(root = defaultWorktreeRoot()) {
    this.root = resolve(root);
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
    // Absolute links: worktree.useRelativePaths=true would make Git enable
    // extensions.relativeWorktrees in the repository's own configuration. Older Git ignores it.
    git(repo, ['-c', 'worktree.useRelativePaths=false', 'worktree', 'add', '-b', branch, path, baseSha]);
    chmodSync(path, 0o700);
    return { repositoryRoot: repo, path, branch, baseRef, baseSha, taskId, agentId };
  }

  remove(handle: WorktreeHandle, deleteBranch = false, force = false): void {
    if (!force && gitChangedFiles(handle.path).length) {
      throw new Error(`Refusing to remove dirty worktree: ${handle.path}`);
    }
    // `worktree remove` deletes this worktree's own registration; a prune would also drop
    // other worktrees whose directories are only temporarily missing.
    git(handle.repositoryRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), handle.path]);
    if (deleteBranch) git(handle.repositoryRoot, ['branch', '-D', handle.branch]);
  }
}
