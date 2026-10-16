import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ApprovalDecision, Approver } from '@code-conductor/policy';
import { approvalDigest } from '@code-conductor/policy';
import type { ApprovalRequest } from '@code-conductor/schemas';

type TerminalInput = Readable & { isTTY?: boolean };
type TerminalOutput = Writable & { isTTY?: boolean };

/**
 * Single-line rendering so bound values cannot rewrite the terminal or reorder
 * what is displayed: control characters, Unicode format characters (including
 * bidirectional overrides and zero-width characters) and line/paragraph
 * separators are replaced.
 */
const MAX_DISPLAY = 600;
function printable(value: string, limit = MAX_DISPLAY): string {
  const safe = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
    // Escape remaining non-ASCII so look-alike characters cannot disguise a path or recipient.
    .replace(/[^\x20-\x7E]/gu, (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`);
  return safe.length > limit ? `${safe.slice(0, limit)}… [${safe.length - limit} more characters not shown; the full value is bound by the digest]` : safe;
}

/**
 * A short code derived from the exact requests shown. It cannot be known before
 * the prompt appears, so input typed earlier (for example while a provider ran)
 * can never answer this prompt.
 */
export function confirmationCode(requests: readonly ApprovalRequest[]): string {
  return createHash('sha256').update(requests.map(approvalDigest).join(',')).digest('hex').slice(0, 6);
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
  lines.push(`Approving: ${requests.map((request) => `${request.action}${request.recipient ? ` → ${printable(request.recipient, 120)}` : ''}`).join('; ')}`);
  lines.push('This approves only the action(s) above, once, for this exact context. Workstation trust is not approval.');
  return `${lines.join('\n')}\n`;
}

/**
 * Asks in the invoking terminal immediately before the action. A non-interactive
 * process cannot approve anything: the request is refused as missing. Approval
 * requires typing the confirmation code shown with these requests; any other
 * answer, end of input or Ctrl-C denies.
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
    const code = confirmationCode(requests);
    this.#output.write(describeApprovalRequests(requests));
    const prompt = createInterface({ input: this.#input, output: this.#output, terminal: true });
    // question() does not settle when the input closes, so end of input (Ctrl-D)
    // and Ctrl-C abort it explicitly; both are refusals, never a hang.
    const abort = new AbortController();
    prompt.once('close', () => abort.abort());
    prompt.once('SIGINT', () => abort.abort());
    try {
      const answer = await prompt.question(`Type ${code} to approve these ${requests.length} action(s); anything else denies: `, { signal: abort.signal });
      return { approved: answer.trim() === code, approver: 'interactive-terminal' };
    } catch {
      return { approved: false, approver: 'interactive-terminal' };
    } finally { prompt.close(); }
  }
}
