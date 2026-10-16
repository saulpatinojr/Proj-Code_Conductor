import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { blockingGateFailure, detectGateProfiles, globMatch, runGates, type GateExecution } from '../../packages/gates/src/index.js';

describe('deterministic gates', () => {
  it('detects the Code Conductor profile', () => {
    expect(detectGateProfiles(resolve('.'))).toContain('code-conductor');
  });

  it('matches recursive globs without rewriting generated regex fragments', () => {
    expect(globMatch('main.tf', '**/*.tf')).toBe(true);
    expect(globMatch('modules/network/main.tf', '**/*.tf')).toBe(true);
    expect(globMatch('modules/network/main.ts', '**/*.tf')).toBe(false);
    expect(globMatch('roles/web/tasks/main.yml', 'roles/**/tasks/*.yml')).toBe(true);
    expect(globMatch('src/index.ts', 'src/*.ts')).toBe(true);
    expect(globMatch('src/nested/index.ts', 'src/*.ts')).toBe(false);
  });

  it('detects recursive gate profiles below the former depth cutoff', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-gates-'));
    try {
      const deepDirectory = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
      mkdirSync(deepDirectory, { recursive: true });
      writeFileSync(join(deepDirectory, 'main.tf'), 'terraform {}\n');
      const profiles = detectGateProfiles(root, {
        version: 1,
        profiles: {
          terraform: {
            detect: { any_glob: ['**/*.tf'] },
            gates: [],
          },
        },
      });
      expect(profiles).toContain('terraform');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not scan a repository tree when profiles use only exact-file detection', () => {
    const missingRoot = join(tmpdir(), `cc-no-scan-${Date.now()}`);
    expect(() => detectGateProfiles(missingRoot, {
      version: 1,
      profiles: {
        exact: {
          detect: { any_file: ['package.json'] },
          gates: [],
        },
      },
    })).not.toThrow();
    expect(detectGateProfiles(missingRoot, {
      version: 1,
      profiles: {
        exact: {
          detect: { any_file: ['package.json'] },
          gates: [],
        },
      },
    })).toEqual([]);
  });

  it('can execute gates through an injected deterministic executor', () => {
    const executions = runGates(resolve('.'), ['code-conductor'], (_cwd, command, args) => ({ status: 0, stdout: `${command} ${args.join(' ')} ok`, stderr: '' }));
    expect(executions.length).toBeGreaterThan(0);
    expect(blockingGateFailure(executions)).toBe(false);
    expect(executions.every((item) => item.result.status === 'passed')).toBe(true);
  });

  it('hashes the full untruncated gate output into evidence sha256', () => {
    const longOutput = 'x'.repeat(9000);
    const executions = runGates(resolve('.'), ['code-conductor'], () => ({ status: 0, stdout: longOutput, stderr: '' }));
    const expected = createHash('sha256').update(longOutput).digest('hex');
    expect(executions[0]?.evidence.sha256).toBe(expected);
    expect(executions[0]?.evidence.summary.length).toBeLessThan(longOutput.length);
  });

  it('blocks on a failed blocking gate', () => {
    const executions = runGates(resolve('.'), ['code-conductor'], () => ({ status: 1, stdout: '', stderr: 'failed' }));
    expect(blockingGateFailure(executions)).toBe(true);
  });

  it('does not block readiness for a failed advisory gate', () => {
    const advisoryFailure: GateExecution = {
      profile: 'advisory',
      blocking: false,
      result: { gate: 'advisory-check', status: 'failed', evidenceIds: ['E-advisory'], summary: 'advisory finding' },
      evidence: { id: 'E-advisory', kind: 'test', source: 'advisory-check', summary: 'advisory finding' },
    };
    expect(blockingGateFailure([advisoryFailure])).toBe(false);
  });
});
