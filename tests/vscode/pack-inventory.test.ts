import { readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packInventory, packInventoryText } from '../../apps/vscode/src/pack-inventory.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pin = 'a'.repeat(40);
function root() { const value = mkdtempSync(join(tmpdir(), 'cc-packs-')); roots.push(value); return value; }
function manifest(directory: string) { writeFileSync(join(directory, 'apm.yml'), `targets: [codex]\ndependencies:\n  apm: [hybridcloudworks/Proj-AgentPacks/example-pack#${pin}]\n`); }
function lock(directory: string, commit = pin) { writeFileSync(join(directory, 'apm.lock.yaml'), `lockfile_version: '1'\napm_version: 0.33.0\ndependencies:\n- repo_url: hybridcloudworks/proj-agentpacks\n  host: github.com\n  materialization_repo_url: hybridcloudworks/Proj-AgentPacks\n  virtual_path: example-pack\n  resolved_commit: ${commit}\n  version: 1.0.0\n  deployed_files: [.codex/agents/example.md]\n`); }
describe('optional pack inventory', () => {
  it('works without APM or packaging and starts no process or writes', () => {
    const directory = root(); expect(packInventory(directory)).toEqual({ targets: [], packs: [], diagnostics: [], manifestSha256: undefined, lockSha256: undefined, apmVersion: undefined });
    expect(packInventoryText(directory)).toContain('No install, audit, hook, provider or MCP process was started. No files were written.');
  });
  it('distinguishes declarations, locked pins and drift without claiming integrity', () => {
    const directory = root(); manifest(directory);
    expect(packInventory(directory).packs[0]?.state).toBe('declared');
    lock(directory);
    const inventory = packInventory(directory);
    expect(inventory.packs[0]).toMatchObject({ state: 'locked', commit: pin, version: '1.0.0', projections: ['.codex/agents/example.md'] });
    expect(inventory.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packInventoryText(directory)).toContain('Audit state: unknown');
    lock(directory, 'b'.repeat(40)); expect(packInventory(directory).packs[0]?.state).toBe('mismatch');
  });
  it('refuses malformed/oversized/symlinked metadata and does not echo parser secrets', () => {
    const directory = root(); const path = join(directory, 'apm.yml');
    for (const input of ['targets: [secret-private-token', 'x'.repeat(1048577)]) {
      writeFileSync(path, input); const inventory = packInventory(directory);
      expect(inventory.diagnostics).toHaveLength(1); expect(packInventoryText(directory)).not.toContain('secret-private-token');
    }
    rmSync(path); const target = join(directory, 'target'); writeFileSync(target, 'targets: []'); symlinkSync(target, path);
    expect(packInventory(directory).diagnostics).toHaveLength(1);
  });
  it('diagnoses malformed fields and refuses a foreign lock host', () => {
    const directory = root();
    for (const input of ['dependencies: [bad]', 'targets: codex']) {
      writeFileSync(join(directory, 'apm.yml'), input);
      expect(packInventory(directory).diagnostics).toHaveLength(1);
    }
    manifest(directory); lock(directory);
    const path = join(directory, 'apm.lock.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('host: github.com', 'host: gitlab.com'));
    expect(packInventory(directory).packs[0]?.state).toBe('mismatch');
  });
  it('does not log private YAML tag warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const directory = root();
    try {
      writeFileSync(join(directory, 'apm.yml'), 'targets: !private-marker [codex]\n');
      expect(packInventory(directory).diagnostics).toHaveLength(1);
      manifest(directory); lock(directory);
      const path = join(directory, 'apm.lock.yaml');
      writeFileSync(path, readFileSync(path, 'utf8').replace('resolved_commit: ', 'resolved_commit: !unsupported '));
      const inventory = packInventory(directory);
      expect(inventory.diagnostics).toHaveLength(1);
      expect(inventory.packs.some((pack) => pack.state === 'locked')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('rejects unpinned and unreviewed sources without treating their text as provenance', () => {
    const directory = root(); writeFileSync(join(directory, 'apm.yml'), 'dependencies:\n  apm: [https://attacker.invalid/private-token]\n');
    const inventory = packInventory(directory); expect(inventory.packs[0]?.state).toBe('unsupported');
    expect(packInventoryText(directory)).not.toContain('private-token');
  });
});
