import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { comparePackProjections, PREVIEW_PACKS } from '../../packages/apm-adapter/src/projection-preview.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const path = '.codex/agents/reviewer.toml';
const skill = '.agents/skills/testing/SKILL.md';
const pack = PREVIEW_PACKS[0];
function write(root: string, path: string, text: string): void {
  const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text);
}
function entry(name: string, files: Record<string, string>) {
  return { virtual_path: name, host: 'github.com', repo_url: 'hybridcloudworks/proj-agentpacks', materialization_repo_url: 'hybridcloudworks/Proj-AgentPacks', resolved_commit: '16f41836d65cbf79070ecdb2ef835c78c57b6ae6', deployed_files: Object.keys(files), deployed_file_hashes: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, 'sha256:' + sha(text)])) };
}
function lock(root: string, files: Record<string, string>, other: Record<string, string> = {}) {
  write(root, 'apm.lock.yaml', stringify({ lockfile_version: '1', apm_version: '0.33.0', dependencies: [entry(pack, files)], local_deployed_file_hashes: Object.fromEntries(Object.entries(other).map(([name, text]) => [name, 'sha256:' + sha(text)])) }));
}
function fixture(files: Record<string, string> = { [path]: 'new' }) {
  const root = mkdtempSync(join(tmpdir(), 'cc-preview-')); roots.push(root);
  const repo = join(root, 'repo'); const stage = join(root, 'stage'); mkdirSync(repo); mkdirSync(stage);
  for (const [path, text] of Object.entries(files)) write(stage, path, text);
  lock(stage, files);
  const compare = () => comparePackProjections(repo, stage, [pack]);
  return { root, repo, stage, compare };
}

