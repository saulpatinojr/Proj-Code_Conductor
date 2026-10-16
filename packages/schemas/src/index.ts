export type Stance = 'constructive' | 'critical' | 'neutral';
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type BillingChannel = 'subscription' | 'api' | 'manual' | 'local';

export interface TaskEnvelope { id: string; objective: string; repository?: string; acceptanceCriteria: string[]; risk: RiskClass; constraints: string[]; specializations?: string[]; createdAt: string }
export interface AgentAssignment { id: string; taskId: string; agentId: string; role: string; stance: Stance; provider: string; harness: string; surface?: string; billingChannel: BillingChannel; authority: string[]; dependsOn: string[] }
export interface Evidence { id: string; kind: 'repository' | 'test' | 'documentation' | 'tool' | 'human' | 'agent_output' | 'other'; source: string; summary: string; uri?: string; sha256?: string }
export interface Finding { id: string; severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; summary: string; evidenceIds: string[]; blocking: boolean }
export interface GateResult { gate: string; status: 'passed' | 'failed' | 'skipped'; evidenceIds: string[]; summary?: string }
export interface AgentResult { taskId: string; assignmentId: string; agentId: string; role: string; stance: Stance; provider: string; harness: string; surface?: string; billingChannel: BillingChannel; status: 'completed' | 'awaiting_external' | 'blocked' | 'failed' | 'cancelled'; changes: string[]; tests: GateResult[]; evidence: Evidence[]; findings: Finding[]; risks: string[]; blockers: string[]; recommendation: 'continue' | 'review' | 'changes_required' | 'ready' | 'human_required'; notVerified?: string[] }
export interface ReviewResult { reviewerAgentId: string; verdict: 'approve' | 'changes_requested' | 'comment'; findingIds: string[]; evidenceIds: string[] }
export interface MergeDecision { decision: 'ready' | 'changes_required' | 'human_required' | 'blocked'; rationale: string; evidenceIds: string[] }
export interface RunManifest { runId: string; task: TaskEnvelope; assignments: AgentAssignment[]; results: AgentResult[]; gates: GateResult[]; mergeDecision?: MergeDecision }

export { validateContract, assertContract, type ContractName, type ContractValidationResult } from './validate.js';
