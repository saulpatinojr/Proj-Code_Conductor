import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { assignmentPrompt, createTask, executeTask } from '../../packages/runtime/src/index.js';
import { SandboxWorktrees, WritingAdapter } from './fixtures.js';

const approveAll: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// A reviewer that reports in words of its own the first time ("success", "approve",
// "suggestion"), as the first R1 dogfood's reviewer did, and in the contract once told why.
class LearningReviewer extends WritingAdapter {
  prompts: string[] = [];
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    if (request.assignment.role !== 'reviewer') return super.execute(request);
    this.prompts.push(request.prompt);
    if (this.prompts.length === 1) {
      const message = 'CC_RESULT_JSON:{"status":"success","changes":[],"tests":[{"command":"vitest","result":"pass"}],"evidence":[],"findings":[{"severity":"suggestion","summary":"more cases"}],"risks":[],"blockers":[],"recommendation":"approve"}\n';
      return { harness: this.id, surface: this.executionSurface, command: 'fake', args: [], exitCode: 0, signal: null, stdout: message, message, stderr: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), timedOut: false };
    }
    return super.execute(request);
  }
}

describe('the result contract in the prompt, and a retry that knows why it was rejected', () => {
  it('spells out the enumerations and shapes with a valid example, before the final-line instruction', () => {
    const task = createTask('Fix the parser', 'R1');
    const assignment = { id: 'A-2', taskId: task.id, agentId: 'reviewer-claude', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', surface: 'cli', billingChannel: 'subscription', authority: ['observe', 'review'], dependsOn: [] } as const;
    const lines = assignmentPrompt(task, assignment, undefined, ['Stay read-only.']).split('\n');
    const contract = lines.findIndex((line) => line.startsWith('Result contract: '));
    expect(contract).toBeGreaterThan(0);
    for (const value of ['completed, awaiting_external, blocked, failed, cancelled', 'continue, review, changes_required, ready, human_required', '"passed"|"failed"|"skipped"', '"info"|"low"|"medium"|"high"|"critical"', '"blocking": boolean']) expect(lines[contract]).toContain(value);
    expect(lines[contract + 1]).toMatch(/^Valid example: \{"status":"completed"/);
    expect(JSON.parse(lines[contract + 1]!.slice('Valid example: '.length))).toMatchObject({ recommendation: 'ready' });
    expect(lines.at(-1)).toMatch(/^Your FINAL line MUST be CC_RESULT_JSON/);
    const retry = assignmentPrompt(task, assignment, undefined, [], { attempt: 2, rejection: 'the status was not allowed.' }).split('\n');
    expect(retry[retry.findIndex((line) => line.startsWith('Result contract: ')) - 1]).toBe('Attempt 2: your previous reply was rejected because the status was not allowed. Do the same work again and end with a result line that follows the contract below exactly.');
  });

  it('tells the second attempt what the contract validation rejected, and accepts its corrected report', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-contract-retry-'));
    temps.push(temp);
    const reviewer = new LearningReviewer('claude', 'anthropic');
    const outcome = await executeTask(resolve('.'), createTask('R1 with a reviewer that learns the contract', 'R1', resolve('.')), {
      execute: true, adapters: new Map<string, HarnessAdapter>([['codex', new WritingAdapter('codex', 'openai')], ['claude', reviewer]]), store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
      gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
    });
    expect(reviewer.prompts).toHaveLength(2);
    expect(reviewer.prompts[0]).not.toContain('your previous reply was rejected');
    expect(reviewer.prompts[1]).toContain('Attempt 2: your previous reply was rejected because Agent returned CC_RESULT_JSON that failed AgentResult contract validation: /status must be equal to one of the allowed values');
    expect(reviewer.prompts[1]).toContain('/findings/0/severity must be equal to one of the allowed values');
    const result = outcome.manifest.results.find((item) => item.role === 'reviewer');
    expect(result).toMatchObject({ status: 'completed', recommendation: 'ready' });
    // The retry's disclosure approval bound the new prompt, not the first one.
    const disclosures = (outcome.manifest.approvals ?? []).filter((record) => record.action === 'context_disclosure' && record.recipient === 'anthropic/claude@cli');
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]!.requestDigest).not.toBe(disclosures[1]!.requestDigest);
    expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
  });
});
