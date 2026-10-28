import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, opendirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { conductorHome, conductorTempDirectory } from '@code-conductor/core/home';
import { absolutePathEnvironment, resolveExecutable, runIsolated, type BoundedRunOutcome } from '@code-conductor/core/processes';
import { readCheckedFile, requireDescriptorLocation } from '@code-conductor/context-optimizer/checked-read';

const PIN = '16f41836d65cbf79070ecdb2ef835c78c57b6ae6';
/** Reviewed catalog, not an arbitrary URL or floating-ref input. */
export const PREVIEW_PACKS = ['typescript-distinguished-engineer-pack', 'github-expert-engineer-pack'] as const;
export type PreviewPack = typeof PREVIEW_PACKS[number];
const reference = (name: string) => `hybridcloudworks/Proj-AgentPacks/${name}#${PIN}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const LIMIT = 1024 * 1024;
const TOTAL = 16 * LIMIT;
const FILES = 1000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface ProjectionChange {
  path: string;
  operation: 'add' | 'replace' | 'remove' | 'unchanged' | 'blocked';
  beforeSha256?: string;
  afterSha256?: string;
  before?: string;
  after?: string;
  conflict?: string;
}
export interface ProjectionPreview {
  repository: string;
  target: 'codex';
  packs: string[];
  stagedLockSha256: string;
  previousLockSha256?: string;
  changes: ProjectionChange[];
  digest: string;
  /** Present only after this adapter actually ran a successful staged native audit. */
  audit?: { status: 0; outputSha256: string };
  /** Deliberately not install approval: metadata merging and deployment are separate. */
  scope: 'selected-pack-projections-only';
}

function yaml(text: string): Record<string, unknown> {
  const parsed = parseDocument(text, { logLevel: 'silent' });
  if (parsed.errors.length || parsed.warnings.length) throw new Error('Unsupported APM metadata.');
  const value: unknown = parsed.toJS({ maxAliasCount: 10 });
  if (!object(value)) throw new Error('Unsupported APM metadata.');
  return value;
}
function safePath(path: string): boolean {
  return path.length < 500 && !path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.split('/').some((part) => !part || part === '.' || part === '..')
    && (/^\.codex\/agents\/[a-zA-Z0-9_-]+\.toml$/.test(path) || /^\.agents\/skills\/[a-zA-Z0-9_/-]+\.md$/.test(path));
}
function canonicalRoot(root: string): string {
  if (!isAbsolute(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Select an existing local directory.');
  return realpathSync(root);
}
/** No symlink traversal, including intermediate path components. */
function read(root: string, path: string, budget: { bytes: number }): string | undefined {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || (current !== join(root, path) && !stat.isDirectory())) throw new Error('Unsafe projection location.');
  }
  if (budget.bytes < LIMIT) throw new Error('Projection read budget exceeded.');
  budget.bytes -= LIMIT;
  const text = readCheckedFile(join(root, path), path, LIMIT);
  // Charge failures at the reservation; refund successful reads to their actual size.
  if (text.includes('\ufffd')) throw new Error('Unsupported projection encoding.');
  budget.bytes += LIMIT - Buffer.byteLength(text);
  return text;
}
interface Lock { text?: string; selected: Map<string, string>; other: Set<string> }
function lock(root: string, selected: readonly string[], budget: { bytes: number }, required: boolean): Lock {
  const text = read(root, 'apm.lock.yaml', budget);
  const result: Lock = { text, selected: new Map(), other: new Set() };
  if (!text) { if (required) throw new Error('APM did not produce a lock.'); return result; }
  const value = yaml(text);
  if (value.lockfile_version !== '1' || value.apm_version !== '0.33.0' || !Array.isArray(value.dependencies) || value.dependencies.length > FILES) throw new Error('Unsupported APM lock.');
  const seen = new Set<string>();
  for (const entry of value.dependencies) {
    if (!object(entry) || typeof entry.virtual_path !== 'string' || seen.has(entry.virtual_path)) throw new Error('Ambiguous APM lock.');
    seen.add(entry.virtual_path);
    const chosen = selected.includes(entry.virtual_path);
    if (chosen && (entry.host !== 'github.com' || typeof entry.repo_url !== 'string' || entry.repo_url.toLowerCase() !== 'hybridcloudworks/proj-agentpacks' || typeof entry.materialization_repo_url !== 'string' || entry.materialization_repo_url.toLowerCase() !== 'hybridcloudworks/proj-agentpacks' || typeof entry.resolved_commit !== 'string' || !/^[a-f0-9]{40}$/.test(entry.resolved_commit) || (required && entry.resolved_commit !== PIN))) throw new Error('Unreviewed APM source.');
    hashes(entry.deployed_file_hashes, chosen ? result.selected : result.other, required);
    if (chosen) {
      if (!Array.isArray(entry.deployed_files) || entry.deployed_files.length > FILES || entry.deployed_files.some((path: unknown) => typeof path !== 'string')) throw new Error('Unsupported recorded projections.');
      for (const path of entry.deployed_files as string[]) if (safePath(path) && !result.selected.has(path)) throw new Error('Recorded projection lacks a content hash.');
    } else recordedPaths(entry.deployed_files, result.other);
  }
  hashes(value.local_deployed_file_hashes, result.other);
  recordedPaths(value.local_deployed_files, result.other);
  if (value.deployments !== undefined) {
    if (!Array.isArray(value.deployments) || value.deployments.length > FILES) throw new Error('Unsupported deployment ownership.');
    const identities = selected.map((pack) => `hybridcloudworks/proj-agentpacks/${pack}`);
    for (const deployment of value.deployments) {
      if (!object(deployment)) throw new Error('Unsupported deployment ownership.');
      if (deployment.kind !== 'project-relative' || typeof deployment.value !== 'string' || !safePath(deployment.value)) continue;
      if (!Array.isArray(deployment.owners) || !deployment.owners.length || deployment.owners.some((owner: unknown) => typeof owner !== 'string' || !identities.includes(owner.toLowerCase()))) result.other.add(deployment.value);
    }
  }
  if (required && (seen.size !== selected.length || selected.some((pack) => !seen.has(pack)))) throw new Error('Unexpected staged dependencies.');
  if (result.selected.size + result.other.size > FILES) throw new Error('Projection count exceeded.');
  return result;
}
function recordedPaths(value: unknown, output: Set<string>): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > FILES || value.some((path: unknown) => typeof path !== 'string')) throw new Error('Unsupported recorded ownership.');
  for (const path of value as string[]) if (safePath(path)) output.add(path);
}
function hashes(value: unknown, output: Map<string, string> | Set<string>, strict = false): void {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).length > FILES) throw new Error('Unsupported projection hashes.');
  for (const [path, hash] of Object.entries(value)) {
    // Other targets are outside this Codex comparison; never infer their removal.
    if (!safePath(path)) { if (strict) throw new Error('Unsupported selected projection path.'); continue; }
    if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error('Unsupported projection hash.');
    if (output instanceof Map) {
      if (output.has(path) && output.get(path) !== hash.slice(7)) throw new Error('Conflicting projection owners.');
      output.set(path, hash.slice(7));
    } else output.add(path);
  }
}
/** Compare only reviewed Codex pack projections. Neither directory is written. */
export function comparePackProjections(repository: string, staged: string, selected: readonly PreviewPack[]): ProjectionPreview {
  requireDescriptorLocation('APM projection preview');
  const root = canonicalRoot(repository); const stage = canonicalRoot(staged);
  const budget = { bytes: TOTAL };
  const before = lock(root, selected, budget, false); const after = lock(stage, selected, budget, true);
  // Refuse unrecorded/extra generated files, rather than silently omitting a side effect.
  let count = 0;
  function walk(directory: string, prefix = '', depth = 0): void {
    if (depth > 10) throw new Error('Staged projection depth exceeded.');
    const dir = opendirSync(directory, { bufferSize: 16 });
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > 2000) throw new Error('Staged entry count exceeded.');
        const path = prefix + entry.name;
        if (!prefix && entry.name === 'apm_modules' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.isSymbolicLink()) throw new Error('Staged symlinks are unsupported.');
        if (entry.isDirectory()) walk(join(directory, entry.name), path + '/', depth + 1);
        else if (!entry.isFile() || (!['apm.yml', 'apm.lock.yaml', 'apm-policy.yml', '.gitignore'].includes(path) && !after.selected.has(path))) throw new Error('Unexpected staged output.');
      }
    } finally { dir.closeSync(); }
  }
  walk(stage);
  const changes: ProjectionChange[] = [];
  const paths = [...new Set([...before.selected.keys(), ...after.selected.keys()])].sort();
  for (const path of paths) {
    // A retained package/local primitive still owns a removed selected-pack path.
    if (!after.selected.has(path) && before.other.has(path)) continue;
    let existing: string | undefined;
    try { existing = read(root, path, budget); } catch { changes.push({ path, operation: 'blocked', conflict: 'Local file cannot be compared safely.' }); continue; }
    const next = after.selected.has(path) ? read(stage, path, budget) : undefined;
    if (after.selected.has(path) && (next === undefined || digest(next) !== after.selected.get(path))) throw new Error('Staged projection does not match its native lock hash.');
    const beforeSha256 = existing === undefined ? undefined : digest(existing);
    const afterSha256 = next === undefined ? undefined : digest(next);
    const conflict = existing !== undefined && beforeSha256 !== afterSha256 && (!before.selected.has(path) || before.selected.get(path) !== beforeSha256 || before.other.has(path));
    changes.push({ path, operation: beforeSha256 === afterSha256 ? 'unchanged' : conflict ? 'blocked' : next === undefined ? 'remove' : existing === undefined ? 'add' : 'replace', ...(beforeSha256 ? { beforeSha256, before: existing } : {}), ...(afterSha256 ? { afterSha256, after: next } : {}), ...(conflict ? { conflict: 'Existing instructions are modified, unmanaged or shared with a retained owner.' } : {}) });
  }
  const snapshot = { repository: root, target: 'codex' as const, packs: selected.map(reference), stagedLockSha256: digest(after.text!), ...(before.text ? { previousLockSha256: digest(before.text) } : {}), changes, scope: 'selected-pack-projections-only' as const };
  return { ...snapshot, digest: digest(JSON.stringify(snapshot)) };
}

/** Minimal environment: no inherited provider, Git, lifecycle or loader credentials/config. */
function previewEnvironment(stage: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: absolutePathEnvironment().PATH, LANG: 'C.UTF-8', APM_NO_SCRIPTS: '1', APM_NON_INTERACTIVE: '1', APM_HOME: join(stage, 'apm-home'), APM_CACHE_DIR: join(stage, 'cache'), TMPDIR: join(stage, 'temp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  // Preserve the caller's home selector so Python and Node resolve the same hidden home.
  if (process.env.HOME) environment.HOME = process.env.HOME;
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}
function succeeded(result: BoundedRunOutcome): boolean { return result.status === 0 && !result.timedOut && !result.truncated; }
function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep);
}
/** Resolve existing ancestry without creating the missing private directories. */
function prospectiveCanonical(path: string): string {
  const suffix: string[] = [];
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}

/** Explicit network operation in a read-only filesystem sandbox; never touches the selected repository. */
export async function previewPacks(repository: string, selected: readonly PreviewPack[]): Promise<ProjectionPreview> {
  requireDescriptorLocation('APM projection preview');
  const root = canonicalRoot(repository);
  if (!selected.length || selected.length > PREVIEW_PACKS.length || new Set(selected).size !== selected.length || selected.some((pack) => !PREVIEW_PACKS.includes(pack))) throw new Error('Select reviewed packs from the fixed catalog.');
  const apm = resolveExecutable('apm').path; const bwrap = resolveExecutable('bwrap').path;
  if (!apm || !bwrap) throw new Error('Preview requires APM 0.33.0 and bubblewrap on absolute PATH entries.');
  // Reject before conductorTempDirectory creates or chmods anything, including
  // existing symlink ancestry and child names beginning with two dots.
  if (inside(root, prospectiveCanonical(join(conductorHome(), 'tmp')))) throw new Error('Private staging must be outside the selected repository.');
  const scratch = realpathSync(conductorTempDirectory('cc-apm-preview-'));
  const stage = join(scratch, 'project');
  // Bubblewrap binds must not accidentally grant write access to a selected repository.
  if (inside(root, scratch)) { rmSync(scratch, { recursive: true, force: true }); throw new Error('Private staging must be outside the selected repository.'); }
  try {
    for (const name of ['project', 'apm-home', 'cache', 'temp']) mkdirSync(join(scratch, name), { mode: 0o700 });
    writeFileSync(join(stage, 'apm.yml'), stringify({ name: 'code-conductor-pack-preview', version: '0.1.0', description: 'Isolated selected-pack projection comparison', author: 'Code Conductor', license: 'Apache-2.0', targets: ['codex'], dependencies: { apm: selected.map(reference), mcp: [] }, executables: { allow: {} }, compilation: { source_attribution: true } }), { mode: 0o600 });
    writeFileSync(join(stage, 'apm-policy.yml'), 'name: code-conductor-preview\nversion: "1"\nenforcement: block\nfetch_failure: block\ndependencies:\n  require_pinned_constraint: true\ncompilation:\n  source_attribution: true\nsecurity:\n  integrity:\n    require_hashes: true\n  audit:\n    fail_on_drift: true\n', { mode: 0o600 });
    const sandbox = ['--ro-bind', '/', '/', '--tmpfs', homedir(), '--bind', scratch, scratch, '--unshare-user', '--unshare-pid', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--chdir', stage, '--', apm];
    const execute = (args: string[], timeoutMs: number) => runIsolated(bwrap, [...sandbox, ...args], { cwd: stage, env: previewEnvironment(scratch), timeoutMs, maxBytes: LIMIT });
    const version = await execute(['--version'], 5000);
    if (!succeeded(version) || !/(?:^|\s)0\.33\.0(?:\s|$)/.test(version.stdout.trim())) throw new Error('Sandbox unavailable or APM version is not 0.33.0. No repository files were changed.');
    const install = await execute(['install', '--only', 'apm', '--no-trust-bin', '--target', 'codex'], 600000);
    if (!succeeded(install)) throw new Error(`Staged APM materialization failed${install.timedOut ? ' (timeout)' : install.truncated ? ' (output limit)' : ''}. No repository files were changed.`);
    const audit = await execute(['audit', '--ci', '--policy', './apm-policy.yml', '--no-fail-fast'], 120000);
    if (!succeeded(audit)) throw new Error('Staged APM audit failed. No repository files were changed.');
    const comparison = comparePackProjections(root, stage, selected);
    const snapshot = { ...comparison, audit: { status: 0 as const, outputSha256: audit.sha256 } };
    return { ...snapshot, digest: digest(JSON.stringify({ ...snapshot, digest: undefined })) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
