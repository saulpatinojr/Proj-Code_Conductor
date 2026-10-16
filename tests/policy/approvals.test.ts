import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../packages/schemas/src/index.js';
import { assertContract } from '../../packages/schemas/src/index.js';
import { ApprovalGate, approvalBlocker, approvalDigest, type Approver } from '../../packages/policy/src/index.js';

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  action: 'context_disclosure',
  runId: 'CC-1',
  taskId: 'T-1',
  assignmentId: 'A-1',
  repository: '/work/repo',
  revision: 'a'.repeat(40),
  recipient: 'openai/codex@cli',
  bindings: { prompt: 'b'.repeat(64), tree: 'c'.repeat(40) },
  summary: 'Disclose the task prompt.',
  ...overrides,
});
const approve: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };
const deny: Approver = { decide: async () => ({ approved: false, approver: 'test' }) };

describe('pre-action approval digest', () => {
  it('binds every field except the human-readable summary', () => {
    const base = approvalDigest(request());
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(approvalDigest(request({ summary: 'Reworded.' }))).toBe(base);
    for (const changed of [
      request({ action: 'local_execution' }), request({ runId: 'CC-2' }), request({ taskId: 'T-2' }), request({ assignmentId: 'A-2' }),
      request({ repository: '/work/other' }), request({ revision: 'd'.repeat(40) }), request({ recipient: 'anthropic/claude@cli' }),
      request({ bindings: { prompt: 'e'.repeat(64), tree: 'c'.repeat(40) } }), request({ bindings: { prompt: 'b'.repeat(64) } }),
    ]) expect(approvalDigest(changed)).not.toBe(base);
  });

  it('is independent of binding key order', () => {
    expect(approvalDigest(request({ bindings: { tree: 'c'.repeat(40), prompt: 'b'.repeat(64) } }))).toBe(approvalDigest(request()));
  });
});

