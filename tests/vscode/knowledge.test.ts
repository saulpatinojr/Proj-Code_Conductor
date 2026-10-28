import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@code-conductor/git', async (original) => ({ ...await original<typeof import('@code-conductor/git')>(), githubOriginRepository: () => 'owner/repo' }));
import { indexVault, obsidianOpenUri, resolveKnowledgeNote, validateConnection, type VaultConnection } from '../../apps/vscode/src/knowledge.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc-knowledge-')); roots.push(root);
  const repository = join(root, 'repo'); const vault = join(root, 'vault'); const folder = 'project';
  mkdirSync(repository); mkdirSync(join(vault, folder), { recursive: true });
  const connection: VaultConnection = { repository, vault, folder };
  return { root, repository, vault, connection };
}
function writeNote(connection: VaultConnection, name: string, overrides: Record<string, unknown> = {}, body = 'Human annotation.'): string {
  const path = join(connection.vault, connection.folder, name);
  writeFileSync(path, '---\n' + JSON.stringify({ code_conductor: { version: 1, id: name.replace('.md', ''), kind: 'decision', repository: connection.repository, sources: [], edges: [], ...overrides } }) + '\n---\n' + body);
  return path;
}
describe.skipIf(process.platform !== 'linux')('bounded read-only knowledge index', () => {
  it('matches local provenance, keeps remote/run claims unverified and preserves prose', () => {
    const { connection, repository } = fixture(); writeFileSync(join(repository, 'decision.md'), 'approved decision');
    const path = writeNote(connection, 'one.md', { sources: [{ kind: 'file', path: 'decision.md', sha256: hash('approved decision') }, { kind: 'issue', id: 'owner/repo#7' }, { kind: 'run', id: 'CC-run' }], edges: [{ kind: 'related_to', target: 'two', source: 0 }] });
    writeNote(connection, 'two.md'); const before = readFileSync(path, 'utf8');
    const index = indexVault(connection); expect(index.notes).toHaveLength(2);
    expect(index.notes[0]?.sources.map((source) => source.state)).toEqual(['locally_matched', 'unverified', 'unverified']);
    expect(index.notes[0]?.edges[0]?.state).toBe('locally_matched');
    expect(readFileSync(path, 'utf8')).toBe(before);
    const selected = index.notes[0]!;
    writeFileSync(join(repository, 'decision.md'), 'changed');
    expect(() => resolveKnowledgeNote(connection, selected)).toThrow(/changed/);
    expect(indexVault(connection).notes[0]?.sources[0]?.state).toBe('stale');
    rmSync(join(repository, 'decision.md'));
    expect(indexVault(connection).notes[0]?.sources[0]?.state).toBe('broken');
  });
  it('rechecks changed and renamed notes before opening, without overwriting them', () => {
    const { connection } = fixture(); const path = writeNote(connection, 'one.md');
    const selected = indexVault(connection).notes[0]!;
    expect(resolveKnowledgeNote(connection, selected)).toBe(path);
    writeFileSync(path, readFileSync(path, 'utf8') + '\nNew user prose.');
    expect(() => resolveKnowledgeNote(connection, selected)).toThrow(/changed/);
    renameSync(path, join(connection.vault, connection.folder, 'renamed.md'));
    expect(() => resolveKnowledgeNote(connection, selected)).toThrow(/changed/);
  });
  it('rejects escapes, symlinks, malformed metadata, secrets and foreign repositories', () => {
    const { connection, root } = fixture(); const outside = join(root, 'outside.md'); writeFileSync(outside, 'outside');
    symlinkSync(outside, join(connection.vault, connection.folder, 'link.md'));
    const other = join(root, 'other'); mkdirSync(other);
    writeNote(connection, 'foreign.md', { repository: other });
    writeNote(connection, 'escape.md', { sources: [{ kind: 'file', path: '../outside.md', sha256: hash('outside') }] });
    writeNote(connection, 'secret.md', {}, 'gh' + 'p_' + 'A'.repeat(40));
    writeFileSync(join(connection.vault, connection.folder, 'bad.md'), '---\ncode_conductor: [\n---\n');
    expect(indexVault(connection).notes).toHaveLength(0);
    expect(() => validateConnection({ ...connection, folder: '../repo' })).toThrow();
    expect(() => validateConnection({ ...connection, folder: '.' })).toThrow();
    expect(existsSync(outside)).toBe(true);
  });
  it('excludes duplicate identities, broken targets and oversized note content', () => {
    const { connection, repository } = fixture(); writeFileSync(join(repository, 'source.md'), 'source');
    writeNote(connection, 'one.md', { id: 'duplicate' }); writeNote(connection, 'two.md', { id: 'duplicate' });
    writeNote(connection, 'graph.md', { sources: [{ kind: 'file', path: 'source.md', sha256: hash('source') }], edges: [{ kind: 'uses', target: 'missing', source: 0 }] });
    writeNote(connection, 'large.md', {}, 'x'.repeat(65537));
    const index = indexVault(connection);
    expect(index.notes.map((note) => note.id)).toEqual(['graph']);
    expect(index.notes[0]?.edges[0]?.state).toBe('broken');
    expect(index.diagnostics.length).toBeGreaterThan(0);
  });

  it('excludes private-state and credential roots and foreign GitHub source identities', () => {
    const { connection, root } = fixture();
    const state = join(root, 'custom-home'); const privateVault = join(state, 'runs/vault'); mkdirSync(join(privateVault, 'project'), { recursive: true });
    vi.stubEnv('CODE_CONDUCTOR_HOME', state);
    expect(() => validateConnection({ ...connection, vault: privateVault })).toThrow(/Private/);
    const credentialVault = join(root, '.ssh/vault'); mkdirSync(join(credentialVault, 'project'), { recursive: true });
    expect(() => validateConnection({ ...connection, vault: credentialVault })).toThrow(/Private/);
    writeNote(connection, 'foreign-source.md', { sources: [{ kind: 'issue', id: 'foreign/repo#7' }] });
    expect(indexVault(connection).notes).toHaveLength(0);
  });
  it('never hashes credential-shaped local source content into matched provenance', () => {
    const { connection, repository } = fixture();
    const content = 'gh' + 'p_' + 'A'.repeat(40); writeFileSync(join(repository, 'ordinary.md'), content);
    writeNote(connection, 'one.md', { sources: [{ kind: 'file', path: 'ordinary.md', sha256: hash(content) }] });
    expect(indexVault(connection).notes[0]?.sources[0]?.state).toBe('broken');
  });

  it('charges invalid UTF-8 source reads against the total byte budget', () => {
    const { connection, repository } = fixture();
    const sources = Array.from({ length: 64 }, (_, index) => {
      const path = `source${index}.md`; writeFileSync(join(repository, path), Buffer.alloc(65536, 0xff));
      return { kind: 'file', path, sha256: 'a'.repeat(64) };
    });
    writeNote(connection, 'one.md', { sources: sources.slice(0, 32) });
    writeNote(connection, 'two.md', { sources: sources.slice(32) });
    const index = indexVault(connection); expect(index.limited).toBe(true);
    expect(index.notes.flatMap((note) => note.sources).some((source) => source.state === 'locally_matched')).toBe(false);
  });
  it('stops at the scan count limit and reports it explicitly', () => {
    const { connection } = fixture();
    for (let n = 0; n < 201; n++) writeNote(connection, `note${n}.md`);
    const index = indexVault(connection); expect(index.notes).toHaveLength(200); expect(index.limited).toBe(true);
  });
});
describe('native Obsidian navigation', () => {
  it.each(['/vault/my note.md', 'C:\\Users\\Owner\\Vault\\my note.md', '/vault/日本語.md'])('encodes and safely survives VS Code external-opener serialization: %s', (path) => {
    const input = obsidianOpenUri(path);
    expect(new URL(input).searchParams.get('path')).toBe(path);
    // Official opener uses encodeURI(uri.toString(true)) for a URI argument.
    const opened = encodeURI(URI.parse(input).toString(true));
    expect(new URL(opened).searchParams.get('path')).toBe(path);
    expect([...new URL(opened).searchParams.keys()]).toEqual(['path']);
  });
  it.each(['/vault/note&append=bad.md', '/vault/note#heading.md', '/vault/100%.md', '/vault/a+b.md', 'relative.md'])('requires editor fallback for ambiguous native URI paths: %s', (path) => {
    expect(() => obsidianOpenUri(path)).toThrow();
  });
  it.skipIf(process.platform === 'linux')('fails before filesystem access on unsupported indexing hosts', () => {
    expect(() => validateConnection({ vault: '/absent', folder: 'project', repository: '/absent' })).toThrow(/Linux/);
  });
});
