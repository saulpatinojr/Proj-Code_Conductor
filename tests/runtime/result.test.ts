import { describe, expect, it } from 'vitest';
import { parseAgentResult } from '../../packages/runtime/src/result.js';
import type { AgentAssignment } from '../../packages/schemas/src/index.js';

const assignment: AgentAssignment = {
  id: 'A-1', taskId: 'T-1', agentId: 'builder-codex', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', surface: 'cli', billingChannel: 'subscription', authority: ['modify_worktree'], dependsOn: [],
};

function outcome(stdout: string, exitCode = 0) {
  // Codex's final agent message, as the adapter extracts it from `exec --json`.
  return { harness: 'codex', surface: 'cli' as const, command: 'codex', args: [], exitCode, signal: null, stdout, message: stdout, stderr: '', startedAt: '', finishedAt: '', timedOut: false } as const;
}

describe('agent result parsing', () => {
  it('accepts the final structured marker and preserves the planned execution surface', () => {
    const result = parseAgentResult(assignment, outcome('notes\nCC_RESULT_JSON:{"status":"completed","changes":["x.ts"],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review"}\n'));
    expect(result.status).toBe('completed');
    expect(result.changes).toEqual(['x.ts']);
    expect(result.surface).toBe('cli');
  });

  it('fails closed when structured output is absent', () => {
    const result = parseAgentResult(assignment, outcome('unstructured'));
    expect(result.status).toBe('failed');
    expect(result.blockers[0]).toMatch(/CC_RESULT_JSON/);
  });

  it('fails closed when status is outside the AgentResult contract', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"done","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review"}'));
    expect(result.status).toBe('failed');
    expect(result.recommendation).toBe('changes_required');
    expect(result.blockers[0]).toMatch(/contract validation/);
  });

  it('fails closed when recommendation is outside the AgentResult contract', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"ship_it"}'));
    expect(result.status).toBe('failed');
    expect(result.recommendation).toBe('changes_required');
    expect(result.blockers[0]).toMatch(/contract validation/);
  });

  it('fails closed when nested result collections violate the contract', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"completed","changes":"x.ts","tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review"}'));
    expect(result.status).toBe('failed');
    expect(result.blockers[0]).toMatch(/contract validation/);
  });

  it('preserves an optional notVerified list declared by the agent', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review","notVerified":["Live deployment was not performed."]}'));
    expect(result.status).toBe('completed');
    expect(result.notVerified).toEqual(['Live deployment was not performed.']);
  });

  it('omits notVerified when the agent does not declare it', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review"}'));
    expect('notVerified' in result).toBe(false);
  });

  it('fails closed when notVerified violates the contract', () => {
    const result = parseAgentResult(assignment, outcome('CC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"review","notVerified":"nothing"}'));
    expect(result.status).toBe('failed');
    expect(result.blockers[0]).toMatch(/contract validation/);
  });
});
