import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { reviewTeam, type TeamReviewInput } from '../../packages/runtime/src/team-review.js';
import { FakeAdapter, initRepository } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'cc-team-review-')); roots.push(base);
  const root = initRepository(join(base, 'repository'));
  vi.stubEnv('CODE_CONDUCTOR_HOME', join(base, 'private'));
  const input: TeamReviewInput = { inputs: { digest: 'a'.repeat(64), agents: [{ id: 'specialist', provider: 'openai', capabilities: ['review'], sourceDigest: 'b'.repeat(64), binding: 'manual' }], roles: [{ id: 'reviewer', requiredCapabilities: ['review'] }], requiredRoles: ['reviewer'], separateAgents: [], separateProviders: [], requiredHandoffs: [] }, context: 'Confirmed project goals and validated pack metadata.' };
  const advice = { version: 1, inputDigest: input.inputs.digest, assignments: [{ id: 'review', agentId: 'specialist', role: 'reviewer', dependsOn: [] }] };
  class Reviewer extends FakeAdapter {
    calls: HarnessExecutionRequest[] = [];
    invocation(request: HarnessExecutionRequest) { return { command: '/native/codex', args: ['exec', '--sandbox', 'read-only', request.prompt] }; }
    async authStatus() { return { state: 'authenticated' as const, billing: 'subscription' as const, command: ['codex', 'login', 'status'] }; }
    override async execute(request: HarnessExecutionRequest) {
      this.calls.push(request);
      return { ...await super.execute(request), message: `CC_TEAM_JSON:${JSON.stringify(advice)}` };
    }
  }
  return { root, input, advice, adapter: new Reviewer('codex', 'openai'), approve: { decide: async () => ({ approved: true, approver: 'test' }) } };
}
describe('approved read-only team review', () => {
  it('uses native readiness and fresh execution/disclosure approvals without a builder plan', async () => {
    const f = fixture();
    const result = await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve });
    expect(result.status).toBe('reviewed'); expect(result.advice).toEqual(f.advice);
    expect(result.approvals.map((record) => record.action)).toEqual(['local_execution', 'context_disclosure']);
    expect(f.adapter.calls).toHaveLength(1);
    expect(f.adapter.calls[0]!.assignment.authority).not.toContain('modify_worktree');
    expect(f.adapter.calls[0]!.assignment.role).toBe('conductor');
  });
  it.each(['missing', 'denied', 'changed', 'expired'])('does not start a model on %s approval', async (mode) => {
    const f = fixture(); let now = 0;
    const approver = mode === 'missing' ? undefined : { decide: async () => {
      if (mode === 'changed') f.input.context = 'Changed during approval';
      if (mode === 'expired') now = 16 * 60 * 1000;
      return { approved: mode !== 'denied', approver: 'test' };
    } };
    const result = await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver, now: () => now });
    expect(result.status).toBe('blocked'); expect(f.adapter.calls).toHaveLength(0);
    expect(result.approvals[0]?.status).toBe(mode);
  });
  it('refuses missing readiness, invalid metadata and unsafe disclosure before provider execution', async () => {
    const f = fixture();
    expect((await reviewTeam(f.root, () => f.input, { adapter: f.adapter, approver: f.approve })).status).toBe('blocked');
    f.input.inputs.requiredRoles = ['invented'];
    expect((await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve })).status).toBe('blocked');
    f.input.inputs.requiredRoles = ['reviewer']; f.input.context = 'ghp_' + 'a'.repeat(36);
    expect((await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve })).status).toBe('blocked');
    expect(f.adapter.calls).toHaveLength(0);
  });
  it('rejects schema-valid advice that violates the actual capability graph', async () => {
    const f = fixture(); f.advice.assignments[0]!.agentId = 'invented';
    const result = await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve });
    expect(result.status).toBe('failed'); expect(result.advice).toBeUndefined();
  });
  it('refuses advice if relevant inputs change while the provider runs', async () => {
    const f = fixture(); const execute = f.adapter.execute.bind(f.adapter);
    f.adapter.execute = async (request) => { const result = await execute(request); f.input.context = 'Changed after model start'; return result; };
    const result = await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve });
    expect(result.status).toBe('failed'); expect(result.advice).toBeUndefined();
  });
  it.each(['unknown', 'separately_billed', 'missing'])('does not fall back to %s authentication/billing', async (billing) => {
    const f = fixture();
    Object.assign(f.adapter, { authStatus: billing === 'missing' ? undefined : async () => ({ state: 'authenticated', billing, command: ['codex', 'login', 'status'] }) });
    const result = await reviewTeam(f.root, () => f.input, { adapter: f.adapter, trusted: () => true, approver: f.approve });
    expect(result.status).toBe('blocked'); expect(f.adapter.calls).toHaveLength(0);
  });
});
