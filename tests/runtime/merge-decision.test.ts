import { describe, expect, it } from 'vitest';
import type { GateExecution } from '../../packages/gates/src/index.js';
import { mergeDecision } from '../../packages/runtime/src/execute.js';
import type { AgentResult, ApprovalRecord, TaskEnvelope } from '../../packages/schemas/src/index.js';

// The merge decision must fail closed. The 2026-10-19 R1 dogfood review on the owner's
// workstation (run CC-20261019081440-41f45bed, #4) found four paths that reported `ready`:
// a completed reviewer recommending changes_required, a cancelled assignment, a run with
// no results, and a run in which no deterministic gate ran (R0 had no validator).

const task = (risk: TaskEnvelope['risk'] = 'R1'): TaskEnvelope => ({ id: 'T-1', objective: 'Review the foundation', repository: '.', acceptanceCriteria: [], risk, constraints: [], createdAt: '2026-10-19T08:00:00.000Z' });
const result = (role: string, overrides: Partial<AgentResult> = {}): AgentResult => ({
  taskId: 'T-1', assignmentId: `A-${role}`, agentId: `${role}-fake`, role, stance: 'neutral', provider: 'fake', harness: 'fake', surface: 'cli', billingChannel: 'subscription',
  status: 'completed', changes: [], tests: [], evidence: [{ id: `E-${role}`, kind: 'agent_output', source: role, summary: 'ok' }], findings: [], risks: [], blockers: [],
  recommendation: role === 'reviewer' ? 'ready' : 'continue', ...overrides,
});
const gate = (status: 'passed' | 'failed' = 'passed', blocking = true): GateExecution => ({ profile: 'test', blocking, result: { gate: 'unit-tests', status, evidenceIds: ['E-gate'] }, evidence: { id: 'E-gate', kind: 'test', source: 'npm test', summary: status, sha256: 'x' } });
const team = (): AgentResult[] => [result('builder'), result('reviewer'), result('validator', { billingChannel: 'local' })];
const approved: ApprovalRecord[] = [];

describe('merge decision fails closed', () => {
  it('is ready only when every result completed positively and a blocking gate passed', () => {
    const decision = mergeDecision(task(), team(), [gate()], approved);
    expect(decision.decision).toBe('ready');
    expect(decision.evidenceIds).toEqual(['E-builder', 'E-reviewer', 'E-validator', 'E-gate']);
  });

  it('is never ready without results', () => {
    expect(mergeDecision(task(), [], [gate()], approved)).toMatchObject({ decision: 'human_required', rationale: expect.stringContaining('No assignment produced a result') });
  });

  it('requires changes when a completed reviewer recommends them, even without a blocking finding', () => {
    const results = [result('builder'), result('reviewer', { recommendation: 'changes_required' }), result('validator', { billingChannel: 'local' })];
    expect(mergeDecision(task(), results, [gate()], approved)).toMatchObject({ decision: 'changes_required', rationale: 'An assignment recommends changes before merge.' });
  });

  it('requires changes when an assignment was cancelled', () => {
    const results = [result('builder', { status: 'cancelled', recommendation: 'continue' }), result('reviewer'), result('validator', { billingChannel: 'local' })];
    expect(mergeDecision(task(), results, [gate()], approved)).toMatchObject({ decision: 'changes_required', rationale: expect.stringContaining('cancelled') });
  });

  it('is never ready when no blocking deterministic gate ran and passed', () => {
    expect(mergeDecision(task('R0'), [result('builder')], [], approved)).toMatchObject({ decision: 'changes_required', rationale: expect.stringContaining('No blocking deterministic gate ran and passed') });
    // Advisory gates alone (a plan review, say) never establish readiness.
    expect(mergeDecision(task(), team(), [gate('passed', false)], approved).decision).toBe('changes_required');
    expect(mergeDecision(task(), team(), [gate('failed')], approved)).toMatchObject({ decision: 'changes_required', rationale: 'A blocking deterministic gate failed.' });
  });

  it('keeps the earlier precedence: an unresolved blocking finding blocks, R3 and R4 need a person', () => {
    const findings = [result('builder'), result('reviewer', { recommendation: 'changes_required', findings: [{ id: 'F-1', severity: 'high', summary: 'mergeDecision returns ready on changes_required', evidenceIds: ['E-reviewer'], blocking: true }] }), result('validator', { billingChannel: 'local' })];
    expect(mergeDecision(task(), findings, [gate()], approved).decision).toBe('blocked');
    expect(mergeDecision(task('R3'), team(), [gate()], approved)).toMatchObject({ decision: 'human_required', rationale: 'R3 policy requires explicit human approval.' });
    const denied = [{ requestDigest: 'd', action: 'local_execution', runId: 'R', taskId: 'T-1', revision: 'r', status: 'denied', approver: 'owner', requestedAt: '2026-10-19T08:00:00.000Z', summary: 's' } as ApprovalRecord];
    expect(mergeDecision(task(), team(), [gate()], denied).decision).toBe('human_required');
  });
});
