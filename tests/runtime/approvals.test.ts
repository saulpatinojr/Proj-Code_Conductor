import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { assertContract, type ApprovalRequest } from '../../packages/schemas/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { git, SandboxWorktrees, WritingAdapter } from './fixtures.js';

const approveAll: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };

class CountingAdapter extends WritingAdapter {
  calls = 0;
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    this.calls += 1;
    return super.execute(request);
  }
}

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

async function run(approver: Approver | undefined, gateCalls = { count: 0 }, setup: { codex?: CountingAdapter; sandbox?: (repository: string) => void } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-approval-test-'));
  temps.push(temp);
  const codex = setup.codex ?? new CountingAdapter('codex', 'openai');
  const claude = new CountingAdapter('claude', 'anthropic');
  const adapters = new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]);
  const worktrees = new SandboxWorktrees(temp);
  setup.sandbox?.(worktrees.sandboxRepository);
  const outcome = await executeTask(resolve('.'), createTask('approval-gated R1 run', 'R1', resolve('.')), {
    execute: true, adapters, store: new RunStore(temp), worktrees,
    gateExecutor: () => { gateCalls.count += 1; return { status: 0, stdout: 'ok', stderr: '' }; },
    isHarnessTrusted: () => true,
    ...(approver ? { approver } : {}),
  });
  return { outcome, codex, claude, gateCalls, sandbox: worktrees.sandboxRepository };
}

// The builder's first start writes a file and fails without a result; the retry completes.
class FlakyBuilder extends CountingAdapter {
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    if (request.assignment.role === 'builder' && this.calls === 0) {
      this.calls += 1;
      writeFileSync(join(request.cwd, 'attempt1.txt'), 'partial\n');
      return { harness: this.id, surface: this.executionSurface, command: 'fake', args: [], exitCode: 1, signal: null, stdout: '', stderr: 'crashed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), timedOut: false };
    }
    return super.execute(request);
  }
}

function hook(repository: string, name: string, body: string, directory = join(repository, '.git', 'hooks')): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(directory, name), 0o755);
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
    const [builder, reviewer] = outcome.manifest.results;
    // Routing is asserted so this test cannot silently become vacuous.
    expect(builder).toMatchObject({ provider: 'openai', harness: 'codex', status: 'completed' });
    expect(reviewer).toMatchObject({ provider: 'anthropic', harness: 'claude', status: 'blocked' });
    expect(codex.calls).toBe(1);
    expect(claude.calls).toBe(0);
    expect(reviewer?.blockers[0]).toContain('denied');
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

  it('asks again before a retry and binds the retry to the changed working tree', async () => {
    const seen: ApprovalRequest[] = [];
    const codex = new FlakyBuilder('codex', 'openai');
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex });
    expect(codex.calls).toBe(2);
    const starts = seen.filter((request) => request.action === 'local_execution' && request.recipient === 'openai/codex@cli');
    expect(starts.map((request) => request.bindings.attempt)).toEqual(['1', '2']);
    expect(starts[1]?.bindings.tree).not.toBe(starts[0]?.bindings.tree);
    expect(starts[1]?.summary).toContain('Retry attempt 2');
    expect(outcome.manifest.results[0]?.status).toBe('completed');
  });

  it('does not retry when the retry is not approved', async () => {
    const codex = new FlakyBuilder('codex', 'openai');
    const { outcome } = await run(decideWith((request) => request.bindings.attempt !== '2'), { count: 0 }, { codex });
    expect(codex.calls).toBe(1);
    expect(outcome.manifest.results[0]?.status).toBe('failed');
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('automatic retry was not started');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('never runs repository hooks, so a hook cannot restage an approved commit or execute unapproved scripts', async () => {
    const seen: ApprovalRequest[] = [];
    const { outcome, sandbox } = await run(decideWith(() => true, seen), { count: 0 }, {
      sandbox: (repository) => {
        hook(repository, 'pre-commit', `echo injected > injected.txt && git add injected.txt; touch "${repository}/pre-commit-ran"`);
        hook(repository, 'post-checkout', `touch "${repository}/post-checkout-ran"`);
        hook(repository, 'post-commit', `touch "${repository}/post-commit-ran"`);
      },
    });
    const builder = outcome.manifest.results[0]!;
    expect(builder.status).toBe('completed');
    expect(builder.changes).toEqual(['agent-output.txt']);
    const worktree = outcome.worktrees[0]!;
    const approvedTree = seen.find((request) => request.action === 'commit')?.bindings.tree;
    expect(git(worktree.path, 'rev-parse', 'HEAD^{tree}')).toBe(approvedTree);
    for (const marker of ['pre-commit-ran', 'post-checkout-ran', 'post-commit-ran']) expect(existsSync(join(sandbox, marker))).toBe(false);
  });

  it('ignores a husky-style relative hooks path that the agent could edit', async () => {
    const { outcome, sandbox } = await run(approveAll, { count: 0 }, {
      sandbox: (repository) => {
        // Committed, so the agent's own worktree checks out (and could edit) the hook.
        hook(repository, 'pre-commit', `touch "${repository}/husky-ran"`, join(repository, '.husky'));
        git(repository, 'add', '.husky');
        git(repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'husky');
        git(repository, 'config', 'core.hooksPath', '.husky');
      },
    });
    expect(outcome.manifest.results[0]?.status).toBe('completed');
    expect(existsSync(join(sandbox, 'husky-ran'))).toBe(false);
  });

  it('rejects a provider start whose working tree changes while approval is pending', async () => {
    const tampering: Approver = {
      decide: async (requests) => {
        const start = requests.find((request) => request.action === 'local_execution' && request.recipient?.startsWith('openai/'));
        if (start) writeFileSync(join(start.repository, 'sneaked-in.txt'), 'x\n');
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome, codex } = await run(tampering);
    expect(codex.calls).toBe(0);
    expect(outcome.manifest.approvals?.slice(0, 2).map((record) => record.status)).toEqual(['changed', 'changed']);
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('changed after approval was requested');
  });

  it('rejects gate commands when the validation tree changes while approval is pending', async () => {
    const gateCalls = { count: 0 };
    const tampering: Approver = {
      decide: async (requests) => {
        const gates = requests.find((request) => request.recipient === 'local:deterministic-gates');
        if (gates) writeFileSync(join(gates.repository, 'late.txt'), 'x\n');
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome } = await run(tampering, gateCalls);
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.approvals?.at(-1)).toMatchObject({ recipient: 'local:deterministic-gates', status: 'changed' });
    expect(outcome.manifest.results.at(-1)).toMatchObject({ role: 'validator', status: 'blocked' });
  });

  it('removes the unused worktree and its branch when a start is refused', async () => {
    const { outcome, sandbox } = await run(undefined);
    expect(outcome.worktrees).toHaveLength(0);
    expect(git(sandbox, 'branch', '--list', 'cc/*')).toBe('');
    expect(git(sandbox, 'worktree', 'list', '--porcelain')).not.toContain('sandbox-worktrees');
  });

  it('fails closed without crashing when the approver throws', async () => {
    const { outcome, codex, claude } = await run({ decide: async () => { throw new Error('approver unavailable'); } });
    expect(codex.calls + claude.calls).toBe(0);
    expect(outcome.manifest.approvals?.[0]?.status).toBe('missing');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });
});
