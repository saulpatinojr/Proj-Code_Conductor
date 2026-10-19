import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { SandboxWorktrees, WritingAdapter } from './fixtures.js';

const approveAll: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// A reviewer that leaves a file behind in the builder's worktree, as a client whose
// read-only mode did not hold (or a tool it started) would.
class LeakyReviewer extends WritingAdapter {
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    if (request.assignment.role === 'reviewer') writeFileSync(join(request.cwd, 'reviewer-left-this.txt'), 'not committed\n');
    return super.execute(request);
  }
}

async function run(claude: HarnessAdapter) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-read-only-edits-'));
  temps.push(temp);
  const gateCalls = { count: 0 };
  const worktrees = new SandboxWorktrees(temp);
  const outcome = await executeTask(resolve('.'), createTask('R1 with a read-only assignment', 'R1', resolve('.')), {
    execute: true, adapters: new Map<string, HarnessAdapter>([['codex', new WritingAdapter('codex', 'openai')], ['claude', claude]]), store: new RunStore(temp), worktrees,
    gateExecutor: () => { gateCalls.count += 1; return { status: 0, stdout: 'ok', stderr: '' }; },
    isHarnessTrusted: () => true, approver: approveAll,
  });
  return { outcome, gateCalls };
}

describe('gate evidence is bound to the committed branch (#111)', () => {
  it('runs no gate and needs a person when a read-only assignment left the builder worktree different from its commit', async () => {
    const { outcome, gateCalls } = await run(new LeakyReviewer('claude', 'anthropic'));
    expect(gateCalls.count).toBe(0);
    const validator = outcome.manifest.results.find((result) => result.role === 'validator');
    expect(validator).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(validator?.blockers.join(' ')).toContain('no longer matches its HEAD commit');
    expect(validator?.blockers.join(' ')).toContain('reviewer-left-this.txt');
    expect(validator?.blockers.join(' ')).toContain('reviewer');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
    // The builder's own commit stands; the stray file stays for the person to judge.
    expect(outcome.manifest.results.find((result) => result.role === 'builder')).toMatchObject({ status: 'completed' });
    expect(existsSync(join(outcome.worktrees[0]!.path, 'reviewer-left-this.txt'))).toBe(true);
  });

  it('runs the gates as before when the read-only assignment left the worktree untouched', async () => {
    const { outcome, gateCalls } = await run(new WritingAdapter('claude', 'anthropic'));
    expect(gateCalls.count).toBeGreaterThan(0);
    expect(outcome.manifest.results.find((result) => result.role === 'validator')?.status).toBe('completed');
  });
});
