import { describe, expect, it } from 'vitest';
import type { AgentAssignment, AgentResult, RunManifest } from '../../packages/schemas/src/index.js';
import { formatCommand, nextActions } from '../../packages/runtime/src/next-actions.js';

const ROOT = '/home/me/.code-conductor/worktrees';
const assignment = (id: string, role: string, harness: string, authority = ['observe', 'recommend']): AgentAssignment => ({
  id, taskId: 'T-1', agentId: `${role}-${harness}`, role, stance: role === 'builder' ? 'constructive' : 'critical', provider: harness === 'codex' ? 'openai' : 'anthropic', harness, surface: 'cli', billingChannel: 'subscription', authority, dependsOn: [],
});
const result = (a: AgentAssignment, overrides: Partial<AgentResult> = {}): AgentResult => ({
  taskId: 'T-1', assignmentId: a.id, agentId: a.agentId, role: a.role, stance: a.stance, provider: a.provider, harness: a.harness, surface: 'cli', billingChannel: 'subscription',
  status: 'completed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'continue', ...overrides,
});
const builder = assignment('A-1', 'builder', 'codex', ['observe', 'recommend', 'modify_worktree']);
const reviewer = assignment('A-2', 'reviewer', 'claude', ['observe', 'recommend', 'review']);
const manifest = (overrides: Partial<RunManifest> = {}): RunManifest => ({
  runId: 'CC-1', task: { id: 'T-1', objective: "Fix the 'flaky' test", repository: '/work/repo', acceptanceCriteria: [], risk: 'R1', constraints: [], createdAt: '2026-10-16T00:00:00Z' },
  assignments: [builder, reviewer], results: [], gates: [], ...overrides,
});
const worktree = { assignmentId: 'A-1', path: `${ROOT}/abc/T-1/builder-codex`, branch: 'cc/T-1/builder-codex', baseSha: 'a'.repeat(40) };

