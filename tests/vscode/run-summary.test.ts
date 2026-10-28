import { describe, expect, it } from 'vitest';
import type { RunManifest } from '../../packages/schemas/src/index.js';
import type { NextAction } from '../../packages/runtime/src/next-actions.js';
import { runStartedAt, runSummaryMarkdown, runTitle } from '../../apps/vscode/src/run-summary.js';

const manifest: RunManifest = {
  runId: 'CC-20261020054327-50bb27f7',
  task: { id: 'T-1', objective: 'Add a unit test for change-summary shortList; do not change product code', acceptanceCriteria: [], risk: 'R1', repository: 'C:\\work\\repo', createdAt: '2026-10-20T05:43:27Z' },
  assignments: [
    { id: 'A-1', taskId: 'T-1', agentId: 'builder-codex', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', surface: 'cli', billingChannel: 'subscription', authority: ['observe', 'modify_worktree'], dependsOn: [] },
    { id: 'A-2', taskId: 'T-1', agentId: 'reviewer-claude', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', surface: 'cli', billingChannel: 'subscription', authority: ['observe', 'review'], dependsOn: ['A-1'] },
  ],
  results: [
    { taskId: 'T-1', assignmentId: 'A-1', agentId: 'builder-codex', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', status: 'completed', changes: ['tests/x.test.ts'], tests: [], evidence: [], findings: [], risks: ['Full validation incomplete in the sandbox'], blockers: [], recommendation: 'review', notVerified: ['VS Code bundle build'] },
    { taskId: 'T-1', assignmentId: 'A-2', agentId: 'reviewer-claude', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', billingChannel: 'subscription', status: 'completed', changes: [], tests: [], evidence: [], findings: [{ id: 'F-1', severity: 'low', summary: 'No boundary case at ten entries\u001b[2J', evidenceIds: [], blocking: false }], risks: [], blockers: [], recommendation: 'ready' },
  ],
  gates: [{ gate: 'unit-tests', status: 'passed', evidenceIds: ['E-1'], summary: 'npm test passed.' }, { gate: 'typecheck', status: 'failed', evidenceIds: ['E-2'] }],
  approvals: [{ requestDigest: 'a'.repeat(64), action: 'commit', runId: 'CC-20261020054327-50bb27f7', taskId: 'T-1', assignmentId: 'A-1', recipient: 'git:cc/T-1/builder-codex', revision: 'b'.repeat(40), status: 'approved', approver: 'interactive-terminal', requestedAt: '2026-10-20T05:50:00Z', decidedAt: '2026-10-20T05:50:04Z', expiresAt: '2026-10-20T06:50:00Z', summary: 'Commit on cc/T-1/builder-codex' }],
  worktrees: [{ assignmentId: 'A-1', path: 'C:\\w\\builder-codex', branch: 'cc/T-1/builder-codex', baseSha: 'c'.repeat(40) }],
  mergeDecision: { decision: 'ready', rationale: 'Required assignments completed and blocking deterministic gates passed.', evidenceIds: ['E-1'] },
};
const actions: NextAction[] = [{ kind: 'prepare_pull_request', title: 'Open a draft pull request', detail: 'ccon pr previews the branch', surface: 'github', assignmentId: 'A-1', evidenceIds: [], commands: [['ccon', 'pr', '--run', 'CC-20261020054327-50bb27f7', '--assignment', 'A-1']] }];

describe('run summary document', () => {
  it('reads the start time and a short title from the record', () => {
    expect(runStartedAt('CC-20261020054327-50bb27f7')).toBe('2026-10-20 05:43 UTC');
    expect(runStartedAt('import-abc')).toBe('import-abc');
    expect(runTitle(manifest, 30)).toBe('Add a unit test for change-su…');
    expect(runTitle(manifest, 200)).toBe(manifest.task.objective);
  });

  it('renders decision, assignments, gates, next actions, findings, risks, unverified checks, worktrees and approvals, with control characters removed', () => {
    const text = runSummaryMarkdown(manifest, actions);
    expect(text).toContain('# Run CC-20261020054327-50bb27f7');
    expect(text).toContain('**Decision:** `ready`');
    expect(text).toContain('| builder | builder-codex | completed | review |');
    expect(text).toContain('| reviewer | reviewer-claude | completed | ready |');
    expect(text).toContain('✅ `unit-tests` passed — npm test passed.');
    expect(text).toContain('❌ `typecheck` failed');
    expect(text).toContain('**Open a draft pull request** — ccon pr previews the branch');
    expect(text).toContain('`ccon pr --run CC-20261020054327-50bb27f7 --assignment A-1`');
    expect(text).toContain('**low** (reviewer, F-1): No boundary case at ten entries');
    expect(text).not.toMatch(/\u001b/u);
    expect(text).toContain('- builder: Full validation incomplete in the sandbox');
    expect(text).toContain('## Not verified by the agents');
    expect(text).toContain('`cc/T-1/builder-codex` at `C:\\w\\builder-codex`');
    expect(text).toContain('✅ commit → git:cc/T-1/builder-codex (approved)');
    expect(text.trim().endsWith('Read-only; nothing here runs anything._')).toBe(true);
  });


  it('shows observed execution consistently and keeps untrusted references inert', () => {
    const running = structuredClone(manifest);
    running.results = []; running.gates = []; delete running.mergeDecision;
    const text = runSummaryMarkdown(running, [], [{ runId: running.runId, at: new Date().toISOString(), type: 'assignment.started', assignmentId: running.assignments[0]!.id }]);
    expect(text).toContain('execution observed; no final decision recorded');
    expect(text).toContain('| builder | builder-codex | running |');
    expect(text).not.toContain('nothing was executed');
    running.results = structuredClone(manifest.results);
    running.results[0]!.evidence = [{ id: 'E-evil', kind: 'other', source: '[click](https://attacker.invalid)', summary: '<img src=x> | injected' }];
    const escaped = runSummaryMarkdown(running, []);
    expect(escaped).toContain('\\[click\\](https://attacker.invalid)');
    expect(escaped).toContain('\\<img src=x\\> \\| injected');
  });
  it('describes a planned run that executed nothing', () => {
    const planned: RunManifest = { ...manifest, results: [], gates: [], approvals: [], worktrees: [], mergeDecision: undefined } as RunManifest;
    const text = runSummaryMarkdown(planned, []);
    expect(text).toContain('**Decision:** `planned` — nothing was executed');
    expect(text).toContain('| builder | builder-codex | planned |  |');
    expect(text).not.toContain('## Deterministic gates');
  });
});
