import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../scripts/agent-catalog-inventory.mjs';

describe('agent catalog immutable intake', () => {
  it('hashes every source file, classifies hints, and records exact/normalized duplicates without merging', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-agent-catalog-'));
    try {
      mkdirSync(join(root, 'agents'), { recursive: true });
      mkdirSync(join(root, 'skills', 'terraform'), { recursive: true });
      writeFileSync(join(root, 'agents', 'terraform-engineer.agent.md'), '# Terraform Engineer\n\nBuild Terraform.\n');
      writeFileSync(join(root, 'agents', 'terraform-engineer-copy.md'), '# Terraform Engineer\n\nBuild Terraform.\n');
      writeFileSync(join(root, 'agents', 'terraform-engineer-spacing.md'), '# Terraform Engineer  \r\n\r\n\r\nBuild Terraform.  \r\n');
      writeFileSync(join(root, 'skills', 'terraform', 'SKILL.md'), '---\nname: terraform\ndescription: Terraform skill\n---\n# Terraform Skill\n');
      writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));

      const ledger = buildInventory(root);
      expect(ledger.summary.files).toBe(5);
      expect(ledger.summary.exactDuplicates).toBe(1);
      expect(ledger.summary.normalizedDuplicateCandidates).toBe(1);
      expect(ledger.rules.originalsModified).toBe(false);
      expect(ledger.rules.automaticMergeAllowed).toBe(false);

      const agent = ledger.entries.find((entry) => entry.sourcePath === 'agents/terraform-engineer.agent.md');
      expect(agent?.classificationHints).toContain('agent');
      expect(agent?.title).toBe('Terraform Engineer');

      const originals = ledger.entries.filter((entry) => ['agents/terraform-engineer.agent.md', 'agents/terraform-engineer-copy.md'].includes(entry.sourcePath));
      const exact = originals.find((entry) => entry.exactDuplicateOf);
      const canonical = originals.find((entry) => !entry.exactDuplicateOf);
      expect(exact?.exactDuplicateOf).toBe(canonical?.sourcePath);
      expect(exact?.disposition).toBe('pending');

      const normalized = ledger.entries.find((entry) => entry.sourcePath === 'agents/terraform-engineer-spacing.md');
      expect(normalized?.normalizedDuplicateOf).toBe(canonical?.sourcePath);
      expect(normalized?.exactDuplicateOf).toBeNull();

      const skill = ledger.entries.find((entry) => entry.sourcePath === 'skills/terraform/SKILL.md');
      expect(skill?.classificationHints).toContain('skill');
      expect(skill?.frontmatterKeys).toEqual(['description', 'name']);

      const binary = ledger.entries.find((entry) => entry.sourcePath === 'binary.bin');
      expect(binary?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(binary?.notes[0]).toContain('not text-inspected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes and titles long lines in linear time', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-agent-catalog-long-'));
    try {
      // Blanks inside a line: quadratic for the trims this replaces (seconds at this size).
      writeFileSync(join(root, 'wide.agent.md'), `# Wide${' '.repeat(100_000)}Agent  \n\nBody${' '.repeat(100_000)}x\n`);
      const entry = buildInventory(root).entries.find((item) => item.sourcePath === 'wide.agent.md');
      expect(entry?.title).toBe(`Wide${' '.repeat(100_000)}Agent`);
      expect(entry?.normalizedSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses CLI output paths inside the immutable source corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-agent-catalog-immutable-'));
    try {
      writeFileSync(join(root, 'agent.md'), '# Agent\n');
      const output = join(root, 'ledger.json');
      const result = spawnSync(process.execPath, [resolve('scripts/agent-catalog-inventory.mjs'), '--source', root, '--out', output], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Refusing to write the inventory ledger inside the immutable source corpus');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records but never follows symlinks during intake', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'cc-agent-catalog-link-'));
    const external = mkdtempSync(join(tmpdir(), 'cc-agent-catalog-external-'));
    try {
      writeFileSync(join(external, 'secret.md'), '# Outside\n');
      symlinkSync(join(external, 'secret.md'), join(root, 'linked.md'));
      const ledger = buildInventory(root);
      const link = ledger.entries.find((entry) => entry.sourcePath === 'linked.md');
      expect(link?.kind).toBe('symlink');
      expect(link?.sha256).toBeNull();
      expect(link?.disposition).toBe('manual_review');
      expect(link?.notes[0]).toContain('not followed');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