describe('next actions', () => {
  it('asks for an interactive re-run when an approval was missing, with the exact command', () => {
    const actions = nextActions(manifest({
      results: [result(builder, { status: 'blocked', recommendation: 'human_required', blockers: ['Pre-action approval required…'] })],
      approvals: [{ requestDigest: 'f'.repeat(64), action: 'local_execution', runId: 'CC-1', taskId: 'T-1', assignmentId: 'A-1', recipient: 'openai/codex@cli', revision: 'b'.repeat(40), status: 'missing', approver: 'none', requestedAt: '2026-10-16T00:00:00Z', summary: 's' }],
      mergeDecision: { decision: 'human_required', rationale: 'approval missing', evidenceIds: [] },
    }), { worktreeRoot: ROOT });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'approve_interactively', surface: 'terminal', assignmentId: 'A-1' });
    expect(formatCommand(actions[0]!.commands![0]!)).toBe("cc run --repo /work/repo --risk R1 --objective 'Fix the '\\''flaky'\\'' test' --execute");
  });

  it('distinguishes a person declining from a missing approver', () => {
    const [action] = nextActions(manifest({
      results: [result(builder, { status: 'blocked' })],
      approvals: [{ requestDigest: 'f'.repeat(64), action: 'commit', runId: 'CC-1', taskId: 'T-1', assignmentId: 'A-1', recipient: 'git:cc/T-1/builder-codex', revision: 'b'.repeat(40), status: 'denied', approver: 'interactive-terminal', requestedAt: '2026-10-16T00:00:00Z', decidedAt: '2026-10-16T00:00:05Z', summary: 's' }],
    }));
    expect(action).toMatchObject({ kind: 'decide', title: 'You declined commit → git:cc/T-1/builder-codex' });
  });

  it('points an untrusted harness at official sign-in and the smoke test for its authority', () => {
    const [action] = nextActions(manifest({ results: [result(builder, { status: 'blocked', blockers: ['Harness codex surface cli has not passed Code Conductor workstation modify smoke validation.'] })] }));
    expect(action).toMatchObject({ kind: 'validate_harness', surface: 'official_client', commands: [['cc', 'harness-smoke', 'codex', '--mode', 'modify']] });
  });

  it('routes GitHub gatekeeping to GitHub and other external lanes to a manual handoff', () => {
    const gatekeeper = assignment('A-3', 'github_gatekeeper', 'copilot-github');
    const research = assignment('A-4', 'researcher', 'perplexity');
    const actions = nextActions(manifest({ assignments: [builder, gatekeeper, research], results: [result(gatekeeper, { status: 'awaiting_external' }), result(research, { status: 'awaiting_external' })] }));
    expect(actions.map((action) => [action.kind, action.surface])).toEqual([['github_review', 'github'], ['manual_handoff', 'manual']]);
    expect(actions[1]?.commands).toEqual([['cc', 'handoff', '--run', 'CC-1', '--assignment', 'A-4']]);
  });

  it('surfaces failing gates and blocking findings with their evidence', () => {
    const validator = assignment('A-5', 'validator', 'internal-validator');
    const actions = nextActions(manifest({
      assignments: [builder, reviewer, validator],
      results: [
        result(builder),
        result(reviewer, { findings: [{ id: 'F-1', severity: 'high', summary: 'SQL injection', evidenceIds: ['E-9'], blocking: true }] }),
        result(validator, { status: 'failed', tests: [{ gate: 'unit-tests', status: 'failed', evidenceIds: ['E-1'], summary: 'npm test failed (exit 1).' }] }),
      ],
    }));
    expect(actions.map((action) => [action.kind, action.evidenceIds])).toEqual([['resolve_findings', ['E-9']], ['fix_validation', ['E-1']]]);
  });

  it('offers native diff review and a person-run draft pull request when ready', () => {
    const actions = nextActions(manifest({ results: [result(builder), result(reviewer)], worktrees: [worktree], mergeDecision: { decision: 'ready', rationale: 'ok', evidenceIds: ['E-1'] } }), { worktreeRoot: ROOT });
    expect(actions.map((action) => action.kind)).toEqual(['review_changes', 'prepare_pull_request']);
    expect(actions[0]).toMatchObject({ surface: 'source_control', path: worktree.path });
    expect(actions[1]?.commands).toEqual([['git', '-C', worktree.path, 'push', '-u', 'origin', worktree.branch], ['gh', 'pr', 'create', '--draft', '--head', worktree.branch, '--fill']]);
  });

  it('ignores worktree paths outside the Code Conductor worktree root (for example from an imported manifest)', () => {
    const actions = nextActions(manifest({ results: [result(builder)], worktrees: [{ ...worktree, path: '/etc' }, { ...worktree, path: ROOT }] }), { worktreeRoot: ROOT });
    expect(actions.filter((action) => action.kind === 'review_changes')).toHaveLength(0);
  });

  it('does not duplicate dependency-blocked steps and tolerates partial manifests', () => {
    const actions = nextActions(manifest({ results: [result(reviewer, { status: 'blocked', blockers: ['Dependencies not completed: A-1'] })] }));
    expect(actions).toEqual([]);
    expect(nextActions({ runId: 'x', task: manifest().task } as RunManifest)).toEqual([]);
  });

  it('asks for a human decision when nothing else explains human_required', () => {
    const [action] = nextActions(manifest({ results: [result(builder), result(reviewer)], mergeDecision: { decision: 'human_required', rationale: 'R3 policy requires explicit human approval.', evidenceIds: [] } }));
    expect(action).toMatchObject({ kind: 'decide', detail: 'R3 policy requires explicit human approval.' });
  });
});

describe('formatCommand', () => {
  it('quotes only what needs quoting', () => {
    expect(formatCommand(['git', '-C', '/a b', 'diff', 'x'])).toBe("git -C '/a b' diff x");
    expect(formatCommand(['echo', '$(rm -rf /)', "it's"])).toBe("echo '$(rm -rf /)' 'it'\\''s'");
  });
});
