import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planGates } from '../../packages/gates/src/index.js';

describe('optional bounded gate-preview discovery', () => {
  const config = { version: 1, profiles: { fixture: { detect: { any_glob: ['**/*.tf'] }, gates: [{ id: 'version', command: 'terraform', args: ['version'] }] } } };
  it('refuses a partial discovery on entry or depth limits, without changing default discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-gate-preview-'));
    try {
      writeFileSync(join(root, 'one.txt'), ''); writeFileSync(join(root, 'two.txt'), '');
      mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'main.tf'), '');
      expect(() => planGates(root, undefined, config, { maxEntries: 1, maxDepth: 12 })).toThrow(/entry budget/);
      expect(() => planGates(root, undefined, config, { maxEntries: 20, maxDepth: 0 })).toThrow(/depth/);
      expect(planGates(root, undefined, config)).toHaveLength(1);
      expect(planGates(root, undefined, config, { maxEntries: 20, maxDepth: 2 })).toHaveLength(1);
      // An explicit profile does not need a repository traversal.
      expect(planGates(root, ['fixture'], config, { maxEntries: 0, maxDepth: 0 })).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
