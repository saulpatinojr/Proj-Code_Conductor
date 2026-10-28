import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sameRepository } from '../../apps/vscode/src/run-scope.js';

describe('repository scoping', () => {
  it('rejects foreign, missing, relative and legacy associations and accepts canonical aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-scope-'));
    const other = mkdtempSync(join(tmpdir(), 'cc-foreign-'));
    try {
      expect(sameRepository(root, root)).toBe(true);
      expect(sameRepository(other, root)).toBe(false);
      for (const value of [undefined, null, {}, '.', root + '/absent']) expect(sameRepository(value, root)).toBe(false);
      expect(sameRepository(root, undefined)).toBe(false);
      symlinkSync(root, join(other, 'alias'), 'junction');
      expect(sameRepository(join(other, 'alias'), root)).toBe(true);
    } finally { rmSync(other, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
});
