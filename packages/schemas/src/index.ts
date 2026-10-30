export type Stance = 'constructive' | 'critical' | 'neutral';
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type BillingChannel = 'subscription' | 'api' | 'manual' | 'local';

export interface TaskEnvelope { id: string; objective: string; repository?: string; acceptanceCriteria: string[]; risk: RiskClass; constraints: string[]; specializations?: string[]; createdAt: string }
export interface AgentAssignment { id: string; taskId: string; agentId: string; role: string; stance: Stance; provider: string; harness: string; surface?: string; billingChannel: BillingChannel; authority: string[]; dependsOn: string[] }
export interface Evidence { id: string; kind: 'repository' | 'test' | 'documentation' | 'tool' | 'human' | 'agent_output' | 'other'; source: string; summary: string; uri?: string; sha256?: string }
export interface Finding { id: string; severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; summary: string; evidenceIds: string[]; blocking: boolean }
export interface GateResult { blocking?: boolean; gate: string; status: 'passed' | 'failed' | 'skipped'; evidenceIds: string[]; summary?: string }
export interface AgentResult { taskId: string; assignmentId: string; agentId: string; role: string; stance: Stance; provider: string; harness: string; surface?: string; billingChannel: BillingChannel; status: 'completed' | 'awaiting_external' | 'blocked' | 'failed' | 'cancelled'; changes: string[]; tests: GateResult[]; evidence: Evidence[]; findings: Finding[]; risks: string[]; blockers: string[]; recommendation: 'continue' | 'review' | 'changes_required' | 'ready' | 'human_required'; notVerified?: string[] }
export interface ReviewResult { reviewerAgentId: string; verdict: 'approve' | 'changes_requested' | 'comment'; findingIds: string[]; evidenceIds: string[] }
export interface MergeDecision { decision: 'ready' | 'changes_required' | 'human_required' | 'blocked'; rationale: string; evidenceIds: string[] }
export type ApprovalAction = 'local_execution' | 'context_disclosure' | 'commit' | 'deployment';
export type ApprovalStatus = 'approved' | 'denied' | 'missing' | 'expired' | 'changed';
/** A consequential action presented for human approval. Every field except `summary` is bound by the approval digest. */
export interface ApprovalRequest { action: ApprovalAction; runId: string; taskId: string; assignmentId?: string; repository: string; revision: string; recipient?: string; bindings: Record<string, string>; summary: string }
/** Non-secret evidence of one pre-action approval decision. Records are evidence only and never authorize a later action. */
export interface ApprovalRecord { requestDigest: string; action: ApprovalAction; runId: string; taskId: string; assignmentId?: string; recipient?: string; revision: string; status: ApprovalStatus; approver: string; requestedAt: string; decidedAt?: string; expiresAt?: string; summary: string }
/** One side of a handoff: who produced prior work, or who receives the packet. */
export interface HandoffParty { assignmentId: string; agentId: string; role: string; provider: string; harness: string; surface?: string }
/** Positions that conflict and are not yet resolved by evidence or arbitration. */
export interface Disagreement { topic: string; status: 'unresolved'; positions: Array<{ agentId: string; role: string; stance: Stance; recommendation: AgentResult['recommendation']; evidenceIds: string[] }> }
/**
 * Versioned context handed to one recipient assignment: what it is authorised to see,
 * prior claims to verify, unresolved disagreements and where they came from. Packets
 * are local, owner-private run evidence with an expiry; they are claims, not proof.
 */
export interface HandoffPacket {
  version: 1; id: string; runId: string; taskId: string;
  from: HandoffParty[]; to: HandoffParty;
  createdAt: string; expiresAt: string;
  context: { objective: string; acceptanceCriteria: string[]; constraints: string[]; reportedChanges: string[]; notVerified: string[]; risks: string[] };
  priorFindings: Finding[];
  disagreements: Disagreement[];
  provenance: { repository: string; revision: string; tree: string; evidenceIds: string[] };
}
/** A manifest's reference to a stored packet. */
export interface HandoffReference { id: string; to: string; sha256: string; expiresAt: string }
/** An isolated agent worktree created for a run, so native Source Control review can find it. */
export interface WorktreeRecord { assignmentId: string; path: string; branch: string; baseSha: string }
/** Historical read-only planning observations; never execution or approval authority. */
export interface PlanReviewSnapshot {
  version: 1; capturedAt: string;
  specializations: { source: 'requested' | 'objective_signals' | 'none'; values: string[] };
  providers: Array<{ harness: string; provider: string; surface: string; localClientRequired: boolean; inventory: 'present' | 'absent' | 'not_checked' }>;
  checks: { state: 'recorded' | 'unavailable'; selection: 'explicit' | 'detected'; gates: Array<{ profile: string; id: string; command: string; args: string[]; configuredBlocking: boolean; timeoutMs: number; missing: string[]; executable?: string; prefixArgs?: string[] }> };
}
export interface RunManifest { planReview?: PlanReviewSnapshot; runId: string; task: TaskEnvelope; assignments: AgentAssignment[]; results: AgentResult[]; gates: GateResult[]; approvals?: ApprovalRecord[]; worktrees?: WorktreeRecord[]; handoffs?: HandoffReference[]; mergeDecision?: MergeDecision }

export { validateContract, assertContract, type ContractName, type ContractValidationResult } from './validate.js';
