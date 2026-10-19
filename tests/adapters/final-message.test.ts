import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinAdapters, finalMessage, processEnding, processSucceeded, terminalReason, type HarnessExecutionOutcome, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
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

describe('how a client process ended (2026-10-19 dogfood, #4)', () => {
  const ended = (overrides: Partial<HarnessExecutionOutcome>): HarnessExecutionOutcome => ({ ...outcome(''), ...overrides });

  it('counts only a clean exit as success: CLI clients exit 0 without a signal, ACP clients may have no exit status', () => {
    expect(processSucceeded(ended({ exitCode: 0 }))).toBe(true);
    expect(processSucceeded(ended({ exitCode: 1 }))).toBe(false);
    expect(processSucceeded(ended({ exitCode: null, signal: 'SIGKILL' }))).toBe(false);
    expect(processSucceeded(ended({ exitCode: 0, timedOut: true }))).toBe(false);
    expect(processSucceeded(ended({ surface: 'acp', exitCode: null, signal: 'SIGTERM' }))).toBe(true);
    expect(processSucceeded(ended({ surface: 'acp', exitCode: 1 }))).toBe(false);
    expect(processSucceeded(ended({ surface: 'acp', exitCode: null, signal: 'SIGTERM', timedOut: true }))).toBe(false);
  });

  it('reads Claude Code\'s own reason for stopping from its result object', () => {
    const maxTurns = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 20, result: 'Still reading the repository.' });
    expect(terminalReason('claude', maxTurns)).toBe('Claude Code reported error_max_turns after 20 turn(s)');
    expect(terminalReason('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'ok' }))).toBeUndefined();
    expect(terminalReason('claude', JSON.stringify({ type: 'result', is_error: true, result: 'x' }))).toBe('Claude Code reported an error result');
    expect(terminalReason('claude', 'not json')).toBeUndefined();
    expect(processEnding('claude', ended({ exitCode: 1, stdout: maxTurns }))).toBe('exited with code 1 (Claude Code reported error_max_turns after 20 turn(s))');
    // The reason reaches the blocker list, so `ccon next` says why there is no result.
    const parsed = parseAgentResult(assignment, { ...ended({ exitCode: 1, stdout: maxTurns }), message: finalMessage('claude', maxTurns) });
    expect(parsed.status).toBe('failed');
    expect(parsed.blockers).toEqual(['Agent did not return a valid CC_RESULT_JSON structured result.', 'The claude client exited with code 1 (Claude Code reported error_max_turns after 20 turn(s)).']);
    // A clean exit without a result keeps the single blocker.
    const clean = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'Done.' });
    expect(parseAgentResult(assignment, { ...ended({ exitCode: 0, stdout: clean }), message: finalMessage('claude', clean) }).blockers).toEqual(['Agent did not return a valid CC_RESULT_JSON structured result.']);
  });

  it('reads Codex\'s turn.failed and error events, bounded and without terminal control characters', () => {
    const events = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Working.' } },
      { type: 'turn.failed', error: { message: '\u001b[31msandbox denied\u001b[0m: ancestor directory' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    expect(terminalReason('codex', events)).toBe('Codex reported turn.failed:  [31msandbox denied [0m: ancestor directory');
    expect(terminalReason('codex', JSON.stringify({ type: 'error', message: `x${'y'.repeat(500)}` }))).toMatch(/^Codex reported an error: xy+…$/);
    expect(terminalReason('codex', events.split('\n').slice(0, 2).join('\n'))).toBeUndefined();
    expect(processEnding('codex', ended({ exitCode: null, signal: 'SIGKILL' }))).toBe('was ended by signal SIGKILL');
    expect(processEnding('codex', ended({ exitCode: null, signal: null, timedOut: true }))).toBe('timed out');
    expect(terminalReason('kiro', 'anything')).toBeUndefined();
  });
});
