import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';

// Runs the built CLI against a private, throwaway run store.
const HOME = mkdtempSync(join(tmpdir(), 'cc-gate-output-cli-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'gate-output', ...args], { encoding: 'utf8', env: { ...process.env, CODE_CONDUCTOR_HOME: HOME } });

describe('ccon gate-output', () => {
  it('does not create absent private storage for a read-only lookup', () => {
    const missing = join(HOME, 'absent-home');
    const result = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'gate-output'], { encoding: 'utf8', env: { ...process.env, CODE_CONDUCTOR_HOME: missing } });
    expect(result.status).toBe(2); expect(existsSync(missing)).toBe(false);
  });
  it('refuses a manifest redirected from the requested run directory to another run', () => {
    const store = new RunStore(join(HOME, 'runs'));
    const runId = 'RUN-B'; const evidenceId = 'E-bbbbbbbb-2222'; const stdout = 'Never disclose another run'; const source = 'native test';
    const sha256 = createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update('').digest()).digest('hex');
    store.saveToolOutput(runId, { evidenceId, source, stdout, stderr: '', status: 1, timedOut: false, truncated: false, sha256, digestMethod: 'streams' });
    const manifest = { runId, task: { id: 'T', objective: 'Directory identity', acceptanceCriteria: [], risk: 'R1' as const, constraints: [], createdAt: new Date().toISOString() }, assignments: [], results: [{ taskId: 'T', assignmentId: 'A', agentId: 'validator', role: 'validator', stance: 'neutral' as const, provider: 'local', harness: 'internal', billingChannel: 'local' as const, status: 'completed' as const, changes: [], tests: [], evidence: [{ id: evidenceId, kind: 'test' as const, source, summary: 'captured', sha256 }], findings: [], risks: [], blockers: [], recommendation: 'changes_required' as const }], gates: [] };
    store.saveManifest(manifest);
    writeFileSync(join(store.runDirectory('RUN-A'), 'manifest.json'), JSON.stringify(manifest));
    const shown = cli('--run', 'RUN-A', '--evidence', evidenceId);
    expect(shown.status).toBe(1); expect(shown.stdout).toBe(''); expect(shown.stderr).toContain('identity');
  });
  it('prints a stored gate output after verifying it, and refuses one altered after the run (#94)', () => {
    const store = new RunStore(join(HOME, 'runs'));
    const stdout = 'Tests  2 failed | 10 passed\n\x1b[31mred\x1b[0m';
    const stderr = 'AssertionError: nope';
    const sha256 = createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update(stderr).digest()).digest('hex');
    store.saveToolOutput('RUN-1', { evidenceId: 'E-aaaaaaaa-1111', source: 'npm test (/usr/bin/npm)', status: 1, timedOut: false, truncated: false, stdout, stderr, sha256, digestMethod: 'streams' });

    store.saveManifest({ runId: 'RUN-1', task: { id: 'T', objective: 'CLI evidence', acceptanceCriteria: [], risk: 'R1', constraints: [], createdAt: new Date().toISOString() }, assignments: [], results: [{ taskId: 'T', assignmentId: 'A', agentId: 'validator', role: 'validator', stance: 'neutral', provider: 'local', harness: 'internal', billingChannel: 'local', status: 'completed', changes: [], tests: [], evidence: [{ id: 'E-aaaaaaaa-1111', kind: 'test', source: 'npm test (/usr/bin/npm)', summary: 'Recorded tool output', sha256 }], findings: [], risks: [], blockers: [], recommendation: 'changes_required' }], gates: [{ gate: 'test', status: 'failed', evidenceIds: ['E-aaaaaaaa-1111'] }] });

    const shown = cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111');
    expect(shown.status).toBe(0);
    // Not a terminal here, so the exact bytes are written.
    expect(shown.stdout).toBe(stdout);
    expect(shown.stderr).toContain('stored output intact; matches the evidence digest');
    expect(cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111', '--stderr').stdout).toBe(stderr);

    const headerPath = join(HOME, 'runs', 'RUN-1', 'tool-output', 'E-aaaaaaaa-1111.json');
    const header = JSON.parse(readFileSync(headerPath, 'utf8'));
    writeFileSync(headerPath, JSON.stringify({ ...header, status: 0 }));
    const changedMetadata = cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111');
    expect(changedMetadata.status).toBe(0);
    expect(changedMetadata.stderr).toContain('exit/timeout metadata is not verified');
    expect(changedMetadata.stderr).toContain('Manifest gate verdict: test: failed');

    writeFileSync(join(HOME, 'runs', 'RUN-1', 'tool-output', 'E-aaaaaaaa-1111.stdout'), 'Tests  12 passed\n');
    const altered = cli('--run', 'RUN-1', '--evidence', 'E-aaaaaaaa-1111');
    expect(altered.status).toBe(1);
    expect(altered.stdout).toBe('');
    expect(altered.stderr).toContain('gate-output.altered');

    expect(cli('--run', 'RUN-1', '--evidence', 'E-missing-0000').status).toBe(1);
    expect(cli('--run', 'RUN-1').status).toBe(2);
  });
});
