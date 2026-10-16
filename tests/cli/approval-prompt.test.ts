import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { describeApprovalRequests, TerminalApprover } from '../../packages/cli/src/approval-prompt.js';
import type { ApprovalRequest } from '../../packages/schemas/src/index.js';

const request: ApprovalRequest = {
  action: 'commit', runId: 'CC-1', taskId: 'T-1', assignmentId: 'A-1', repository: '/work/repo', revision: 'a'.repeat(40), recipient: 'git:cc/T-1/builder-codex',
  bindings: { tree: 'b'.repeat(40) }, summary: 'Commit 1 changed file(s).',
};

function terminal(answer: string, tty = true): { input: PassThrough & { isTTY?: boolean }; output: PassThrough & { isTTY?: boolean }; written: () => string } {
  const input: PassThrough & { isTTY?: boolean } = new PassThrough();
  const output: PassThrough & { isTTY?: boolean } = new PassThrough();
  input.isTTY = tty; output.isTTY = tty;
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  setTimeout(() => input.write(`${answer}\n`), 10);
  return { input, output, written: () => text };
}

describe('terminal approver', () => {
  it('cannot approve from a non-interactive process', async () => {
    const io = terminal('approve', false);
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toBeUndefined();
  });

  it('approves only the exact confirmation word and shows the bound context', async () => {
    const io = terminal('approve');
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toEqual({ approved: true, approver: 'interactive-terminal' });
    expect(io.written()).toContain('git:cc/T-1/builder-codex');
    expect(io.written()).toContain(`tree: ${'b'.repeat(40)}`);
    expect(io.written()).toContain('approval digest:');
  });

  it.each(['y', 'yes', 'APPROVE', ''])('treats %j as a denial', async (answer) => {
    const io = terminal(answer);
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toMatchObject({ approved: false });
  });

  it('neutralizes terminal control sequences in displayed values', () => {
    const text = describeApprovalRequests([{ ...request, summary: 'ok\u001b[2J\u001b]0;spoof\u0007', bindings: { 'tr\nee': 'x\ry' } }]);
    expect(text).not.toMatch(/\u001b|\u0007|\r/);
    expect(text).toContain('ok?[2J?]0;spoof?');
  });
});
