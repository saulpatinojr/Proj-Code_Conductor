import { randomUUID } from 'node:crypto';
import { validateContract, type AgentAssignment, type AgentResult, type Evidence } from '@code-conductor/schemas';
import type { HarnessExecutionOutcome } from '@code-conductor/adapters';

const marker = 'CC_RESULT_JSON:';

function fallbackResult(assignment: AgentAssignment, outcome: HarnessExecutionOutcome, reason: string): AgentResult {
  const evidence: Evidence = {
    id: `E-${randomUUID()}`,
    kind: 'agent_output',
    source: `${assignment.harness}:${assignment.surface ?? outcome.surface}:${assignment.agentId}`,
    summary: [(outcome.message ?? outcome.stdout).trim(), outcome.stderr.trim()].filter(Boolean).join('\n').slice(0, 12000) || 'Agent returned no structured result.',
  };
  return {
    taskId: assignment.taskId,
    assignmentId: assignment.id,
    agentId: assignment.agentId,
    role: assignment.role,
    stance: assignment.stance,
    provider: assignment.provider,
    harness: assignment.harness,
    ...(assignment.surface ? { surface: assignment.surface } : {}),
    billingChannel: assignment.billingChannel,
    status: 'failed',
    changes: [],
    tests: [],
    evidence: [evidence],
    findings: [],
    risks: [],
    blockers: [reason],
    recommendation: 'changes_required',
  };
}

/**
 * The agent's result from the last `CC_RESULT_JSON:` line of its final message. When the
 * adapter extracted the client's final message from its machine-readable output, only
 * that message is read; tool and command output cannot supply a result.
 */
export function parseAgentResult(assignment: AgentAssignment, outcome: HarnessExecutionOutcome): AgentResult {
  const text = outcome.message ?? outcome.stdout;
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const raw = text.slice(markerIndex + marker.length).trim().split(/\r?\n/)[0] ?? '';
    try {
      const candidate = JSON.parse(raw) as Partial<AgentResult>;
      const result: AgentResult = {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        agentId: assignment.agentId,
        role: assignment.role,
        stance: assignment.stance,
        provider: assignment.provider,
        harness: assignment.harness,
        ...(assignment.surface ? { surface: assignment.surface } : {}),
        billingChannel: assignment.billingChannel,
        status: candidate.status ?? (outcome.exitCode === 0 ? 'completed' : 'failed'),
        changes: candidate.changes ?? [],
        tests: candidate.tests ?? [],
        evidence: candidate.evidence ?? [],
        findings: candidate.findings ?? [],
        risks: candidate.risks ?? [],
        blockers: candidate.blockers ?? [],
        recommendation: candidate.recommendation ?? (outcome.exitCode === 0 ? 'review' : 'changes_required'),
        ...(candidate.notVerified !== undefined ? { notVerified: candidate.notVerified } : {}),
      };
      const validation = validateContract('AgentResult', result);
      if (validation.ok) return result;
      return fallbackResult(
        assignment,
        outcome,
        `Agent returned CC_RESULT_JSON that failed AgentResult contract validation: ${validation.errors
          .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
          .join('; ')}`,
      );
    } catch {
      return fallbackResult(assignment, outcome, 'Agent returned malformed CC_RESULT_JSON.');
    }
  }
  return fallbackResult(assignment, outcome, 'Agent did not return a valid CC_RESULT_JSON structured result.');
}

export function externalAwaitingResult(assignment: AgentAssignment, reason: string): AgentResult {
  return {
    taskId: assignment.taskId,
    assignmentId: assignment.id,
    agentId: assignment.agentId,
    role: assignment.role,
    stance: assignment.stance,
    provider: assignment.provider,
    harness: assignment.harness,
    ...(assignment.surface ? { surface: assignment.surface } : {}),
    billingChannel: assignment.billingChannel,
    status: 'awaiting_external',
    changes: [],
    tests: [],
    evidence: [],
    findings: [],
    risks: [],
    blockers: [reason],
    recommendation: 'human_required',
  };
}
