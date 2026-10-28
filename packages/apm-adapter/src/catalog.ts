import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { rcompare, valid } from 'semver';
import { EnvHttpProxyAgent, request } from 'undici';
import { parseDocument } from 'yaml';
import { packInventory } from './pack-state.js';

export const CATALOG_MIRROR = 'hybridcloudworks/Proj-AgentPacks';
export const CATALOG_SOURCE = 'saulpatinojr/Proj-Agent_Packs';
const API = `https://api.github.com/repos/${CATALOG_MIRROR}`;
const SHA = /^[a-f0-9]{40}$/;
const PACK = /^[a-z0-9][a-z0-9-]{0,99}-pack$/;
const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 10;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /^[0-9]/.test(value) && value.trim() === value && !!valid(value);

export interface InstalledCatalogVersion { mirror: string; path: string; version: string; commit: string }
export interface CatalogVersion extends InstalledCatalogVersion {
  id: string;
  tag: string;
  reference: string;
  locallyPresent: boolean;
  trust: 'candidate';
}
export interface PackCatalog {
  version: 1;
  mirror: string;
  canonicalSource: string;
  catalogCommit: string;
  manifestSha256: string;
  manifestBlobSha: string;
  observedAt: string;
  complete: boolean;
  versions: CatalogVersion[];
  diagnostics: string[];
}
export interface CatalogSelection extends CatalogVersion {
  name: string;
  description: string;
  declaredTargets: string[];
  packageManifestSha256: string;
  packageManifestBlobSha: string;
  catalogCommit: string;
  catalogManifestSha256: string;
  /** Publisher-declared targets are not proof of native runtime binding or authority. */
  runtimeEligibility: 'unverified';
}
export type CatalogRequest = (path: string, signal: AbortSignal) => Promise<unknown>;
export interface CatalogOptions { signal?: AbortSignal; request?: CatalogRequest; now?: () => Date }
export class CatalogError extends Error {}
const invalid = () => new CatalogError('Canonical catalog metadata is unsupported or inconsistent. No package was installed.');

/** Compound identity: multiple independent packs can share one release commit. */
export function catalogVersionId(value: InstalledCatalogVersion): string {
  if (!object(value) || typeof value.mirror !== 'string' || value.mirror.toLowerCase() !== CATALOG_MIRROR.toLowerCase() || typeof value.path !== 'string' || !PACK.test(value.path) || !version(value.version) || typeof value.commit !== 'string' || !SHA.test(value.commit)) throw invalid();
  return `${CATALOG_MIRROR.toLowerCase()}/${value.path}@${value.version}#${value.commit}`;
}
function document(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
  const parsed = parseDocument(text, { logLevel: 'silent' });
  if (parsed.errors.length || parsed.warnings.length) throw invalid();
  const value: unknown = parsed.toJS({ maxAliasCount: 10 });
  if (!object(value)) throw invalid();
  return value;
}
/** Verify the GitHub content envelope and Git blob identity before interpreting YAML. */
function content(value: unknown, path: string): { text: string; blob: string; sha256: string } {
  if (!object(value) || value.type !== 'file' || value.path !== path || value.encoding !== 'base64' || typeof value.content !== 'string' || value.content.length > 2 * MAX_BYTES || typeof value.sha !== 'string' || !SHA.test(value.sha) || !Number.isSafeInteger(value.size) || (value.size as number) > MAX_BYTES || (value.size as number) < 0) throw invalid();
  const encoded = value.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== value.size || bytes.toString('base64') !== encoded || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== value.sha) throw invalid();
  try { return { text: utf8.decode(bytes), blob: value.sha, sha256: createHash('sha256').update(bytes).digest('hex') }; } catch { throw invalid(); }
}
function catalogPaths(text: string): Set<string> {
  const value = document(text);
  if (!object(value.dependencies) || !Array.isArray(value.dependencies.apm) || value.dependencies.apm.length > 1000) throw invalid();
  const paths = new Set<string>();
  for (const ref of value.dependencies.apm) {
    if (typeof ref !== 'string' || ref.length > 300) throw invalid();
    const prefix = `${CATALOG_MIRROR}/`;
    if (ref.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) throw invalid();
    const [path, target, ...extra] = ref.slice(prefix.length).split('#');
    if (!path || !PACK.test(path) || !target || extra.length || paths.has(path)) throw invalid();
    const tagPrefix = path.slice(0, -5) + '-v';
    if (!SHA.test(target) && (!target.startsWith(tagPrefix) || !version(target.slice(tagPrefix.length)))) throw invalid();
    paths.add(path);
  }
  return paths;
}

