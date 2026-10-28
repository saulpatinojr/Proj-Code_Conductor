import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionRequest, HarnessExecutionOutcome } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import { executeTask, createTask } from '../../packages/runtime/src/index.js';
import type { WorktreeHandle, WorktreeManager } from '../../packages/git/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { FakeAdapter, git, initRepository, SandboxWorktrees, WritingAdapter } from './fixtures.js';

// Execution now requires a pre-action approval (#44); these suites exercise the
// paths after a person approved. Denial/missing/stale paths: tests/runtime/approvals.test.ts.
const approveAll: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };

class TimeoutAdapter extends FakeAdapter {
  calls = 0;
  override async execute(_request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    this.calls += 1;
    return {
      harness: this.id,
      surface: this.executionSurface,
      command: this.command ?? 'fake',
      args: [],
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'timed out',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      timedOut: true,
    };
  }
}

describe('run execution', () => {
  it('executes an R1 run with fake paid-client adapters and deterministic gates after explicit trust', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('fake R1 run', 'R1', resolve('.')), {
        execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
      });
      const journal = readFileSync(join(temp, outcome.plan.runId, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const assignment of outcome.manifest.assignments) {
        const start = journal.findIndex((event) => event.type === 'assignment.started' && event.assignmentId === assignment.id);
        const end = journal.findIndex((event) => ['assignment.completed', 'validation.completed'].includes(event.type) && event.assignmentId === assignment.id);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
      }
      expect(outcome.manifest.results.map((r) => r.role)).toEqual(['builder', 'reviewer', 'validator']);
      expect(outcome.manifest.results[0]?.surface).toBe('cli');
      expect(outcome.manifest.gates.length).toBeGreaterThan(0);
      expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('stores every gate output with the run and, in summary mode, shows a verbatim-line summary with a recovery pointer (#94)', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const report = `${Array.from({ length: 1500 }, (_, index) => ` ✓ tests/case-${index}.test.ts`).join('\n')}\n ✗ tests/gates/profiles.test.ts > refuses -out\n   AssertionError: expected "allowed" to be "refused"\n     at tests/gates/profiles.test.ts:88:21\n\n Tests  1 failed | 1500 passed (1501)\n`;
      const run = async (toolOutput?: 'bounded' | 'summary') => {
        const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
        const store = new RunStore(join(temp, toolOutput ?? 'default'));
        const outcome = await executeTask(resolve('.'), createTask(`gate output ${toolOutput ?? 'default'}`, 'R1', resolve('.')), {
          execute: true, adapters, store, worktrees: new SandboxWorktrees(join(temp, `${toolOutput ?? 'default'}-wt`)),
          gateExecutor: () => ({ status: 1, stdout: report, stderr: '' }), isHarnessTrusted: () => true, approver: approveAll, ...(toolOutput ? { toolOutput } : {}),
        });
        return { store, outcome };
      };
      const bounded = await run();
      const summary = await run('summary');
      // The verdict is the same in both modes: it comes from the exit status.
      expect(bounded.outcome.manifest.gates.map((gate) => gate.status)).toEqual(summary.outcome.manifest.gates.map((gate) => gate.status));
      expect(summary.outcome.manifest.mergeDecision?.decision).toBe('changes_required');
      for (const { store, outcome } of [bounded, summary]) {
        const validator = outcome.manifest.results.find((result) => result.role === 'validator')!;
        for (const evidence of validator.evidence) {
          // The pointer names the stored record, which reads back intact and matching the evidence digest.
          expect(evidence.uri).toBe(join(store.root, outcome.manifest.runId, 'tool-output', `${evidence.id}.json`));
          expect(evidence.summary).toContain(`Full output: ${evidence.uri} (sha256 ${evidence.sha256})`);
          const stored = store.readToolOutput(outcome.manifest.runId, evidence.id);
          expect(stored.verification).toEqual({ storedIntact: true, matchesEvidence: true });
          expect(stored.record.stdout).toBe(report);
        }
      }
      const boundedEvidence = bounded.outcome.manifest.results.find((result) => result.role === 'validator')!.evidence[0]!;
      const summaryEvidence = summary.outcome.manifest.results.find((result) => result.role === 'validator')!.evidence[0]!;
      expect(boundedEvidence.summary).toContain(' ✓ tests/case-100.test.ts');
      expect(boundedEvidence.summary).not.toContain('AssertionError');
      expect(summaryEvidence.summary).toContain('Every line below is verbatim.');
      expect(summaryEvidence.summary).toContain('   AssertionError: expected "allowed" to be "refused"');
      expect(summaryEvidence.summary).toContain('     at tests/gates/profiles.test.ts:88:21');
      expect(summaryEvidence.summary).toContain(' Tests  1 failed | 1500 passed (1501)');
      expect(summaryEvidence.summary.length).toBeLessThan(boundedEvidence.summary.length / 2);
      const events = readFileSync(join(summary.store.root, summary.outcome.manifest.runId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data?: { mode?: string; estimatedTokens?: { original: number; shown: number; exact: boolean } } });
      const recorded = events.filter((event) => event.type === 'gate.output.recorded');
      expect(recorded.length).toBe(summary.outcome.manifest.gates.length);
      expect(recorded[0]!.data).toMatchObject({ mode: 'summary', estimatedTokens: { exact: false } });
      expect(recorded[0]!.data!.estimatedTokens!.shown).toBeLessThan(recorded[0]!.data!.estimatedTokens!.original);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('stops external execution when workstation trust is explicitly denied', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('blocked R1 run', 'R1', resolve('.')), { execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp), gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => false });
      expect(outcome.manifest.results[0]?.status).toBe('blocked');
      expect(outcome.manifest.mergeDecision?.decision).toBe('changes_required');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('fails closed when no workstation trust callback is supplied', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('untrusted by default R1 run', 'R1', resolve('.')), {
        execute: true,
        adapters,
        store: new RunStore(temp),
        worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      });
      expect(outcome.manifest.results[0]?.status).toBe('blocked');
      expect(outcome.manifest.results[0]?.blockers[0]).toContain('surface cli has not passed Code Conductor workstation');
      expect(outcome.manifest.mergeDecision?.decision).toBe('changes_required');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('blocks an adapter whose execution surface does not match the planned surface', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-surface-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai', 'fake-codex', 'acp')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('generic implementation', 'R1', resolve('.')), {
        execute: true,
        adapters,
        store: new RunStore(temp),
        worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }),
        isHarnessTrusted: () => true,
        approver: approveAll,
      });
      expect(outcome.manifest.results[0]?.status).toBe('blocked');
      expect(outcome.manifest.results[0]?.blockers[0]).toContain('configured for cli');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('does not automatically retry a timed-out external harness', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-timeout-test-'));
    const timedOut = new TimeoutAdapter('codex', 'openai');
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', timedOut], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('timeout R1 run', 'R1', resolve('.')), {
        execute: true,
        adapters,
        store: new RunStore(temp),
        worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }),
        isHarnessTrusted: () => true,
        approver: approveAll,
      });
      expect(timedOut.calls).toBe(1);
      expect(outcome.manifest.results[0]?.status).toBe('failed');
      expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('automatic retry was suppressed');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('commits builder changes inside a linked worktree, never in the checkout running the suite (#48)', async () => {
    const checkoutHead = git(resolve('.'), 'rev-parse', 'HEAD');
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-isolation-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new WritingAdapter('codex', 'openai')], ['claude', new WritingAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('isolated R1 run', 'R1', resolve('.')), {
        execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
      });
      expect(outcome.manifest.results[0]?.status).toBe('completed');
      expect(outcome.manifest.results[0]?.changes).toEqual(['agent-output.txt']);
      const worktreePath = outcome.worktrees[0]?.path ?? '';
      expect(git(worktreePath, 'show', '--name-only', '--format=%s', 'HEAD')).toContain('agent-output.txt');
      expect(outcome.manifest.gates.length).toBeGreaterThan(0);
      expect(git(resolve('.'), 'rev-parse', 'HEAD')).toBe(checkoutHead);
      expect(existsSync(join(resolve('.'), 'agent-output.txt'))).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  // #48 was reproduced in a contributor's own linked worktree, so a primary working
  // tree is not the only checkout the unsafe double could have been aimed at.
  it.each([
    ['a primary working tree', false, 'primary working tree'],
    ['a contributor\'s own linked worktree', true, 'not a Code Conductor agent branch'],
  ])('blocks a builder whose worktree is %s instead of committing it (#48)', async (_label, linked, reason) => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-foreign-tree-test-'));
    try {
      const repository = initRepository(join(temp, 'contributor-repo'));
      const checkout = linked ? join(temp, 'contributor-worktree') : repository;
      if (linked) git(repository, 'worktree', 'add', '-q', '-b', 'contributor-feature', checkout);
      writeFileSync(join(checkout, 'uncommitted-notes.txt'), 'work in progress\n');
      const head = git(checkout, 'rev-parse', 'HEAD');
      // The unsafe double from #48, aimed at a throwaway repository so a regression
      // cannot damage the checkout running the suite.
      const foreignTree = {
        root: temp,
        create: (_root: string, taskId: string, agentId: string): WorktreeHandle => ({ repositoryRoot: checkout, path: checkout, branch: `cc/${taskId}/${agentId}`, baseRef: 'HEAD', baseSha: head, taskId, agentId }),
        remove: (): void => {},
      } as unknown as WorktreeManager;
      const adapters = new Map<string, HarnessAdapter>([['codex', new WritingAdapter('codex', 'openai')], ['claude', new WritingAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('foreign tree R1 run', 'R1', resolve('.')), {
        execute: true, adapters, store: new RunStore(temp), worktrees: foreignTree,
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
      });
      expect(outcome.manifest.results[0]?.status).toBe('blocked');
      expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain(reason);
      expect(outcome.manifest.mergeDecision?.decision).toBe('changes_required');
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(checkout, 'status', '--porcelain')).toContain('uncommitted-notes.txt');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

// A client that reports completion and then exits with an error (2026-10-19 dogfood, #4).
class CrashingAfterReportAdapter extends FakeAdapter {
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const outcome = await super.execute(request);
    return request.assignment.role === 'reviewer' ? { ...outcome, exitCode: 1 } : outcome;
  }
}

describe('trust in a completion claim (2026-10-19 dogfood, #4)', () => {
  it('does not trust a completion claim from a client that exited with an error', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new CrashingAfterReportAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('crash after report', 'R1', resolve('.')), {
        execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
      });
      const reviewer = outcome.manifest.results.find((result) => result.role === 'reviewer');
      expect(reviewer?.status).toBe('failed');
      expect(reviewer?.recommendation).toBe('changes_required');
      expect(reviewer?.blockers.join(' ')).toContain('The claude client exited with code 1 after reporting completion');
      expect(outcome.manifest.mergeDecision?.decision).toBe('changes_required');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('runs the deterministic check for an R0 task: a builder and the internal validator (AGENTS.md section 5)', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-run-test-'));
    try {
      const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
      const outcome = await executeTask(resolve('.'), createTask('trivial R0 change', 'R0', resolve('.')), {
        execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
        gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
      });
      expect(outcome.manifest.results.map((result) => result.role)).toEqual(['builder', 'validator']);
      expect(outcome.manifest.gates.length).toBeGreaterThan(0);
      expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
