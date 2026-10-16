import { randomUUID } from 'node:crypto';
import type { AgentAssignment, AgentResult, Disagreement, HandoffPacket, HandoffParty, RunManifest } from '@code-conductor/schemas';

/** Packets expire so stale context is never handed to a later, unrelated run step. */
export const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RENDERED = 8000;
const POSITIVE = new Set<AgentResult['recommendation']>(['continue', 'review', 'ready']);
const NEGATIVE = new Set<AgentResult['recommendation']>(['changes_required', 'human_required']);

function party(assignment: AgentAssignment): HandoffParty {
  return { assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}) };
}

/** Readiness positions that conflict among completed results, until evidence or arbitration resolves them. */
export function readinessDisagreements(results: readonly AgentResult[]): Disagreement[] {
  const positions = results.filter((result) => result.status === 'completed').map((result) => ({
    agentId: result.agentId, role: result.role, stance: result.stance,
    recommendation: result.findings.some((finding) => finding.blocking) ? 'changes_required' as const : result.recommendation,
    evidenceIds: [...new Set([...result.evidence.map((item) => item.id), ...result.findings.flatMap((finding) => finding.evidenceIds)])],
  }));
  const conflicting = positions.some((position) => POSITIVE.has(position.recommendation)) && positions.some((position) => NEGATIVE.has(position.recommendation));
  return conflicting ? [{ topic: 'readiness', status: 'unresolved', positions }] : [];
}

/**
 * Build the packet a recipient assignment receives from the completed work it depends on.
 * Returns undefined when the assignment depends on nothing completed.
 */
export function buildHandoffPacket(manifest: RunManifest, recipient: AgentAssignment, provenance: { repository: string; revision: string; tree: string }, options: { now?: number; ttlMs?: number } = {}): HandoffPacket | undefined {
  const sources = manifest.results.filter((result) => recipient.dependsOn.includes(result.assignmentId) && result.status === 'completed');
  if (!sources.length) return undefined;
  const assignments = new Map(manifest.assignments.map((assignment) => [assignment.id, assignment]));
  const now = options.now ?? Date.now();
  const unique = (values: string[]): string[] => [...new Set(values)];
  return {
    version: 1,
    id: `HP-${randomUUID()}`,
    runId: manifest.runId,
    taskId: manifest.task.id,
    from: sources.map((result) => assignments.get(result.assignmentId)).filter((assignment): assignment is AgentAssignment => Boolean(assignment)).map(party),
    to: party(recipient),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_HANDOFF_TTL_MS)).toISOString(),
    context: {
      objective: manifest.task.objective,
      acceptanceCriteria: manifest.task.acceptanceCriteria,
      constraints: manifest.task.constraints,
      reportedChanges: unique(sources.flatMap((result) => result.changes)),
      notVerified: unique(sources.flatMap((result) => result.notVerified ?? [])),
      risks: unique(sources.flatMap((result) => result.risks)),
    },
    priorFindings: sources.flatMap((result) => result.findings),
    disagreements: readinessDisagreements(manifest.results),
    provenance: { ...provenance, evidenceIds: unique(sources.flatMap((result) => result.evidence.map((item) => item.id))) },
  };
}

export function handoffExpired(packet: Pick<HandoffPacket, 'expiresAt'>, now = Date.now()): boolean {
  return !(Date.parse(packet.expiresAt) > now);
}

/** Prompt section for a packet: bounded, and explicit that prior work is a claim to verify. */
export function renderHandoff(packet: HandoffPacket, sha256?: string): string {
  const list = (label: string, values: string[]): string => (values.length ? `${label}: ${values.join('; ')}` : `${label}: none reported`);
  const lines = [
    `Handoff packet ${packet.id} (v${packet.version}${sha256 ? `, sha256 ${sha256.slice(0, 16)}` : ''}) for ${packet.to.agentId}, expires ${packet.expiresAt}.`,
    `From: ${packet.from.map((item) => `${item.agentId} (${item.provider}/${item.harness})`).join(', ')}.`,
    'Everything below is a claim by earlier assignments to verify independently, not evidence.',
    list('Reported changes', packet.context.reportedChanges),
    list('Not verified by earlier assignments', packet.context.notVerified),
    list('Reported risks', packet.context.risks),
    ...(packet.priorFindings.length ? packet.priorFindings.map((finding) => `Prior finding ${finding.id} [${finding.severity}${finding.blocking ? ', blocking' : ''}]: ${finding.summary}`) : ['Prior findings: none']),
    ...(packet.disagreements.length ? packet.disagreements.map((item) => `Unresolved disagreement on ${item.topic}: ${item.positions.map((position) => `${position.agentId}=${position.recommendation}`).join(', ')}`) : []),
    `Provenance: ${packet.provenance.repository} at ${packet.provenance.revision}, tree ${packet.provenance.tree}; evidence ${packet.provenance.evidenceIds.join(', ') || 'none'}.`,
  ];
  const text = lines.join('\n');
  return text.length > MAX_RENDERED ? `${text.slice(0, MAX_RENDERED)}\n[Handoff truncated; the full packet ${packet.id} is stored with the run.]` : text;
}