function publicTransport(): { request: CatalogRequest; close(): Promise<void> } {
  // Standard client honors inherited proxy/no-proxy and TLS trust; never disable TLS
  // or collect native-client credentials for this public metadata operation.
  let dispatcher: EnvHttpProxyAgent;
  try { dispatcher = new EnvHttpProxyAgent(); }
  catch { throw new CatalogError('Catalog proxy configuration is unsupported. No package was installed.'); }
  return {
    request: async (path, signal) => {
      if (!/^\/(?:git\/ref\/heads\/main|tags\?per_page=100&page=[1-9][0-9]?|contents\/[a-zA-Z0-9_./-]+\?ref=[a-f0-9]{40})$/.test(path) || path.includes('..')) throw invalid();
      try {
        // request() has no redirect interceptor; any non-200 response is rejected below.
        const response = await request(API + path, { dispatcher, signal, method: 'GET', headersTimeout: 15000, bodyTimeout: 15000, headers: { accept: 'application/vnd.github+json', 'user-agent': 'Code-Conductor/0.1.2', 'x-github-api-version': '2022-11-28' } });
        if (response.statusCode !== 200) {
          response.body.destroy();
          if (response.statusCode === 403 || response.statusCode === 429) throw new CatalogError('Catalog access is limited or unavailable. Retry later; no package was installed.');
          throw new CatalogError('Canonical catalog could not be fetched. No package was installed.');
        }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_BYTES) { response.body.destroy(); throw invalid(); }
          chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(utf8.decode(Buffer.concat(chunks))) as unknown;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError(signal.aborted ? 'Catalog request cancelled or timed out. No package was installed.' : 'Catalog network/TLS/proxy operation failed. Check configured connectivity and trust. No package was installed.');
      }
    },
    close: () => dispatcher.destroy(),
  };
}
async function withRequest<T>(options: CatalogOptions, work: (request: CatalogRequest, signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  if (signal.aborted) throw new CatalogError('Catalog request cancelled. No package was installed.');
  const transport = options.request ? undefined : publicTransport();
  const delegate = options.request ?? transport!.request;
  const immutable = new Map<string, Promise<unknown>>();
  const get: CatalogRequest = async (path, currentSignal) => {
    if (currentSignal.aborted) throw new CatalogError('Catalog request cancelled or timed out. No package was installed.');
    const cached = path.startsWith('/contents/') ? immutable.get(path) : undefined;
    const pending = cached ?? delegate(path, currentSignal);
    if (path.startsWith('/contents/') && !cached) immutable.set(path, pending);
    const value = await pending;
    if (currentSignal.aborted) throw new CatalogError('Catalog request cancelled or timed out. No package was installed.');
    return value;
  };
  try {
    const result = await work(get, signal);
    if (signal.aborted) throw new CatalogError('Catalog request cancelled or timed out. No package was installed.');
    return result;
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(signal.aborted ? 'Catalog request cancelled or timed out. No package was installed.' : 'Catalog metadata/request could not be validated. No package was installed.');
  }
  finally { try { await transport?.close(); } catch { throw new CatalogError('Catalog connection cleanup failed. No package was installed.'); } }
}

/** Explicit public metadata read only. Catalog entries remain candidates, not trusted agents. */
export async function fetchPackCatalog(installed: readonly InstalledCatalogVersion[] = [], options: CatalogOptions = {}): Promise<PackCatalog> {
  if (installed.length > 1000) throw invalid();
  const present = new Set(installed.map(catalogVersionId));
  return withRequest(options, async (get, signal) => {
    const head = await get('/git/ref/heads/main', signal);
    if (!object(head) || !object(head.object) || head.object.type !== 'commit' || typeof head.object.sha !== 'string' || !SHA.test(head.object.sha)) throw invalid();
    const commit = head.object.sha;
    const [manifestResponse, toolingResponse, firstTags] = await Promise.all([
      get(`/contents/apm.yml?ref=${commit}`, signal),
      get(`/contents/tooling/apm-version.txt?ref=${commit}`, signal),
      get('/tags?per_page=100&page=1', signal),
    ]);
    const manifest = content(manifestResponse, 'apm.yml');
    if (content(toolingResponse, 'tooling/apm-version.txt').text.trim() !== '0.33.0') throw new CatalogError('Catalog tooling is incompatible with the supported APM 0.33.0. No package was installed.');
    const paths = catalogPaths(manifest.text);
    let tags: unknown = firstTags; let page = 1; let complete = true;
    const versions = new Map<string, CatalogVersion>();
    const byTag = new Map<string, string>();
    for (;;) {
      if (!Array.isArray(tags) || tags.length > 100) throw invalid();
      for (const tag of tags) {
        if (!object(tag) || typeof tag.name !== 'string' || tag.name.length > 200 || !object(tag.commit) || typeof tag.commit.sha !== 'string' || !SHA.test(tag.commit.sha)) throw invalid();
        const previous = byTag.get(tag.name);
        if (previous && previous !== tag.commit.sha) throw invalid();
        byTag.set(tag.name, tag.commit.sha);
        for (const path of paths) {
          const prefix = path.slice(0, -5) + '-v';
          if (!tag.name.startsWith(prefix)) continue;
          const release = tag.name.slice(prefix.length); if (!version(release)) continue;
          const item = { mirror: CATALOG_MIRROR, path, version: release, commit: tag.commit.sha };
          const id = catalogVersionId(item);
          versions.set(id, { ...item, id, tag: tag.name, reference: `${CATALOG_MIRROR}/${path}#${item.commit}`, locallyPresent: present.has(id), trust: 'candidate' });
        }
      }
      if (tags.length < 100) break;
      if (page === MAX_PAGES) { complete = false; break; }
      tags = await get(`/tags?per_page=100&page=${++page}`, signal);
    }
    return { version: 1, mirror: CATALOG_MIRROR, canonicalSource: CATALOG_SOURCE, catalogCommit: commit, manifestSha256: manifest.sha256, manifestBlobSha: manifest.blob, observedAt: (options.now?.() ?? new Date()).toISOString(), complete, versions: [...versions.values()].sort((a, b) => a.path.localeCompare(b.path) || rcompare(a.version, b.version) || a.version.localeCompare(b.version)), diagnostics: [...(complete ? [] : ['Version discovery reached its 1,000-tag limit; this list is incomplete.']), ...[...paths].filter((path) => ![...versions.values()].some((item) => item.path === path)).map((path) => `No verified version tags found for ${path}.`)] };
  });
}

/** Verify selected version metadata at the exact tag-resolved commit, without installing it. */
async function resolveCatalogSelection(catalog: PackCatalog, id: string, options: CatalogOptions = {}): Promise<CatalogSelection> {
  if (catalog.version !== 1 || catalog.mirror !== CATALOG_MIRROR || !SHA.test(catalog.catalogCommit) || !/^[a-f0-9]{64}$/.test(catalog.manifestSha256)) throw invalid();
  const matches = catalog.versions.filter((item) => item.id === id);
  const selected = matches[0];
  if (matches.length !== 1 || !selected || catalogVersionId(selected) !== id || selected.reference !== `${CATALOG_MIRROR}/${selected.path}#${selected.commit}`) throw invalid();
  return withRequest(options, async (get, signal) => {
    const path = `${selected.path}/apm.yml`;
    const [manifestResponse, toolingResponse] = await Promise.all([get(`/contents/${path}?ref=${selected.commit}`, signal), get(`/contents/tooling/apm-version.txt?ref=${selected.commit}`, signal)]);
    if (content(toolingResponse, 'tooling/apm-version.txt').text.trim() !== '0.33.0') throw invalid();
    const manifest = content(manifestResponse, path); const value = document(manifest.text);
    if (value.name !== selected.path.slice(0, -5) || value.version !== selected.version || typeof value.description !== 'string' || value.description.length > 4000 || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 50 || value.targets.some((target: unknown) => typeof target !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(target)) || new Set(value.targets).size !== value.targets.length) throw invalid();
    return { ...selected, name: value.name, description: value.description, declaredTargets: value.targets as string[], packageManifestSha256: manifest.sha256, packageManifestBlobSha: manifest.blob, catalogCommit: catalog.catalogCommit, catalogManifestSha256: catalog.manifestSha256, runtimeEligibility: 'unverified' };
  });
}

/** Re-fetch authoritative discovery inside the operation; callers supply IDs, never trusted catalog JSON. */
export async function fetchCatalogSelections(ids: readonly string[], options: CatalogOptions = {}): Promise<{ catalog: PackCatalog; selections: CatalogSelection[] }> {
  if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || id.length > 400)) throw invalid();
  return withRequest(options, async (get, signal) => {
    const scoped = { ...options, request: get, signal };
    const catalog = await fetchPackCatalog([], scoped);
    const known = ids.map((id) => catalog.versions.find((item) => item.id === id));
    if (known.some((item) => !item) || new Set(known.map((item) => item!.path)).size !== known.length) throw new CatalogError('Choose one discovered version per pack. No package was installed.');
    const selections: CatalogSelection[] = [];
    // Bound concurrency while sharing immutable metadata requests for common commits.
    for (let position = 0; position < ids.length; position += 4) selections.push(...await Promise.all(ids.slice(position, position + 4).map((id) => resolveCatalogSelection(catalog, id, scoped))));
    return { catalog, selections };
  });
}

