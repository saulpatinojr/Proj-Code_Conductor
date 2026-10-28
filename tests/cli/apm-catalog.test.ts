import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([['--select'], ['--select', ''], ['--select', '--repo', '.']])('rejects unusable catalog selections: %j', (...args) => {
  const result = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'apm-catalog', ...args], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--select requires a catalog version id.');
});
