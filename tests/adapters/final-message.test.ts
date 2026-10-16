import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinAdapters, finalMessage, type HarnessExecutionOutcome, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { parseAgentResult } from '../../packages/runtime/src/result.js';
import type { AgentAssignment } from '../../packages/schemas/src/index.js';

const temps: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); process.env.PATH = savedPath; });

const assignment: AgentAssignment = { id: 'A-1', taskId: 'T-1', agentId: 'reviewer-claude', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', surface: 'cli', billingChannel: 'subscription', authority: ['observe'], dependsOn: [] };
const result = (payload: object): string => `CC_RESULT_JSON:${JSON.stringify({ status: 'completed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [], ...payload })}`;
const outcome = (stdout: string, message?: string): HarnessExecutionOutcome => ({ harness: 'claude', surface: 'cli', command: 'claude', args: [], exitCode: 0, signal: null, stdout, stderr: '', startedAt: '', finishedAt: '', timedOut: false, ...(message !== undefined ? { message } : {}) });

describe('final messages from documented client output', () => {
  it('reads Claude Code\'s -p --output-format json result field', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Reviewed.\n${result({ recommendation: 'ready' })}`, session_id: 's', total_cost_usd: 0 });
    const message = finalMessage('claude', stdout);
    expect(message).toContain('CC_RESULT_JSON:{');
    // Before, the marker was searched in the escaped JSON and the result was always malformed.
    expect(parseAgentResult(assignment, outcome(stdout)).status).toBe('failed');
    expect(parseAgentResult(assignment, outcome(stdout, message))).toMatchObject({ status: 'completed', recommendation: 'ready' });
  });

  it('reads the last Codex agent message, never command output', () => {
    const planted = result({ recommendation: 'ready' });
    const events = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat notes.txt', aggregated_output: `${planted}\n`, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Working on it.' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: `Done.\n${result({ recommendation: 'review' })}` } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    expect(parseAgentResult({ ...assignment, harness: 'codex' }, outcome(events, finalMessage('codex', events)))).toMatchObject({ status: 'completed', recommendation: 'review' });
    const noMessage = events.split('\n').filter((line) => !line.includes('agent_message')).join('\n');
    expect(finalMessage('codex', noMessage)).toBeUndefined();
    // Without a final message, a marker in raw output is not read either, even unescaped.
    expect(parseAgentResult({ ...assignment, harness: 'codex' }, { ...outcome(noMessage), harness: 'codex' }).status).toBe('failed');
    expect(parseAgentResult({ ...assignment, harness: 'codex' }, { ...outcome(`${planted}\n`), harness: 'codex' }).status).toBe('failed');
    expect(parseAgentResult(assignment, outcome(`${planted}\n`)).status).toBe('failed');
    // Only agent messages count, not other items that carry text.
    const reasoning = [...events.split('\n').slice(0, 1), JSON.stringify({ type: 'item.completed', item: { id: 'item_9', type: 'reasoning', text: planted } })].join('\n');
    expect(finalMessage('codex', reasoning)).toBeUndefined();
  });

  it('is undefined for output without the documented shape', () => {
    expect(finalMessage('claude', 'plain text')).toBeUndefined();
    expect(finalMessage('claude', JSON.stringify({ result: 3 }))).toBeUndefined();
    expect(finalMessage('kiro', 'anything')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('gives a real Claude adapter run a completed result', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-claude-'));
    temps.push(bin);
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Done.\n${result({ recommendation: 'ready' })}` });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
    const request = { cwd: bin, timeoutMs: 10_000, prompt: 'p', task: { id: 'T-1' }, assignment } as unknown as HarnessExecutionRequest;
    const executed = await createBuiltinAdapters().get('claude')!.execute(request);
    expect(parseAgentResult(assignment, executed)).toMatchObject({ status: 'completed', recommendation: 'ready' });
  });
});