/** Local file presence is only for picker filtering, never an integrity/audit claim. */
export function locallyPresentCatalogVersions(root: string): { versions: InstalledCatalogVersion[]; diagnostics: string[] } {
  const inventory = packInventory(root); const versions: InstalledCatalogVersion[] = [];
  if (inventory.diagnostics.length) return { versions, diagnostics: ['Local pack metadata is unavailable/incomplete; the catalog is not filtered by installation state.'] };
  let budget = 2000;
  let canonical: string;
  try { canonical = realpathSync(root); } catch { return { versions, diagnostics: [] }; }
  for (const pack of inventory.packs) {
    const files = pack.projections;
    if (pack.state !== 'locked' || !PACK.test(pack.name) || !pack.commit || !version(pack.version) || !files.length || !Object.keys(pack.fileHashes ?? {}).length) continue;
    let present = true;
    for (const path of files) {
      if (--budget < 0) { present = false; break; }
      let current = canonical;
      try {
        for (const part of path.split('/')) {
          current = join(current, part); const stat = lstatSync(current);
          if (stat.isSymbolicLink() || (current === join(canonical, path) ? !stat.isFile() : !stat.isDirectory())) { present = false; break; }
        }
      } catch { present = false; }
      if (!present) break;
    }
    if (present) versions.push({ mirror: CATALOG_MIRROR, path: pack.name, version: pack.version, commit: pack.commit });
  }
  return { versions, diagnostics: budget < 0 ? ['Local presence check reached its 2,000-file limit; some existing versions remain visible.'] : [] };
}
