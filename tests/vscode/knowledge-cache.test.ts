import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const origin = vi.hoisted(() => ({ repository: 'owner/repo' }));
vi.mock('@code-conductor/git', async (original) => ({ ...await original<typeof import('@code-conductor/git')>(), githubOriginRepository: vi.fn(() => origin.repository) }));
import { githubOriginRepository } from '@code-conductor/git';
import { indexVault, KnowledgeIndexCache, resolveKnowledgeNote, type VaultConnection } from '../../apps/vscode/src/knowledge.js';
const roots: string[] = [];
afterEach(() => { origin.repository = 'owner/repo'; vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(): VaultConnection {
  const root = mkdtempSync(join(tmpdir(), 'cc-knowledge-cache-')); roots.push(root);
  const repository = join(root, 'repository'); const vault = join(root, 'vault');
  mkdirSync(repository); mkdirSync(join(vault, 'project'), { recursive: true });
  return { repository, vault, folder: 'project' };
}
function note(connection: VaultConnection, name: string, overrides: Record<string, unknown> = {}): string {
  const path = join(connection.vault, connection.folder, name + '.md');
  writeFileSync(path, '---\n' + JSON.stringify({ code_conductor: { version: 1, id: name, kind: 'lesson', repository: connection.repository, sources: [], edges: [], ...overrides } }) + '\n---\nHuman prose never belongs in a metadata cache.');
  return path;
}
describe.skipIf(process.platform !== 'linux')('incremental knowledge metadata cache', () => {
  it('reuses unchanged parsing while re-reading referenced sources and enforcing click-time invalidation', () => {
    const connection = fixture(); const cache = new KnowledgeIndexCache();
    const source = join(connection.repository, 'source.md'); writeFileSync(source, 'approved');
    note(connection, 'one', { sources: [{ kind: 'file', path: 'source.md', sha256: hash('approved') }] });
    const first = indexVault(connection, cache).notes[0]!;
    expect(first.sources[0]?.state).toBe('locally_matched');
    expect(cache.statistics).toMatchObject({ entries: 1, parsed: 1, reused: 0 });
    indexVault(connection, cache);
    expect(cache.statistics).toMatchObject({ parsed: 1, reused: 1 });
    writeFileSync(source, 'changed');
    expect(indexVault(connection, cache).notes[0]?.sources[0]?.state).toBe('stale');
    expect(cache.statistics.parsed).toBe(1);
    expect(() => resolveKnowledgeNote(connection, first, cache)).toThrow(/changed/);
    rmSync(source);
    expect(indexVault(connection, cache).notes[0]?.sources[0]?.state).toBe('broken');
    expect(cache.statistics.parsed).toBe(1);
  });
  it('updates renamed titles, prunes deleted notes and rebuilds relationships on every refresh', () => {
    const connection = fixture(); const cache = new KnowledgeIndexCache();
    const source = join(connection.repository, 'source.md'); writeFileSync(source, 'approved');
    const firstPath = note(connection, 'one', { sources: [{ kind: 'file', path: 'source.md', sha256: hash('approved') }], edges: [{ kind: 'related_to', target: 'two', source: 0 }] });
    const secondPath = note(connection, 'two');
    const first = indexVault(connection, cache);
    expect(first.notes[0]?.edges[0]?.state).toBe('locally_matched');
    const renamed = join(connection.vault, connection.folder, 'renamed.md'); renameSync(secondPath, renamed);
    const afterRename = indexVault(connection, cache);
    expect(afterRename.notes.find((item) => item.id === 'two')).toMatchObject({ title: 'renamed', path: 'project/renamed.md' });
    expect(cache.statistics).toMatchObject({ entries: 2, parsed: 2, reused: 2 });
    rmSync(renamed);
    const afterDelete = indexVault(connection, cache);
    expect(afterDelete.notes).toHaveLength(1); expect(afterDelete.notes[0]?.edges[0]?.state).toBe('broken');
    expect(cache.statistics.entries).toBe(1);
    writeFileSync(firstPath, readFileSync(firstPath, 'utf8') + '\nNew human annotation.');
    const afterEdit = indexVault(connection, cache);
    expect(afterEdit.notes[0]?.sha256).not.toBe(first.notes[0]?.sha256);
    expect(cache.statistics).toMatchObject({ entries: 1, parsed: 3 });
  });
  it('does not let consumers mutate later cached metadata or verification states', () => {
    const connection = fixture(); const cache = new KnowledgeIndexCache();
    writeFileSync(join(connection.repository, 'source.md'), 'approved');
    note(connection, 'one', { sources: [{ kind: 'file', path: 'source.md', sha256: hash('approved') }], edges: [{ kind: 'uses', target: 'one', source: 0 }] });
    const first = indexVault(connection, cache).notes[0]!;
    first.id = 'forged'; first.sources[0]!.path = '../outside'; first.sources[0]!.state = 'broken'; first.edges[0]!.target = 'forged';
    const second = indexVault(connection, cache).notes[0]!;
    expect(second.id).toBe('one'); expect(second.sources[0]).toMatchObject({ path: 'source.md', state: 'locally_matched' });
    expect(second.edges[0]).toMatchObject({ target: 'one', state: 'locally_matched' });
    expect(cache.statistics).toMatchObject({ parsed: 1, reused: 1 });
  });
  it('checks current GitHub association on cache hits and never caches remote verification', () => {
    const connection = fixture(); const cache = new KnowledgeIndexCache();
    note(connection, 'one', { sources: [{ kind: 'issue', id: 'owner/repo#7' }] });
    expect(indexVault(connection, cache).notes[0]?.sources[0]?.state).toBe('unverified');
    indexVault(connection, cache);
    expect(cache.statistics).toMatchObject({ parsed: 1, reused: 1 });
    origin.repository = 'another/repository';
    expect(indexVault(connection, cache).notes).toHaveLength(0); expect(cache.statistics.entries).toBe(0);
    origin.repository = 'owner/repo';
    expect(indexVault(connection, cache).notes[0]?.sources[0]?.state).toBe('unverified');
    expect(githubOriginRepository).toHaveBeenCalledTimes(4);
  });
  it('clears retained metadata when repository/folder scope changes or explicit clear is requested', () => {
    const first = fixture(); const second = fixture(); const cache = new KnowledgeIndexCache();
    note(first, 'one'); note(second, 'two');
    indexVault(first, cache); indexVault(first, cache);
    expect(cache.statistics.reused).toBe(1);
    expect(indexVault(second, cache).notes.map((item) => item.id)).toEqual(['two']);
    expect(cache.statistics).toMatchObject({ entries: 1, parsed: 1, reused: 0 });
    mkdirSync(join(second.vault, 'other')); const third = { ...second, folder: 'other' }; note(third, 'three');
    expect(indexVault(third, cache).notes.map((item) => item.id)).toEqual(['three']);
    expect(cache.statistics).toMatchObject({ entries: 1, parsed: 1, reused: 0 });
    cache.clear(); expect(cache.statistics).toEqual({ entries: 0, bytes: 0, parsed: 0, reused: 0 });
  });
  it('enforces independent entry/serialized-byte bounds without omitting uncached valid notes', () => {
    const connection = fixture(); for (const name of ['one', 'two', 'three']) note(connection, name);
    const entries = new KnowledgeIndexCache({ maximumEntries: 2 });
    expect(indexVault(connection, entries).notes).toHaveLength(3); expect(entries.statistics.entries).toBe(2);
    indexVault(connection, entries); expect(entries.statistics.entries).toBe(2);
    const bytes = new KnowledgeIndexCache({ maximumBytes: 1 });
    expect(indexVault(connection, bytes).notes).toHaveLength(3); expect(bytes.statistics).toMatchObject({ entries: 0, bytes: 0 });
    expect(() => new KnowledgeIndexCache({ maximumEntries: 201 })).toThrow(/limits/);
    expect(() => new KnowledgeIndexCache({ maximumBytes: 2097153 })).toThrow(/limits/);
  });
  it('still descriptor-checks cached notes and clears state for an invalid connection', () => {
    const connection = fixture(); const cache = new KnowledgeIndexCache(); const path = note(connection, 'one');
    indexVault(connection, cache); expect(cache.statistics.entries).toBe(1);
    const outside = join(connection.repository, 'outside.md'); writeFileSync(outside, readFileSync(path));
    rmSync(path); symlinkSync(outside, path);
    expect(indexVault(connection, cache).notes).toHaveLength(0); expect(cache.statistics.entries).toBe(0);
    rmSync(path); note(connection, 'one'); indexVault(connection, cache);
    expect(() => indexVault({ ...connection, folder: '../repository' }, cache)).toThrow();
    expect(cache.statistics.entries).toBe(0);
  });
});
