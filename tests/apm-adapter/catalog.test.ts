import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_MIRROR, catalogVersionId, fetchCatalogSelections, fetchPackCatalog, locallyPresentCatalogVersions, type CatalogRequest } from '../../packages/apm-adapter/src/catalog.js';

const current = 'a'.repeat(40); const old = 'b'.repeat(40); const head = 'c'.repeat(40);
const typescript = 'typescript-distinguished-engineer-pack'; const github = 'github-expert-engineer-pack';
const identity = (path = typescript, version = '1.4.0', commit = current) => ({ mirror: CATALOG_MIRROR, path, version, commit });
function file(path: string, text: string) {
  const bytes = Buffer.from(text);
  return { type: 'file', path, encoding: 'base64', size: bytes.length, content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
}
function tag(path: string, version: string, commit = current) { return { name: path.slice(0, -5) + '-v' + version, commit: { sha: commit } }; }
function fixture() {
  const calls: string[] = [];
  const values = new Map<string, unknown>([
    ['/git/ref/heads/main', { object: { type: 'commit', sha: head } }],
    [`/contents/apm.yml?ref=${head}`, file('apm.yml', stringify({ dependencies: { apm: [`${CATALOG_MIRROR}/${typescript}#${typescript.slice(0, -5)}-v1.4.0`, `${CATALOG_MIRROR}/${github}#${github.slice(0, -5)}-v1.2.0`] } }))],
    [`/contents/tooling/apm-version.txt?ref=${head}`, file('tooling/apm-version.txt', '0.33.0\n')],
    [`/contents/tooling/apm-version.txt?ref=${current}`, file('tooling/apm-version.txt', '0.33.0\n')],
    [`/contents/tooling/apm-version.txt?ref=${old}`, file('tooling/apm-version.txt', '0.33.0\n')],
    ['/tags?per_page=100&page=1', [tag(typescript, '1.4.0'), tag(typescript, '1.3.0', old), tag(github, '1.2.0')]],
    ...[[typescript, '1.4.0', current], [typescript, '1.3.0', old], [github, '1.2.0', current]].map(([path, version, commit]) => [`/contents/${path}/apm.yml?ref=${commit}`, file(`${path}/apm.yml`, stringify({ name: path!.slice(0, -5), version, description: 'Source-declared specialization', targets: ['codex', 'claude', 'gemini'] }))] as [string, unknown]),
  ]);
  const request: CatalogRequest = async (path) => { calls.push(path); if (!values.has(path)) throw new Error('Unexpected fixture request'); return values.get(path); };
  return { values, calls, request };
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('on-demand canonical pack/version discovery', () => {
  it('keeps packs sharing a commit distinct and marks only the installed exact version', async () => {
    const { request, calls } = fixture();
    const catalog = await fetchPackCatalog([identity()], { request, now: () => new Date('2026-10-28T00:00:00Z') });
    expect(catalog.versions).toHaveLength(3);
    expect(catalog.versions.filter((item) => item.locallyPresent).map((item) => item.path)).toEqual([typescript]);
    expect(catalog.versions.filter((item) => item.path === typescript).map((item) => item.version)).toEqual(['1.4.0', '1.3.0']);
    expect(catalog.versions.every((item) => item.trust === 'candidate' && item.reference.endsWith('#' + item.commit))).toBe(true);
    expect(catalog.observedAt).toBe('2026-10-28T00:00:00.000Z'); expect(catalog.complete).toBe(true);
    expect(calls).toHaveLength(4);
  });
  it('resolves selected metadata by immutable commit and leaves publisher targets unverified', async () => {
    const { request, calls } = fixture();
    const result = await fetchCatalogSelections([catalogVersionId(identity())], { request });
    expect(result.selections[0]).toMatchObject({ path: typescript, version: '1.4.0', commit: current, runtimeEligibility: 'unverified', trust: 'candidate', declaredTargets: ['codex', 'claude', 'gemini'] });
    expect(result.selections[0]?.packageManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toContain(`/contents/${typescript}/apm.yml?ref=${current}`);
    expect(calls).not.toContain(`/contents/${typescript}/apm.yml?ref=main`);
  });
  it('shares immutable tooling reads in a batch and refuses selecting two versions of one pack', async () => {
    const { request, calls } = fixture();
    const both = [catalogVersionId(identity()), catalogVersionId(identity(github, '1.2.0'))];
    expect((await fetchCatalogSelections(both, { request })).selections).toHaveLength(2);
    expect(calls.filter((path) => path === `/contents/tooling/apm-version.txt?ref=${current}`)).toHaveLength(1);
    await expect(fetchCatalogSelections([both[0]!, catalogVersionId(identity(typescript, '1.3.0', old))], { request })).rejects.toThrow(/one discovered version/);
    await expect(fetchCatalogSelections([both[0]!, both[0]!], { request })).rejects.toThrow();
  });
  it('does not accept arbitrary/missing selections as canonical catalog membership', async () => {
    const { request } = fixture();
    await expect(fetchCatalogSelections([catalogVersionId(identity('unlisted-pack'))], { request })).rejects.toThrow();
    expect(() => catalogVersionId({ ...identity(), mirror: 'attacker/other' })).toThrow();
    expect(() => catalogVersionId({ ...identity(), path: '../escape-pack' })).toThrow();
  });
  it.each(['name', 'version', 'targets', 'tooling'])('refuses selected %s metadata mismatches without installing or inventing compatibility', async (field) => {
    const { request, values } = fixture();
    if (field === 'tooling') values.set(`/contents/tooling/apm-version.txt?ref=${current}`, file('tooling/apm-version.txt', '0.35.0\n'));
    else values.set(`/contents/${typescript}/apm.yml?ref=${current}`, file(`${typescript}/apm.yml`, stringify({ name: field === 'name' ? 'another-pack' : typescript.slice(0, -5), version: field === 'version' ? '9.0.0' : '1.4.0', description: 'Test', targets: field === 'targets' ? ['command:evil'] : ['codex'] })));
    await expect(fetchCatalogSelections([catalogVersionId(identity())], { request })).rejects.toThrow(/unsupported or inconsistent/);
  });
  it('refuses tampered content envelopes and unsupported YAML without echoing snippets/warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { request, values } = fixture();
    const key = `/contents/apm.yml?ref=${head}`;
    values.set(key, { ...file('apm.yml', 'dependencies: {apm: []}'), sha: 'd'.repeat(40) });
    await expect(fetchPackCatalog([], { request })).rejects.toThrow(/unsupported/);
    values.set(key, file('apm.yml', 'dependencies: !secret-marker {apm: []}'));
    await expect(fetchPackCatalog([], { request })).rejects.toThrow(/unsupported/);
    expect(warn).not.toHaveBeenCalled();
  });
  it('handles duplicate tag races and never follows API-provided URLs', async () => {
    const { request, values, calls } = fixture();
    values.set('/tags?per_page=100&page=1', [{ ...tag(typescript, '1.4.0'), tarball_url: 'https://attacker.invalid', commit: { sha: current, url: 'command:evil' } }, tag(typescript, '1.4.0', old)]);
    await expect(fetchPackCatalog([], { request })).rejects.toThrow(/inconsistent/);
    expect(calls.every((path) => path.startsWith('/'))).toBe(true);
    expect(calls.some((path) => path.includes('attacker') || path.includes('command:'))).toBe(false);
  });
  it('reports incomplete pagination explicitly at its bounded tag limit', async () => {
    const { values, request } = fixture();
    for (let page = 1; page <= 10; page++) values.set(`/tags?per_page=100&page=${page}`, Array.from({ length: 100 }, (_, index) => ({ name: `unrelated-${page}-${index}`, commit: { sha: current } })));
    const catalog = await fetchPackCatalog([], { request });
    expect(catalog.complete).toBe(false); expect(catalog.diagnostics[0]).toContain('incomplete');
  });
  it('cancels before work and after a source response, even if a transport ignores cancellation', async () => {
    const controller = new AbortController(); controller.abort(); const { request, calls } = fixture();
    await expect(fetchPackCatalog([], { request, signal: controller.signal })).rejects.toThrow(/cancelled/); expect(calls).toEqual([]);
    const late = new AbortController();
    await expect(fetchPackCatalog([], { signal: late.signal, request: async (path, signal) => { const value = await request(path, signal); late.abort(); return value; } })).rejects.toThrow(/cancelled/);
  });
  it('does not expose raw transport/proxy credential errors', async () => {
    await expect(fetchPackCatalog([], { request: async () => { throw new Error('https://user:private-password@proxy.invalid'); } })).rejects.toThrow('Catalog metadata/request could not be validated. No package was installed.');
  });
  it('requires the coordinated APM version before offering candidates', async () => {
    const { values, request } = fixture(); values.set(`/contents/tooling/apm-version.txt?ref=${head}`, file('tooling/apm-version.txt', 'future-version'));
    await expect(fetchPackCatalog([], { request })).rejects.toThrow(/incompatible/);
  });
});

describe('local presence filtering is not an audit', () => {
  it('filters present source-associated versions and leaves missing or symlinked projections available', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-catalog-')); roots.push(root);
    const path = '.codex/agents/typescript.toml'; mkdirSync(join(root, '.codex/agents'), { recursive: true });
    writeFileSync(join(root, 'apm.yml'), stringify({ targets: ['codex'], dependencies: { apm: [`${CATALOG_MIRROR}/${typescript}#${current}`] } }));
    writeFileSync(join(root, 'apm.lock.yaml'), stringify({ lockfile_version: '1', apm_version: '0.33.0', dependencies: [{ host: 'github.com', repo_url: CATALOG_MIRROR, materialization_repo_url: CATALOG_MIRROR, virtual_path: typescript, resolved_commit: current, version: '1.4.0', deployed_files: [path], deployed_file_hashes: { [path]: 'sha256:' + 'f'.repeat(64) } }] }));
    expect(locallyPresentCatalogVersions(root).versions).toEqual([]);
    // Presence deliberately does not assert the file matches a hash or passed an audit.
    writeFileSync(join(root, path), 'Human-edited installed instructions');
    expect(locallyPresentCatalogVersions(root).versions).toEqual([identity()]);
    if (process.platform !== 'win32') { rmSync(join(root, path)); symlinkSync(join(root, 'apm.yml'), join(root, path)); expect(locallyPresentCatalogVersions(root).versions).toEqual([]); }
  });
});
