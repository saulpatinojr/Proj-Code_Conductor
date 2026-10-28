import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apmTargets } from '../../packages/apm-adapter/src/index.js';

describe('APM adapter', () => {
  it('preserves spawn diagnostics when the APM CLI cannot be found', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = apmTargets(resolve('.'));
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.errorCode).toBe('ENOENT');
      expect(result.stderr).toMatch(/not found on PATH/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
