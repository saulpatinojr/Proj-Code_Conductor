import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../packages/policy/src/defaults.js';
import { createTask, planTask } from '../../packages/runtime/src/index.js';
import { detectGateProfiles, runGates } from '../../packages/gates/src/index.js';
import { loadMcpCatalog } from '../../packages/mcp/src/index.js';

const folders: string[] = [];
function fixture(): string { const path = mkdtempSync(join(tmpdir(), 'cc-defaults-')); folders.push(path); return path; }
function preferences(root: string, value: unknown): void { mkdirSync(join(root, '.code-conductor'), { recursive: true }); writeFileSync(join(root, '.code-conductor', 'config.json'), JSON.stringify(value)); }
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('packaged zero-scaffolding defaults', () => {
  it('plans in a completely unrelated empty folder without creating files', () => {
    const root = fixture();
    const plan = planTask(root, createTask('Implement a safe change', 'R1', root), { availableHarnesses: new Set(['codex', 'claude']) });
    expect(plan.assignments.map((item) => item.role)).toEqual(['builder', 'reviewer', 'validator']);
    expect(readdirSync(root)).toEqual([]);
  });
  it('ignores arbitrary application config directories and cannot load a weakened risk policy', () => {
    const root = fixture(); mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'risk.yaml'), 'risk_classes: {R4: {required_roles: [builder]}}');
    const risk = loadConfiguration<any>(root, 'risk', { userRoot: null });
    expect(risk.document.risk_classes.R4.human_approval).toBe(true);
    expect(risk.sources[0]?.source).toBe('packaged');
  });
  it('loads roles, gates and catalogs with inspectable source hashes', () => {
    const root = fixture();
    for (const name of ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'] as const) {
      const result = loadConfiguration(root, name, { userRoot: null });
      expect(result.document).toBeTruthy();
      expect(result.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(loadMcpCatalog(root).servers).toBeTruthy();
  });
  it('never selects source-repository commands for a generic Node project', async () => {
    const root = fixture(); writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect(detectGateProfiles(root)).toEqual(['node']);
    const commands: string[][] = [];
    await runGates(root, undefined, (_cwd, command, args) => { commands.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; });
    expect(commands).toEqual([['npm', 'test']]);
  });
  it('prefers source-specific gates for this repository without duplicate npm tests', () => {
    const profiles = detectGateProfiles(resolve('.'));
    expect(profiles).toContain('code-conductor'); expect(profiles).not.toContain('node');
  });
  it('applies user preferences first and narrows them with workspace preferences', () => {
    const user = fixture(), workspace = fixture();
    preferences(user, { version: 1, rolePreferences: { builder: ['claude', 'codex'] } });
    preferences(workspace, { version: 1, rolePreferences: { builder: ['codex', 'kiro'] } });
    const result = loadConfiguration<any>(workspace, 'roles', { userRoot: user });
    expect(result.document.roles.builder.preferred_harnesses).toEqual(['codex']);
    expect(result.sources.map((source) => source.source)).toEqual(['packaged', 'user', 'workspace']);
  });
  it('retains mandatory reviewer independence and authority while changing preferences', () => {
    const root = fixture(); preferences(root, { version: 1, rolePreferences: { builder: ['claude'] } });
    const result = loadConfiguration<any>(root, 'roles', { userRoot: null });
    expect(result.document.roles.builder.may_merge).toBe(false);
    expect(result.document.roles.challenger.constraints.different_provider_from_builder_when_risk_at_least).toBe('R2');
  });
  it.each([
    { version: 2 },
    { version: 1, authority: { may_merge: true } },
    { version: 1, rolePreferences: { builder: ['perplexity'] } },
    { version: 1, rolePreferences: { builder: [] } },
    { version: 1, rolePreferences: { unknown: ['codex'] } },
    { version: 1, disabledHarnesses: ['imaginary'] },
    { version: 1, disabledHarnesses: ['codex', 'codex'] },
  ])('rejects unsupported or authority-changing overrides: %j', (value) => {
    const root = fixture(); preferences(root, value);
    expect(() => loadConfiguration(root, 'roles', { userRoot: null })).toThrow();
  });
  it('cannot re-enable a user-disabled provider from workspace configuration', () => {
    const user = fixture(), workspace = fixture();
    preferences(user, { version: 1, disabledHarnesses: ['codex'] });
    preferences(workspace, { version: 1, rolePreferences: { builder: ['codex', 'claude'] }, disabledHarnesses: [] });
    expect(loadConfiguration<any>(workspace, 'roles', { userRoot: user }).document.roles.builder.preferred_harnesses).toEqual(['claude']);
    expect(loadConfiguration<any>(workspace, 'capabilities', { userRoot: user }).document.harnesses.codex).toBeUndefined();
  });
  it('fails rather than inventing an eligible provider after conflicting restrictions', () => {
    const user = fixture(), workspace = fixture();
    preferences(user, { version: 1, rolePreferences: { builder: ['codex'] } });
    preferences(workspace, { version: 1, rolePreferences: { builder: ['claude'] } });
    expect(() => loadConfiguration(workspace, 'roles', { userRoot: user })).toThrow(/no eligible harness/);
  });
  it('rejects oversized and symlink overrides', () => {
    const root = fixture(); preferences(root, { version: 1 });
    writeFileSync(join(root, '.code-conductor', 'config.json'), ' '.repeat(65537));
    expect(() => loadConfiguration(root, 'roles', { userRoot: null })).toThrow(/bounded/);
    rmSync(join(root, '.code-conductor', 'config.json'));
    symlinkSync(join(resolve('.'), 'package.json'), join(root, '.code-conductor', 'config.json'));
    expect(() => loadConfiguration(root, 'roles', { userRoot: null })).toThrow(/Symlink/);
  });
  it('build outputs exactly match canonical config and their manifest hashes', () => {
    const manifest = JSON.parse(readFileSync(resolve('apps/vscode/defaults/manifest.json'), 'utf8'));
    for (const [name, digest] of Object.entries(manifest.files)) {
      const source = readFileSync(resolve('config', name));
      expect(readFileSync(resolve('apps/vscode/defaults', name))).toEqual(source);
      expect(createHash('sha256').update(source).digest('hex')).toBe(digest);
    }
  });
});


describe('independent review regressions', () => {
  it('does not identify an unrelated monorepo by a common CLI source path', () => {
    const root = fixture();
    mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export {};');
    writeFileSync(join(root, 'package.json'), '{"name":"unrelated","scripts":{"test":"node --test"}}');
    expect(detectGateProfiles(root)).toEqual(['node']);
    writeFileSync(join(root, 'package.json'), '{"name":"@code-conductor/root"}');
    expect(detectGateProfiles(root)).toEqual(['code-conductor']);
  });
  it.each(['user', 'workspace'])('rejects dangling %s configuration symlinks', (source) => {
    const user = fixture(), workspace = fixture();
    const target = source === 'user' ? user : workspace;
    mkdirSync(join(target, '.code-conductor'));
    symlinkSync(join(target, 'nonexistent-config'), join(target, '.code-conductor', 'config.json'));
    expect(() => loadConfiguration(workspace, 'roles', { userRoot: user })).toThrow(/Symlink/);
  });
  it.each(['user', 'workspace'])('rejects dangling %s configuration directory links', (source) => {
    const user = fixture(), workspace = fixture();
    const target = source === 'user' ? user : workspace;
    symlinkSync(join(target, 'nonexistent-directory'), join(target, '.code-conductor'), 'dir');
    expect(() => loadConfiguration(workspace, 'roles', { userRoot: user })).toThrow(/Symlink/);
  });
});
