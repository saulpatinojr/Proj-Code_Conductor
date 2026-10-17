import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateContract } from '../../packages/schemas/src/index.js';

describe('contracts schema', () => {
  it('contains every required v0.1 contract', () => {
    const schema = JSON.parse(readFileSync(resolve('packages/schemas/schema/contracts.schema.json'), 'utf8')) as { $defs?: Record<string, unknown> };
    for (const name of ['TaskEnvelope', 'AgentAssignment', 'AgentResult', 'Evidence', 'Finding', 'GateResult', 'ReviewResult', 'MergeDecision', 'RunManifest', 'GateCatalog']) expect(schema.$defs?.[name]).toBeDefined();
  });

  it('accepts the packaged gate catalog as a GateCatalog', () => {
    const result = validateContract('GateCatalog', parse(readFileSync(resolve('config/gates.yaml'), 'utf8')));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('validates a TaskEnvelope with optional specialization hints and rejects an invalid risk class', () => {
    const valid = { id: 'T-1', objective: 'test', acceptanceCriteria: [], risk: 'R1', constraints: [], specializations: ['aws'], createdAt: new Date().toISOString() };
    expect(validateContract('TaskEnvelope', valid).ok).toBe(true);
    expect(validateContract('TaskEnvelope', { ...valid, risk: 'R9' }).ok).toBe(false);
  });

  it('validates execution surface on assignments/results while preserving legacy evidence without surface', () => {
    const assignment = { id: 'A-1', taskId: 'T-1', agentId: 'builder-kiro', role: 'builder', stance: 'constructive', provider: 'aws', harness: 'kiro', surface: 'acp', billingChannel: 'subscription', authority: ['modify_worktree'], dependsOn: [] };
    expect(validateContract('AgentAssignment', assignment).ok).toBe(true);
    const { surface: _assignmentSurface, ...legacyAssignment } = assignment;
    expect(validateContract('AgentAssignment', legacyAssignment).ok).toBe(true);

    const result = { taskId: 'T-1', assignmentId: 'A-1', agentId: 'researcher-perplexity', role: 'researcher', stance: 'neutral', provider: 'perplexity', harness: 'perplexity', surface: 'manual', billingChannel: 'manual', status: 'awaiting_external', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: ['manual'], recommendation: 'human_required' };
    expect(validateContract('AgentResult', result).ok).toBe(true);
    const { surface: _resultSurface, ...legacyResult } = result;
    expect(validateContract('AgentResult', legacyResult).ok).toBe(true);
  });
});
