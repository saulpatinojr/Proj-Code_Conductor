import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { assertContract, type ApprovalRequest } from '../../packages/schemas/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { git, SandboxWorktrees, WritingAdapter } from './fixtures.js';

class CountingAdapter extends WritingAdapter {
  calls = 0;
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    this.calls += 1;
    return super.execute(request);
  }
}

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

async function run(approver: Approver | undefined, gateCalls = { count: 0 }) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-approval-test-'));
  temps.push(temp);
  const codex = new CountingAdapter('codex', 'openai');
  const claude = new CountingAdapter('claude', 'anthropic');
  const adapters = new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]);
  const outcome = await executeTask(resolve('.'), createTask('approval-gated R1 run', 'R1', resolve('.')), {
    execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
    gateExecutor: () => { gateCalls.count += 1; return { status: 0, stdout: 'ok', stderr: '' }; },
    isHarnessTrusted: () => true,
    ...(approver ? { approver } : {}),
  });
  return { outcome, codex, claude, gateCalls };
}

const decideWith = (rule: (request: ApprovalRequest) => boolean, seen: ApprovalRequest[] = []): Approver => ({
  decide: async (requests) => { seen.push(...requests); return { approved: requests.every(rule), approver: 'test' }; },
});

describe('pre-action approval enforcement (#44)', () => {
  it('workstation trust alone executes nothing when no approver is available', async () => {
    const { outcome, codex, claude, gateCalls } = await run(undefined);
    expect(codex.calls + claude.calls).toBe(0);
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.results[0]).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('no interactive approver');
    expect(outcome.manifest.approvals?.map((record) => [record.action, record.status])).toEqual([['local_execution', 'missing'], ['context_disclosure', 'missing']]);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
    // The fresh builder worktree held nothing and is removed with its branch.
    expect(outcome.worktrees).toHaveLength(0);
    assertContract('RunManifest', outcome.manifest);
  });

  it('records every approved action with bound, non-secret evidence', async () => {
    const seen: ApprovalRequest[] = [];
    const { outcome, codex, claude, gateCalls } = await run(decideWith(() => true, seen));
    expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
    expect(codex.calls + claude.calls).toBe(2);
    expect(gateCalls.count).toBeGreaterThan(0);
    expect(outcome.manifest.approvals?.map((record) => record.action)).toEqual(['local_execution', 'context_disclosure', 'commit', 'local_execution', 'context_disclosure', 'local_execution']);
    expect(outcome.manifest.approvals?.every((record) => record.status === 'approved' && /^[a-f0-9]{64}$/.test(record.requestDigest))).toBe(true);
    const disclosure = seen.find((request) => request.action === 'context_disclosure');
    expect(disclosure?.bindings.prompt).toMatch(/^[a-f0-9]{64}$/);
    // The prompt itself is never stored in approval evidence, only its digest and size.
    expect(JSON.stringify(outcome.manifest.approvals)).not.toContain('approval-gated R1 run');
    const commit = seen.find((request) => request.action === 'commit');
    expect(commit?.bindings).toMatchObject({ branch: outcome.worktrees[0]?.branch, baseSha: outcome.worktrees[0]?.baseSha });
    expect(commit?.bindings.tree).toBe(git(outcome.worktrees[0]!.path, 'rev-parse', 'HEAD^{tree}'));
    assertContract('RunManifest', outcome.manifest);
  });

  it('requires a distinct disclosure approval per provider', async () => {
    const { outcome, codex, claude } = await run(decideWith((request) => !request.recipient?.startsWith('anthropic/')));
    const builder = outcome.manifest.results[0]!;
    const reviewer = outcome.manifest.results[1]!;
    const builderAdapter = builder.harness === 'codex' ? codex : claude;
    const reviewerAdapter = reviewer.harness === 'codex' ? codex : claude;
    if (builder.provider === 'anthropic') {
      expect(builderAdapter.calls).toBe(0);
      expect(builder.status).toBe('blocked');
    } else {
      expect(builderAdapter.calls).toBe(1);
      expect(reviewer.provider).toBe('anthropic');
      expect(reviewerAdapter.calls).toBe(0);
      expect(reviewer.blockers[0]).toContain('denied');
    }
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('preserves denied commits uncommitted in the agent worktree for native review', async () => {
    const { outcome, gateCalls } = await run(decideWith((request) => request.action !== 'commit'));
    const builder = outcome.manifest.results[0]!;
    expect(builder).toMatchObject({ status: 'blocked', recommendation: 'human_required', changes: [] });
    expect(builder.blockers.join(' ')).toContain('preserved uncommitted');
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
    expect(git(worktree.path, 'status', '--porcelain')).toContain('agent-output.txt');
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('rejects a commit approval when the diff changes after it was requested', async () => {
    let worktreePath = '';
    const tampering: Approver = {
      decide: async (requests) => {
        const commit = requests.find((request) => request.action === 'commit');
        if (commit) { worktreePath = commit.repository; writeFileSync(join(worktreePath, 'late-edit.txt'), 'changed during review\n'); }
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome } = await run(tampering);
    const commitRecord = outcome.manifest.approvals?.find((record) => record.action === 'commit');
    expect(commitRecord?.status).toBe('changed');
    expect(outcome.manifest.results[0]?.status).toBe('blocked');
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
    expect(git(worktreePath, 'status', '--porcelain')).toContain('late-edit.txt');
  });

  it('does not run repository gate commands without approval', async () => {
    const { outcome, gateCalls } = await run(decideWith((request) => request.recipient !== 'local:deterministic-gates'));
    expect(gateCalls.count).toBe(0);
    const validator = outcome.manifest.results.find((result) => result.role === 'validator');
    expect(validator).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(outcome.manifest.gates).toHaveLength(0);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('treats an approval given after its window as stale', async () => {
    let clock = Date.parse('2026-10-16T00:00:00Z');
    const temp = mkdtempSync(join(tmpdir(), 'cc-approval-expiry-test-'));
    temps.push(temp);
    const codex = new CountingAdapter('codex', 'openai');
    const claude = new CountingAdapter('claude', 'anthropic');
    const outcome = await executeTask(resolve('.'), createTask('expired approval run', 'R1', resolve('.')), {
      execute: true, adapters: new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]), store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
      gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true,
      approver: { decide: async () => { clock += 120_000; return { approved: true, approver: 'test' }; } },
      approvalTtlMs: 60_000, now: () => clock,
    });
    expect(codex.calls + claude.calls).toBe(0);
    expect(outcome.manifest.approvals?.[0]?.status).toBe('expired');
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('expired');
  });
});