describe.skipIf(process.platform !== 'linux')('exact selected-pack projection comparison', () => {
  it('records exact bytes/hashes and reproducible repository-bound digest without changing either root', () => {
    const { repo, stage, compare } = fixture({ [path]: 'name = "test"\r\n', [skill]: '# Instructions\n' });
    const originalLock = readFileSync(join(stage, 'apm.lock.yaml'), 'utf8');
    const result = compare();
    expect(result.changes.map((change) => [change.path, change.operation])).toEqual([[skill, 'add'], [path, 'add']]);
    expect(result.changes[1]).toMatchObject({ after: 'name = "test"\r\n', afterSha256: sha('name = "test"\r\n') });
    expect(compare().digest).toBe(result.digest);
    expect(result.audit).toBeUndefined();
    expect(result.scope).toBe('selected-pack-projections-only');
    expect(existsSync(join(repo, 'apm.lock.yaml'))).toBe(false);
    expect(existsSync(join(repo, path))).toBe(false);
    expect(readFileSync(join(stage, 'apm.lock.yaml'), 'utf8')).toBe(originalLock);
  });
  it('identifies unchanged, replace, removal and missing previously-managed files', () => {
    const { repo, compare } = fixture({ [path]: 'new', [skill]: 'same' });
    const removed = '.agents/skills/old/SKILL.md'; const missing = '.codex/agents/missing.toml';
    lock(repo, { [path]: 'old', [skill]: 'same', [removed]: 'remove', [missing]: 'missing' });
    write(repo, path, 'old'); write(repo, skill, 'same'); write(repo, removed, 'remove');
    const changes = compare().changes;
    expect(changes.find((change) => change.path === path)).toMatchObject({ operation: 'replace', before: 'old', after: 'new' });
    expect(changes.find((change) => change.path === skill)?.operation).toBe('unchanged');
    expect(changes.find((change) => change.path === removed)?.operation).toBe('remove');
    expect(changes.find((change) => change.path === missing)?.operation).toBe('unchanged');
  });
  it('blocks unmanaged and modified instructions, including modified removal candidates', () => {
    const { repo, compare } = fixture(); write(repo, path, 'Human instructions');
    expect(compare().changes[0]).toMatchObject({ operation: 'blocked', before: 'Human instructions', after: 'new' });
    const removed = '.agents/skills/old/SKILL.md';
    lock(repo, { [path]: 'old', [removed]: 'old' }); write(repo, removed, 'Human notes');
    expect(compare().changes.filter((change) => change.operation === 'blocked')).toHaveLength(2);
    expect(readFileSync(join(repo, removed), 'utf8')).toBe('Human notes');
  });
  it('preserves shared local ownership and blocks replacement of shared instructions', () => {
    const removed = '.agents/skills/shared/SKILL.md'; const { repo, compare } = fixture();
    lock(repo, { [path]: 'old', [removed]: 'shared' }, { [path]: 'old', [removed]: 'shared' });
    write(repo, path, 'old'); write(repo, removed, 'shared');
    const result = compare(); expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.operation).toBe('blocked');
  });
  it.each(['dependency', 'local', 'deployment'])('preserves retained %s ownership even without content hashes', (kind) => {
    const removed = '.agents/skills/shared/SKILL.md'; const { repo, compare } = fixture();
    const metadata: Record<string, unknown> = { lockfile_version: '1', apm_version: '0.33.0', dependencies: [entry(pack, { [path]: 'old', [removed]: 'shared' })] };
    if (kind === 'dependency') (metadata.dependencies as unknown[]).push({ virtual_path: 'retained-pack', deployed_files: [removed, path] });
    if (kind === 'local') metadata.local_deployed_files = [removed, path];
    if (kind === 'deployment') metadata.deployments = [removed, path].map((value) => ({ kind: 'project-relative', value, owners: ['some/retained-pack'] }));
    write(repo, 'apm.lock.yaml', stringify(metadata)); write(repo, removed, 'shared'); write(repo, path, 'old');
    expect(compare().changes).toHaveLength(1); expect(compare().changes[0]?.operation).toBe('blocked');
  });
  it('compares only Codex projections and never proposes removing another target', () => {
    const { repo, compare } = fixture(); lock(repo, { '.claude/agents/test.md': 'other target', [path]: 'old' });
    write(repo, path, 'old'); expect(compare().changes.map((change) => change.path)).toEqual([path]);
  });
  it('binds current local edits and lock changes into the digest', () => {
    const { repo, compare } = fixture(); const first = compare().digest;
    write(repo, path, 'local'); const second = compare().digest; expect(first).not.toBe(second);
    lock(repo, { [path]: 'local' }); expect(compare().digest).not.toBe(second);
  });
  it('rejects missing, modified and unrecorded staged files', () => {
    const { stage, compare } = fixture(); write(stage, path, 'tampered'); expect(compare).toThrow(/hash/);
    rmSync(join(stage, path)); expect(compare).toThrow(/hash/);
    write(stage, path, 'new'); write(stage, '.codex/hooks.json', '{}'); expect(compare).toThrow(/Unexpected/);
  });
  it('rejects unreviewed source pins, unsupported YAML tags and ambiguous lock identities', () => {
    const { stage, compare } = fixture();
    const good = readFileSync(join(stage, 'apm.lock.yaml'), 'utf8');
    write(stage, 'apm.lock.yaml', good.replace('16f41836d65cbf79070ecdb2ef835c78c57b6ae6', '0'.repeat(40))); expect(compare).toThrow(/source/);
    write(stage, 'apm.lock.yaml', good + '\nunknown: !unsupported a\n'); expect(compare).toThrow(/metadata/);
    write(stage, 'apm.lock.yaml', stringify({ lockfile_version: '1', apm_version: '0.33.0', dependencies: [entry(pack, { [path]: 'new' }), entry(pack, {})] })); expect(compare).toThrow(/Ambiguous/);
  });
  it('blocks local intermediate/final symlinks, hard links and directories without reading their target', () => {
    const { root, repo, compare } = fixture(); const outside = join(root, 'outside'); mkdirSync(outside); write(outside, 'agents/reviewer.toml', 'external');
    symlinkSync(outside, join(repo, '.codex'));
    expect(compare().changes[0]).toEqual({ path, operation: 'blocked', conflict: 'Local file cannot be compared safely.' });
    rmSync(join(repo, '.codex')); mkdirSync(join(repo, '.codex/agents'), { recursive: true }); symlinkSync(join(outside, 'agents/reviewer.toml'), join(repo, path));
    expect(compare().changes[0]?.operation).toBe('blocked'); rmSync(join(repo, path));
    linkSync(join(outside, 'agents/reviewer.toml'), join(repo, path)); expect(compare().changes[0]?.operation).toBe('blocked');
    rmSync(join(repo, path)); mkdirSync(join(repo, path)); expect(compare().changes[0]?.operation).toBe('blocked');
  });
  it('rejects staged symlinks, invalid UTF-8, oversized files and path traversal', () => {
    const { root, stage, compare } = fixture(); write(stage, path, 'x'.repeat(1048577)); expect(compare).toThrow();
    writeFileSync(join(stage, path), Buffer.from([0xff])); expect(compare).toThrow(/encoding/);
    rmSync(join(stage, path)); write(root, 'outside', 'new'); symlinkSync(join(root, 'outside'), join(stage, path)); expect(compare).toThrow(/symlinks/);
    rmSync(join(stage, path)); lock(stage, { '../outside': 'new' }); expect(compare).toThrow(/path/);
  });
});
