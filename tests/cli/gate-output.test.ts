import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';

// Runs the built CLI against a private, throwaway run store.
const HOME = mkdtempSync(join(tmpdir(), 'cc-gate-output-cli-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'gate-output', ...args], { encoding: 'utf8', env: { ...process.env, CODE_CONDUCTOR_HOME: HOME } });

describe('ccon gate-output', () => {
  it('prints a stored gate output after verifying it, and refuses one altered after the run (#94)', () => {
    const store = new RunStore(join(HOME, 'runs'));
    const stdout = 'Tests  2 failed | 10 passed\n\x1b[31mred\x1b[0m\n';
    const stderr = 'AssertionError: nope\n';
    const sha256 = createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update(stderr).digest()).digest('hex');
    store.saveToolOutput('RUN-1', { evidenceId: 'E-aaaaaaaa-1111', source: 'npm test (/usr/bin/npm)', status: 1, timedOut: false, truncated: false, stdout, stderr, sha256, digestMethod: 'streams' });

    const shown = cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111');
    expect(shown.status).toBe(0);
    // Not a terminal here, so the exact bytes are written.
    expect(shown.stdout).toBe(stdout);
    expect(shown.stderr).toContain('stored output intact; matches the evidence digest');
    expect(cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111', '--stderr').stdout).toBe(stderr);

    writeFileSync(join(HOME, 'runs', 'RUN-1', 'tool-output', 'E-aaaaaaaa-1111.stdout'), 'Tests  12 passed\n');
    const altered = cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111');
    expect(altered.status).toBe(1);
    expect(altered.stdout).toBe('');
    expect(altered.stderr).toContain('gate-output.altered');

    expect(cli('--run', 'RUN-1', '--evidence', 'E-missing-0000').status).toBe(1);
    expect(cli('--run', 'RUN-1').status).toBe(2);
  });
});