describe('ApprovalGate', () => {
  it('refuses as missing when no approver can be asked', async () => {
    const gate = new ApprovalGate();
    const outcome = await gate.authorize(() => [request()]);
    expect(outcome.approved).toBe(false);
    expect(outcome.records[0]).toMatchObject({ status: 'missing', approver: 'none' });
    expect(outcome.records[0]?.decidedAt).toBeUndefined();
    expect(approvalBlocker(outcome.records)).toContain('no interactive approver');
  });

  it('refuses an approver that declines to decide', async () => {
    const outcome = await new ApprovalGate({ approver: { decide: async () => undefined } }).authorize(() => [request()]);
    expect(outcome.records[0]?.status).toBe('missing');
  });

  it('refuses as missing when the approver fails or returns a malformed decision', async () => {
    const failing: Approver = { decide: async () => { throw new Error('terminal closed'); } };
    expect((await new ApprovalGate({ approver: failing }).authorize(() => [request()])).records[0]?.status).toBe('missing');
    for (const decision of [{ approved: 'true', approver: 'x' }, { approved: 1, approver: 'x' }, { approved: true }, { approved: true, approver: '' }, 'yes']) {
      const malformed = { decide: async () => decision } as unknown as Approver;
      const outcome = await new ApprovalGate({ approver: malformed }).authorize(() => [request()]);
      expect(outcome.approved).toBe(false);
      expect(outcome.records[0]?.status).toBe('missing');
    }
  });

  it('refuses a denial', async () => {
    const outcome = await new ApprovalGate({ approver: deny }).authorize(() => [request()]);
    expect(outcome.approved).toBe(false);
    expect(outcome.records[0]?.status).toBe('denied');
    expect(approvalBlocker(outcome.records)).toContain('denied');
  });

  it('refuses a decision given after the approval window', async () => {
    let clock = 1_000_000;
    const slow: Approver = { decide: async () => { clock += 60_001; return { approved: true, approver: 'test' }; } };
    const outcome = await new ApprovalGate({ approver: slow, ttlMs: 60_000, now: () => clock }).authorize(() => [request()]);
    expect(outcome.records[0]?.status).toBe('expired');
  });

  it('invalidates approval when the bound context changes before the action', async () => {
    let revision = 'a'.repeat(40);
    const moving: Approver = { decide: async () => { revision = 'f'.repeat(40); return { approved: true, approver: 'test' }; } };
    const outcome = await new ApprovalGate({ approver: moving }).authorize(() => [request({ revision })]);
    expect(outcome.approved).toBe(false);
    expect(outcome.records[0]?.status).toBe('changed');
    expect(outcome.records[0]?.revision).toBe('a'.repeat(40));
  });

  it('records a decision whose context can no longer be rebuilt as changed', async () => {
    let calls = 0;
    const outcome = await new ApprovalGate({ approver: approve }).authorize(() => {
      calls += 1;
      if (calls > 1) throw new Error('git unavailable');
      return [request()];
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.records[0]).toMatchObject({ status: 'changed', approver: 'test' });
  });

  it('approves an unchanged context once, with a bounded expiry and schema-valid evidence', async () => {
    const gate = new ApprovalGate({ approver: approve, ttlMs: 60_000, now: () => Date.parse('2026-10-16T00:00:00Z') });
    const outcome = await gate.authorize(() => [request(), request({ action: 'local_execution', bindings: { command: 'codex' } })]);
    expect(outcome.approved).toBe(true);
    expect(outcome.records.map((record) => record.status)).toEqual(['approved', 'approved']);
    expect(outcome.records[0]?.expiresAt).toBe('2026-10-16T00:01:00.000Z');
    for (const record of outcome.records) assertContract('ApprovalRecord', record);
    // Each authorize() asks again; an earlier approval is never reused as authority.
    let asked = 0;
    const counting: Approver = { decide: async () => { asked += 1; return { approved: true, approver: 'test' }; } };
    const repeat = new ApprovalGate({ approver: counting });
    await repeat.authorize(() => [request()]);
    await repeat.authorize(() => [request()]);
    expect(asked).toBe(2);
    expect(repeat.records).toHaveLength(2);
  });

  it('keeps cross-provider disclosure approvals distinct', async () => {
    const seen: string[] = [];
    const providerScoped: Approver = { decide: async (requests) => { seen.push(...requests.map((item) => item.recipient ?? '')); return { approved: requests.every((item) => item.recipient === 'openai/codex@cli'), approver: 'test' }; } };
    const gate = new ApprovalGate({ approver: providerScoped });
    expect((await gate.authorize(() => [request()])).approved).toBe(true);
    expect((await gate.authorize(() => [request({ recipient: 'anthropic/claude@cli' })])).approved).toBe(false);
    expect(seen).toEqual(['openai/codex@cli', 'anthropic/claude@cli']);
    expect(gate.records[0]?.requestDigest).not.toBe(gate.records[1]?.requestDigest);
  });

  it('supports deployment requests for native pipeline connectors', async () => {
    const outcome = await new ApprovalGate({ approver: approve }).authorize(() => [request({ action: 'deployment', recipient: 'github-actions:deploy.yml@production', bindings: { revision: 'a'.repeat(40), environment: 'production' } })]);
    expect(outcome.records[0]).toMatchObject({ action: 'deployment', status: 'approved' });
  });

  it('rejects requests that do not bind enough context', async () => {
    const gate = new ApprovalGate({ approver: approve });
    await expect(gate.authorize(() => [])).rejects.toThrow('at least one request');
    await expect(gate.authorize(() => [request({ bindings: {} })])).rejects.toThrow('action-specific');
    await expect(gate.authorize(() => [request({ revision: '' })])).rejects.toThrow('revision');
    const { recipient: _recipient, ...withoutRecipient } = request();
    await expect(gate.authorize(() => [withoutRecipient])).rejects.toThrow('recipient');
    await expect(gate.authorize(() => [request({ action: 'publish' as never })])).rejects.toThrow('Unsupported');
    expect(() => new ApprovalGate({ ttlMs: 0 })).toThrow('TTL');
  });
});
