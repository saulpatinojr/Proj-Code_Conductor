import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, opendirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { isSensitiveRepositoryPath, redactSecrets, githubOriginRepository } from '@code-conductor/git';
import { readCheckedFile, requireDescriptorLocation } from '@code-conductor/context-optimizer/checked-read';

const KINDS = ['project', 'repository', 'decision', 'issue', 'pr', 'agent', 'skill', 'pack', 'task', 'run', 'evidence', 'lesson'];
const EDGES = ['depends_on', 'uses', 'implements', 'decided_by', 'validated_by', 'related_to'];
export interface VaultConnection { vault: string; folder: string; repository: string }
export interface KnowledgeSource { kind: 'file' | 'issue' | 'pr' | 'run'; path?: string; sha256?: string; id?: string; state: 'locally_matched' | 'stale' | 'broken' | 'unverified' }
export interface KnowledgeNote { id: string; kind: string; title: string; path: string; sha256: string; observedAt: string; sources: KnowledgeSource[]; edges: { kind: string; target: string; source: number; state: KnowledgeSource['state'] }[] }
export interface KnowledgeIndex { notes: KnowledgeNote[]; diagnostics: string[]; limited: boolean }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function plain(value: unknown, max = 200): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value); }
function within(root: string, candidate: string): boolean { const offset = relative(root, candidate); return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset)); }
function forbiddenLocation(path: string): boolean {
  const absolute = resolve(path);
  if (absolute.split(/[\\/]+/).some((part) => part.startsWith('.') || isSensitiveRepositoryPath(part))) return true;
  const home = process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor');
  let runRoot = resolve(home, 'runs');
  try { runRoot = realpathSync(runRoot); } catch { /* absent state is still excluded by its resolved path */ }
  return within(runRoot, absolute);
}
function sensitiveText(text: string): boolean {
  return !!redactSecrets(text).redacted || /\b(?:password|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"'<>]+/i.test(text);
}
function safeRelative(path: string): boolean { return !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && path.split('/').every((part) => !!part && !part.startsWith('.') && !isSensitiveRepositoryPath(part)); }
function safeCanonical(root: string, path: string): string {
  if (!safeRelative(path) || forbiddenLocation(resolve(root, path))) throw new Error('Unsafe knowledge path.');
  let candidate = root;
  for (const part of path.split('/')) {
    candidate = join(candidate, part);
    if (lstatSync(candidate).isSymbolicLink()) throw new Error('Symlinks are excluded.');
  }
  const canonical = realpathSync(candidate);
  if (!within(root, canonical) || canonical !== resolve(root, path)) throw new Error('Knowledge path escaped its scope.');
  return canonical;
}
export function validateConnection(connection: VaultConnection): VaultConnection {
  requireDescriptorLocation('knowledge vault');
  if (![connection.vault, connection.repository].every((path) => typeof path === 'string' && isAbsolute(path)) || !plain(connection.folder, 500)) throw new Error('Select a local vault, contained folder and repository.');
  if (lstatSync(connection.vault).isSymbolicLink()) throw new Error('Symlinked vaults are excluded.');
  const vault = realpathSync(connection.vault); const repository = realpathSync(connection.repository);
  if (forbiddenLocation(vault) || forbiddenLocation(repository)) throw new Error('Private state is not a knowledge vault.');
  const folder = safeCanonical(vault, connection.folder);
  if (!lstatSync(folder).isDirectory()) throw new Error('Choose a contained vault folder.');
  return { vault, repository, folder: relative(vault, folder).split('\\').join('/') };
}
function checkSource(value: unknown, readSource: (path: string, hash: string) => KnowledgeSource['state'], githubRepository: () => string | undefined): KnowledgeSource {
  if (!record(value) || Object.keys(value).some((key) => !['kind', 'path', 'sha256', 'id'].includes(key))) throw new Error('Unsupported source.');
  if (value.kind === 'file' && plain(value.path, 500) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) {
    if (!safeRelative(value.path)) throw new Error('Unsafe source path.');
    const state = readSource(value.path, value.sha256);
    return { kind: 'file', path: value.path, sha256: value.sha256, state };
  }
  if (typeof value.kind === 'string' && ['issue', 'pr'].includes(value.kind) && plain(value.id) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,9}$/.test(value.id) && value.id.split('#')[0]!.toLowerCase() === githubRepository()) return { kind: value.kind as 'issue' | 'pr', id: value.id, state: 'unverified' };
  if (value.kind === 'run' && plain(value.id, 160) && /^[A-Za-z0-9_-]+$/.test(value.id)) return { kind: 'run', id: value.id, state: 'unverified' };
  throw new Error('Unsupported source.');
}
function note(text: string, path: string, repository: string, readSource: (path: string, hash: string) => KnowledgeSource['state'], githubRepository: () => string | undefined): KnowledgeNote | undefined {
  // Block likely credentials before parsing or producing any searchable metadata.
  if (sensitiveText(text)) throw new Error('Sensitive note excluded.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  if (Buffer.byteLength(match[1]!) > 8192) throw new Error('Frontmatter too large.');
  const parsed = parseDocument(match[1]!, { logLevel: 'silent' });
  if (parsed.errors.length || parsed.warnings.length) throw new Error('Unsupported frontmatter.');
  const metadata: unknown = parsed.toJS({ maxAliasCount: 10 });
  if (!record(metadata) || !record(metadata.code_conductor)) return undefined;
  const data = metadata.code_conductor;
  if (Object.keys(data).some((key) => !['version', 'id', 'kind', 'repository', 'sources', 'edges'].includes(key)) || data.version !== 1 || !plain(data.id, 80) || !/^[A-Za-z0-9_-]+$/.test(data.id) || (!plain(data.kind, 40) || !KINDS.includes(data.kind)) || !plain(data.repository, 1000)) throw new Error('Unsupported knowledge metadata.');
  if (!isAbsolute(data.repository) || realpathSync(data.repository) !== repository) return undefined;
  if (!Array.isArray(data.sources) || data.sources.length > 32 || !Array.isArray(data.edges) || data.edges.length > 32) throw new Error('Invalid knowledge relationships.');
  const sources = data.sources.map((source) => checkSource(source, readSource, githubRepository));
  const edges = data.edges.map((edge) => {
    if (!record(edge) || Object.keys(edge).some((key) => !['kind', 'target', 'source'].includes(key)) || (!plain(edge.kind, 40) || !EDGES.includes(edge.kind)) || !plain(edge.target, 80) || !/^[A-Za-z0-9_-]+$/.test(edge.target) || !Number.isSafeInteger(edge.source) || Number(edge.source) < 0 || Number(edge.source) >= sources.length) throw new Error('Invalid knowledge edge.');
    return { kind: String(edge.kind), target: edge.target, source: Number(edge.source), state: sources[Number(edge.source)]!.state };
  });
  return { id: data.id, kind: String(data.kind), title: basename(path, '.md'), path, sha256: digest(text), observedAt: new Date().toISOString(), sources, edges };
}

/** On-demand metadata only. No writes, provider context, network or persistent index. */
export function indexVault(input: VaultConnection): KnowledgeIndex {
  const connection = validateConnection(input);
  const root = safeCanonical(connection.vault, connection.folder);
  const result: KnowledgeIndex = { notes: [], diagnostics: [], limited: false };
  let entriesSeen = 0; let filesSeen = 0; let bytesSeen = 0;
  let identityLoaded = false; let identity: string | undefined;
  const githubRepository = (): string | undefined => {
    if (!identityLoaded) {
      identityLoaded = true;
      try {
        identity = githubOriginRepository(connection.repository);
      } catch { /* no selected-repository GitHub identity means no remote reference is accepted */ }
    }
    return identity;
  };
  const checkedText = (path: string, label: string): string => {
    const allowance = Math.min(65536, 4194304 - bytesSeen);
    if (allowance <= 0) { result.limited = true; throw new Error('Read budget exhausted.'); }
    // Reserve before reading: rejected/changed/invalid UTF-8 reads still consume budget.
    bytesSeen += allowance;
    const text = readCheckedFile(path, label, allowance);
    if (text.includes('\uFFFD')) throw new Error('Non-lossless UTF-8 text excluded.');
    bytesSeen -= allowance - Buffer.byteLength(text);
    return text;
  };
  const sourceHashes = new Map<string, string | undefined>();
  const readSource = (path: string, hash: string): KnowledgeSource['state'] => {
    if (!sourceHashes.has(path)) {
      let observed: string | undefined;
      try {
        if (bytesSeen >= 4194304) { result.limited = true; return 'unverified'; }
        const file = safeCanonical(connection.repository, path);
        const text = checkedText(file, 'knowledge source');
        if (sensitiveText(text)) throw new Error('Sensitive source excluded.');
        observed = digest(text);
      } catch { /* unavailable sources remain broken */ }
      sourceHashes.set(path, observed);
    }
    const observed = sourceHashes.get(path);
    return observed === undefined ? 'broken' : observed === hash ? 'locally_matched' : 'stale';
  };
  const visit = (directory: string, depth: number): void => {
    if (depth > 8) { result.limited = true; return; }
    const handle = opendirSync(directory, { bufferSize: 16 });
    try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++entriesSeen > 400 || filesSeen >= 200 || bytesSeen >= 4194304) { result.limited = true; return; }
      if (!plain(entry.name, 200) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = relative(connection.vault, join(directory, entry.name)).split('\\').join('/');
      try {
        if (redactSecrets(path).redacted) throw new Error('Sensitive path excluded.');
        const canonical = safeCanonical(connection.vault, path);
        if (entry.isDirectory()) { visit(canonical, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        filesSeen += 1;
        const text = checkedText(canonical, 'knowledge note');
        const parsed = note(text, path, connection.repository, readSource, githubRepository);
        if (parsed) result.notes.push(parsed);
      } catch { result.diagnostics.push('A note or directory was excluded by scope, format, sensitivity or read limits.'); }
    }
    } finally { handle.closeSync(); }
  };
  visit(root, 0);
  const duplicates = new Set(result.notes.filter((item, index, all) => all.findIndex((other) => other.id === item.id) !== index).map((item) => item.id));
  if (duplicates.size) { result.notes = result.notes.filter((item) => !duplicates.has(item.id)); result.diagnostics.push('Duplicate note identities were excluded.'); }
  result.notes.sort((a, b) => a.path.localeCompare(b.path));
  const identities = new Set(result.notes.map((item) => item.id));
  for (const item of result.notes) for (const edge of item.edges) if (!identities.has(edge.target)) edge.state = 'broken';
  if (bytesSeen >= 4194304) result.limited = true;
  if (result.limited) result.diagnostics.push('Knowledge scan limit reached; narrow the selected folder.');
  return result;
}
export function resolveKnowledgeNote(connection: VaultConnection, selected: KnowledgeNote): string {
  const current = indexVault(connection).notes.find((item) => item.id === selected.id && item.path === selected.path);
  if (!current || current.sha256 !== selected.sha256 || JSON.stringify(current.sources) !== JSON.stringify(selected.sources) || JSON.stringify(current.edges) !== JSON.stringify(selected.edges)) throw new Error('The note changed, moved or is no longer in scope. Refresh knowledge.');
  return safeCanonical(realpathSync(connection.vault), current.path);
}
export function obsidianOpenUri(absolutePath: string): string {
  if (!plain(absolutePath, 4096)) throw new Error('Invalid note path.');
  if (!isAbsolute(absolutePath) && !/^[A-Za-z]:[\\/]/.test(absolutePath)) throw new Error('An absolute note path is required.');
  // VS Code's external opener decodes then re-encodes URIs. Reserved query
  // characters would become parameters or change meaning; use the editor instead.
  if (/[&#?%+=;]/.test(absolutePath)) throw new Error('Use the native editor for this note path.');
  return `obsidian://open?path=${encodeURIComponent(absolutePath)}`;
}
