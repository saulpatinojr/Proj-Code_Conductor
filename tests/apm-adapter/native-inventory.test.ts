import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryNativeCustomizations } from '../../packages/apm-adapter/src/index.js';

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-inventory-'));
  created.push(dir);
  return dir;
}
function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('provider-native inventory', () => {
  it('discovers agents and skills across ecosystems and scopes with names from frontmatter, TOML, or filename', () => {
    const repo = scratch();
    const home = scratch();
    write(join(repo, '.claude/agents/arch.md'), '---\nname: azure-architect\ndescription: Azure\n---\nbody\n');
    write(join(repo, '.github/agents/pr-reviewer.agent.md'), '---\ndescription: no name field\n---\nbody\n');
    write(join(repo, '.codex/agents/cost.toml'), 'name = "cost-analyzer"\ndescription = "FinOps"\ndeveloper_instructions = """x"""\n');
    write(join(repo, '.agents/skills/handoff/SKILL.md'), '---\nname: handoff-contract\ndescription: d\n---\n');
    write(join(home, '.copilot/agents/docs.agent.md'), '---\nname: docs-writer\ndescription: d\n---\n');
    write(join(home, '.claude/skills/review/SKILL.md'), '---\nname: review\ndescription: d\n---\n');

    const inventory = inventoryNativeCustomizations(repo, home);
    const summary = inventory.entries.map((entry) => `${entry.scope}:${entry.ecosystem}:${entry.kind}:${entry.name}`).sort();
    expect(summary).toEqual([
      'project:agent-skills:skill:handoff-contract',
      'project:claude:agent:azure-architect',
      'project:codex:agent:cost-analyzer',
      'project:copilot:agent:pr-reviewer',
      'user:claude:skill:review',
      'user:copilot:agent:docs-writer',
    ]);
    expect(inventory.lockPresent).toBe(false);
    expect(inventory.unmanagedProjectPaths).toEqual([]);
  });

  it('marks project files APM did not deploy as unmanaged using the lockfile', () => {
    const repo = scratch();
    write(join(repo, '.claude/agents/conductor.md'), '---\nname: conductor\ndescription: d\n---\n');
    write(join(repo, '.claude/agents/handmade.md'), '---\nname: handmade\ndescription: d\n---\n');
    write(join(repo, 'apm.lock.yaml'), "lockfile_version: '1'\nlocal_deployed_files:\n- .claude/agents/conductor.md\n");

    const inventory = inventoryNativeCustomizations(repo, scratch());
    const byName = Object.fromEntries(inventory.entries.map((entry) => [entry.name, entry.managedByApm]));
    expect(byName).toEqual({ conductor: true, handmade: false });
    expect(inventory.unmanagedProjectPaths).toEqual(['.claude/agents/handmade.md']);
  });

  it('never follows symlinks out of the scanned directories', () => {
    const repo = scratch();
    const outside = scratch();
    write(join(outside, 'secret.md'), '---\nname: escaped\ndescription: d\n---\n');
    mkdirSync(join(repo, '.claude/agents'), { recursive: true });
    symlinkSync(outside, join(repo, '.claude/agents/linked'), 'dir');
    const inventory = inventoryNativeCustomizations(repo, scratch());
    expect(inventory.entries.map((entry) => entry.name)).not.toContain('escaped');
  });
});
