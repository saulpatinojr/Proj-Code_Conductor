import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ApprovalDecision, Approver } from '@code-conductor/policy';
import { approvalDigest } from '@code-conductor/policy';
import type { ApprovalRequest } from '@code-conductor/schemas';

type TerminalInput = Readable & { isTTY?: boolean };
type TerminalOutput = Writable & { isTTY?: boolean };

/** Single-line rendering so bound values cannot inject terminal control sequences. */
function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

export function describeApprovalRequests(requests: readonly ApprovalRequest[]): string {
  const lines = ['', 'Code Conductor pre-action approval required:'];
  for (const request of requests) {
    lines.push(`  • ${request.action}${request.recipient ? ` → ${printable(request.recipient)}` : ''}`);
    lines.push(`    ${printable(request.summary)}`);
    lines.push(`    repository: ${printable(request.repository)}  revision: ${printable(request.revision)}`);
    for (const [key, value] of Object.entries(request.bindings)) lines.push(`    ${printable(key)}: ${printable(value)}`);
    lines.push(`    approval digest: ${approvalDigest(request)}`);
  }
  lines.push('This approves only the action(s) above, once, for this exact context. Workstation trust is not approval.');
  return `${lines.join('\n')}\n`;
}

/**
 * Asks in the invoking terminal immediately before the action. A non-interactive
 * process cannot approve anything: the request is refused as missing.
 */
export class TerminalApprover implements Approver {
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;

  constructor(input: TerminalInput = process.stdin, output: TerminalOutput = process.stderr) {
    this.#input = input;
    this.#output = output;
  }

  async decide(requests: readonly ApprovalRequest[]): Promise<ApprovalDecision | undefined> {
    if (!this.#input.isTTY || !this.#output.isTTY) return undefined;
    this.#output.write(describeApprovalRequests(requests));
    const prompt = createInterface({ input: this.#input, output: this.#output, terminal: true });
    try {
      const answer = await prompt.question('Type "approve" to allow, anything else denies: ');
      return { approved: answer.trim() === 'approve', approver: 'interactive-terminal' };
    } finally { prompt.close(); }
  }
}
