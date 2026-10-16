import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { confirmationCode, describeApprovalRequests, TerminalApprover } from '../../packages/cli/src/approval-prompt.js';
import type { ApprovalRequest } from '../../packages/schemas/src/index.js';

const request: ApprovalRequest = {
  action: 'commit', runId: 'CC-1', taskId: 'T-1', assignmentId: 'A-1', repository: '/work/repo', revision: 'a'.repeat(40), recipient: 'git:cc/T-1/builder-codex',
  bindings: { tree: 'b'.repeat(40) }, summary: 'Commit 1 changed file(s).',
};
type Tty = PassThrough & { isTTY?: boolean };

function terminal(tty = true): { input: Tty; output: Tty; written: () => string } {
  const input: Tty = new PassThrough();
  const output: Tty = new PassThrough();
  input.isTTY = tty; output.isTTY = tty;
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  return { input, output, written: () => text };
}
const answerAfterPrompt = (io: ReturnType<typeof terminal>, answer: string): void => { setTimeout(() => io.input.write(`${answer}\n`), 10); };

describe('terminal approver', () => {
  it('cannot approve from a non-interactive process', async () => {
    const io = terminal(false);
    answerAfterPrompt(io, confirmationCode([request]));
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toBeUndefined();
  });

  it('approves only the confirmation code shown with these requests', async () => {
    const io = terminal();
    const code = confirmationCode([request]);
    expect(code).toMatch(/^[a-f0-9]{6}$/);
    answerAfterPrompt(io, code);
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toEqual({ approved: true, approver: 'interactive-terminal' });
    expect(io.written()).toContain(`Type ${code} to approve`);
    expect(io.written()).toContain('git:cc/T-1/builder-codex');
    expect(io.written()).toContain(`tree: ${'b'.repeat(40)}`);
    expect(io.written()).toContain('approval digest:');
  });

  it('binds the code to the exact requests', () => {
    expect(confirmationCode([{ ...request, revision: 'c'.repeat(40) }])).not.toBe(confirmationCode([request]));
    expect(confirmationCode([{ ...request, summary: 'Reworded.' }])).toBe(confirmationCode([request]));
  });

  it.each(['approve', 'y', 'yes', 'APPROVE', ''])('treats %j as a denial', async (answer) => {
    const io = terminal();
    answerAfterPrompt(io, answer);
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toMatchObject({ approved: false });
  });

  it('cannot be answered by input typed before the prompt appeared', async () => {
    const io = terminal();
    // Typed while a provider was still running, before this request existed.
    io.input.write('approve\n');
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toMatchObject({ approved: false });
  });

  it.each([
    ['end of input', (io: ReturnType<typeof terminal>) => io.input.end()],
    ['Ctrl-C', (io: ReturnType<typeof terminal>) => io.input.write(String.fromCharCode(3))],
    ['Ctrl-D', (io: ReturnType<typeof terminal>) => io.input.write(String.fromCharCode(4))],
  ])('treats %s as a denial instead of hanging or failing the run', async (_label, interrupt) => {
    const io = terminal();
    setTimeout(() => interrupt(io), 10);
    await expect(new TerminalApprover(io.input, io.output).decide([request])).resolves.toMatchObject({ approved: false });
  });

  it('neutralizes control, bidirectional and zero-width characters in displayed values', () => {
    const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
    const hostile = [0x1b, 0x07, 0x0d, 0x202e, 0x200b, 0x2066, 0x2069, 0x2028, 0x2029];
    const text = describeApprovalRequests([{ ...request, summary: `ok${ch(0x1b)}[2J evil${ch(0x202e)}txt.exe${ch(0x200b)}${ch(0x2066)}x${ch(0x2069)}${ch(0x2028)}`, bindings: { [`tr${ch(0x0a)}ee`]: `x${ch(0x0d)}y` } }]);
    for (const code of hostile) expect(text).not.toContain(ch(code));
    expect(text).toContain('ok?[2J evil?txt.exe??x??');
    expect(text).toContain('tr?ee: x?y');
  });
});
