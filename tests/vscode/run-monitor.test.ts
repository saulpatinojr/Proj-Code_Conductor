import { describe, expect, it } from 'vitest';
import type { RunManifest } from '../../packages/schemas/src/index.js';
import { assignmentProgress, displayedDecision, nextProgressExpiry, progressEvents } from '../../apps/vscode/src/run-monitor.js';
const run: RunManifest = {
  runId: 'CC-test', task: { id: 'T', objective: 'task', risk: 'R1', acceptanceCriteria: [], constraints: [], createdAt: '2026-10-28T00:00:00Z' },
  assignments: [
    { id: 'build', taskId: 'T', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', authority: ['observe'], dependsOn: [] },
    { id: 'review', taskId: 'T', agentId: 'reviewer', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', billingChannel: 'subscription', authority: ['observe'], dependsOn: ['build'] },
  ], results: [], gates: [],
};
const at = '2026-10-28T01:00:00Z';
const start = { runId: run.runId, type: 'assignment.started', assignmentId: 'build', at } as const;
const now = Date.parse(at);
describe('stored execution overview', () => {
  it('derives dependency waiting and planned states without inventing execution', () => {
    expect(assignmentProgress(run, [], now).get('build')?.state).toBe('planned');
    expect(assignmentProgress(run, [], now).get('review')?.state).toBe('waiting');
  });
  it('reports observed starts, stale/clock-skew starts and incomplete result persistence honestly', () => {
    expect(nextProgressExpiry(run, [start], now)).toBe(now + 300000);
    expect(nextProgressExpiry(run, [start], now + 300000)).toBeUndefined();
    expect(assignmentProgress(run, [start], now + 1).get('build')?.state).toBe('running');
    expect(assignmentProgress(run, [start], now + 300000).get('build')?.state).toBe('unknown');
    expect(assignmentProgress(run, [start], now - 1).get('build')?.state).toBe('unknown');
    expect(assignmentProgress(run, [{ ...start, type: 'assignment.completed' }], now).get('build')?.state).toBe('unknown');
  });
  it('ignores foreign, malformed, hostile, unsupported and incomplete event lines', () => {
    const text = [null, { ...start, runId: 'foreign' }, { ...start, at: 'bad' }, { ...start, type: 'ready' }, start].map(JSON.stringify).join('\n') + '\n{';
    expect(progressEvents(text, run.runId)).toEqual([start]);
    expect(progressEvents('{bad}\n', run.runId)).toEqual([]);
  });
  it('does not display ready for missing results, rejected approval or failed gates', () => {
    const completed: RunManifest = { ...run, results: run.assignments.map((assignment) => ({ ...assignment, assignmentId: assignment.id, status: 'completed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'ready' })), gates: [{ blocking: true, gate: 'test', status: 'passed', evidenceIds: [] }], mergeDecision: { decision: 'ready', rationale: 'recorded', evidenceIds: [] } };
    expect(displayedDecision(completed)).toBe('ready');
    expect(displayedDecision({ ...completed, gates: [{ gate: 'legacy', status: 'passed', evidenceIds: [] }] })).toBe('human_required');
    expect(displayedDecision({ ...completed, gates: [{ blocking: false, gate: 'advisory', status: 'passed', evidenceIds: [] }] })).toBe('changes_required');
    expect(displayedDecision({ ...completed, gates: [...completed.gates, { blocking: true, gate: 'other', status: 'failed', evidenceIds: [] }] })).toBe('changes_required');
    expect(displayedDecision({ ...completed, gates: [...completed.gates, { blocking: false, gate: 'advisory', status: 'failed', evidenceIds: [] }] })).toBe('ready');
    expect(displayedDecision({ ...completed, task: { ...completed.task, risk: 'R3' } })).toBe('human_required');
    const rejected = structuredClone(completed); rejected.results[0]!.recommendation = 'changes_required';
    expect(displayedDecision(rejected)).toBe('changes_required');
    expect(displayedDecision({ ...completed, results: [] })).toBe('human_required');
    expect(displayedDecision({ ...completed, approvals: [{ status: 'denied' } as never] })).toBe('human_required');
    expect(displayedDecision({ ...completed, gates: [] })).toBe('changes_required');
    expect(displayedDecision({ ...completed, gates: [{ blocking: true, gate: 'test', status: 'failed', evidenceIds: [] }] })).toBe('changes_required');
    const blocked = structuredClone(completed); blocked.results[0]!.findings.push({ id: 'F', severity: 'high', summary: 'defect', blocking: true, evidenceIds: [] });
    expect(displayedDecision(blocked)).toBe('changes_required');
  });
});
