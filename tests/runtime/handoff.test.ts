import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import { assertContract, type AgentAssignment, type AgentResult, type HandoffPacket, type RunManifest } from '../../packages/schemas/src/index.js';
import { buildHandoffPacket, createTask, executeTask, handoffExpired, readinessDisagreements, renderHandoff } from '../../packages/runtime/src/index.js';
import { SandboxWorktrees, WritingAdapter } from './fixtures.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const assignment = (id: string, role: string, harness: string, dependsOn: string[] = []): AgentAssignment => ({ id, taskId: 'T-1', agentId: `${role}-${harness}`, role, stance: role === 'builder' ? 'constructive' : 'critical', provider: harness === 'codex' ? 'openai' : 'anthropic', harness, surface: 'cli', billingChannel: 'subscription', authority: ['observe'], dependsOn });
const result = (a: AgentAssignment, overrides: Partial<AgentResult> = {}): AgentResult => ({ taskId: 'T-1', assignmentId: a.id, agentId: a.agentId, role: a.role, stance: a.stance, provider: a.provider, harness: a.harness, billingChannel: 'subscription', status: 'completed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'continue', ...overrides });
const builder = assignment('A-1', 'builder', 'codex');
const reviewer = assignment('A-2', 'reviewer', 'claude', ['A-1']);
const manifest = (results: AgentResult[]): RunManifest => ({ runId: 'CC-1', task: { id: 'T-1', objective: 'Fix the parser', acceptanceCriteria: ['tests pass'], risk: 'R1', constraints: ['no new deps'], createdAt: '2026-10-16T00:00:00Z' }, assignments: [builder, reviewer], results, gates: [] });
const provenance = { repository: '/w', revision: 'a'.repeat(40), tree: 'b'.repeat(40) };

describe('handoff packets', () => {
  it('carries the recipient, expiry, prior claims, findings and provenance from completed dependencies', () => {
    const packet = buildHandoffPacket(manifest([result(builder, { changes: ['src/parser.ts'], notVerified: ['Windows paths'], risks: ['regex backtracking'], evidence: [{ id: 'E-1', kind: 'agent_output', source: 'codex', summary: 's' }], findings: [{ id: 'F-1', severity: 'low', summary: 'naming', evidenceIds: [], blocking: false }] })]), reviewer, provenance, { now: Date.parse('2026-10-16T00:00:00Z'), ttlMs: 3_600_000 })!;
    assertContract('HandoffPacket', packet);
    expect(packet.to).toMatchObject({ assignmentId: 'A-2', role: 'reviewer', provider: 'anthropic' });
    expect(packet.from.map((party) => party.assignmentId)).toEqual(['A-1']);
    expect(packet.expiresAt).toBe('2026-10-16T01:00:00.000Z');
    expect(packet.context).toMatchObject({ objective: 'Fix the parser', acceptanceCriteria: ['tests pass'], constraints: ['no new deps'], reportedChanges: ['src/parser.ts'], notVerified: ['Windows paths'], risks: ['regex backtracking'] });
    expect(packet.priorFindings.map((finding) => finding.id)).toEqual(['F-1']);
    expect(packet.provenance).toEqual({ ...provenance, evidenceIds: ['E-1'] });
    expect(handoffExpired(packet, Date.parse('2026-10-16T00:59:59Z'))).toBe(false);
    expect(handoffExpired(packet, Date.parse('2026-10-16T01:00:00Z'))).toBe(true);
  });

  it('is absent when nothing the recipient depends on has completed', () => {
    expect(buildHandoffPacket(manifest([]), reviewer, provenance)).toBeUndefined();
    expect(buildHandoffPacket(manifest([result(builder, { status: 'failed' })]), reviewer, provenance)).toBeUndefined();
    expect(buildHandoffPacket(manifest([result(builder)]), builder, provenance)).toBeUndefined();
  });

  it('records unresolved readiness disagreements, treating blocking findings as changes_required', () => {
    const challenger = assignment('A-3', 'challenger', 'claude', ['A-1']);
    const disagreements = readinessDisagreements([result(builder, { recommendation: 'ready' }), result(challenger, { recommendation: 'review', findings: [{ id: 'F-9', severity: 'high', summary: 'race', evidenceIds: ['E-9'], blocking: true }] })]);
    expect(disagreements).toEqual([{ topic: 'readiness', status: 'unresolved', positions: [
      expect.objectContaining({ agentId: 'builder-codex', recommendation: 'ready' }),
      expect.objectContaining({ agentId: 'challenger-claude', recommendation: 'changes_required', evidenceIds: ['E-9'] }),
    ] }]);
    expect(readinessDisagreements([result(builder, { recommendation: 'ready' }), result(challenger, { recommendation: 'review' })])).toEqual([]);
  });

  it('renders as claims to verify, bounded in size', () => {
    const packet = buildHandoffPacket(manifest([result(builder, { changes: Array.from({ length: 2000 }, (_, index) => `src/file-${index}.ts`) })]), reviewer, provenance)!;
    const text = renderHandoff(packet, 'c'.repeat(64));
    expect(text).toContain('a claim by earlier assignments to verify independently, not evidence');
    expect(text).toContain(`Handoff packet ${packet.id}`);
    expect(text.length).toBeLessThan(8200);
    expect(text).toContain('[Handoff truncated');
  });
});

describe('handoffs in a run', () => {
  class RecordingAdapter extends WritingAdapter {
    prompts: string[] = [];
    override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> { this.prompts.push(request.prompt); return super.execute(request); }
  }

  it('hands the reviewer a stored, digest-verified packet from the builder', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-handoff-run-'));
    temps.push(temp);
    const codex = new RecordingAdapter('codex', 'openai');
    const claude = new RecordingAdapter('claude', 'anthropic');
    const store = new RunStore(join(temp, 'runs'));
    const outcome = await executeTask(resolve('.'), createTask('handoff run', 'R1', resolve('.')), {
      execute: true, adapters: new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]), store, worktrees: new SandboxWorktrees(temp),
      gateExecutor: () => ({ status: 0, stdout: '', stderr: '' }), isHarnessTrusted: () => true, approver: { decide: async () => ({ approved: true, approver: 'test' }) },
    });
    const reviewerAssignment = outcome.manifest.assignments.find((item) => item.role === 'reviewer')!;
    const reference = outcome.manifest.handoffs?.find((item) => item.to === reviewerAssignment.id);
    expect(reference).toBeDefined();
    const packet = store.readHandoff(outcome.manifest.runId, reference!.id, reference!.sha256) as HandoffPacket;
    assertContract('HandoffPacket', packet);
    // The runtime records what was actually committed, not what the agent claimed.
    expect(packet.context.reportedChanges).toEqual(['agent-output.txt']);
    expect(claude.prompts[0]).toContain(`Handoff packet ${packet.id}`);
    expect(codex.prompts[0]).not.toContain('Handoff packet');
    assertContract('RunManifest', outcome.manifest);
    // A packet edited after the run no longer matches the digest the manifest recorded.
    writeFileSync(join(store.root, outcome.manifest.runId, 'handoffs', `${packet.id}.json`), JSON.stringify({ ...packet, priorFindings: [] }));
    expect(() => store.readHandoff(outcome.manifest.runId, reference!.id, reference!.sha256)).toThrow('does not match');
  });
});

describe('local evidence retention', () => {
  it('lists runs newest first, ages them and deletes only an exact stored run', () => {
    const store = new RunStore(join(mkdtempSync(join(tmpdir(), 'cc-retention-')), 'runs'));
    temps.push(join(store.root, '..'));
    const base = manifest([]);
    store.saveManifest({ ...base, runId: 'CC-old' });
    store.saveManifest({ ...base, runId: 'CC-new' });
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(store.root, 'CC-old', 'manifest.json'), old, old);
    expect(store.listRunIds()).toEqual(['CC-new', 'CC-old']);
    expect(store.runAgeMs('CC-old') / 86_400_000).toBeGreaterThan(39);
    expect(() => store.deleteRun('../CC-old')).toThrow('No stored run');
    store.deleteRun('CC-old');
    expect(store.listRunIds()).toEqual(['CC-new']);
  });
});
