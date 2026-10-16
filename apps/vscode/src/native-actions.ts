import { isAbsolute, relative, resolve } from 'node:path';
import { formatCommand, type NextAction } from '@code-conductor/runtime/next-actions';

/**
 * What the extension may do for a next action. Every operation either hands
 * the person to a native surface or copies a command for them to run; none
 * pushes, opens pull requests, signs in or executes a provider.
 */
export type NativeOperation =
  | { type: 'open_source_control'; path: string }
  | { type: 'open_documentation'; url: string }
  | { type: 'copy_command'; text: string }
  | { type: 'run_cli'; args: string[] }
  | { type: 'show'; text: string };

/** Read-only `cc` commands the extension may start in a task terminal on the person's click. */
const READ_ONLY_CLI = new Set(['handoff', 'next']);
const PLAIN_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** A plain value or flag such as `--run`; never shell syntax, spaces or substitutions. */
const PLAIN_CLI_ARGUMENT = /^(--?)?[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function within(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

export function nativeOperation(action: NextAction, worktreeRoot: string): NativeOperation {
  if (action.kind === 'review_changes' && action.path && isAbsolute(action.path) && within(worktreeRoot, action.path)) {
    return { type: 'open_source_control', path: action.path };
  }
  const [first] = action.commands ?? [];
  if (action.commands?.length === 1 && first?.[0] === 'cc' && READ_ONLY_CLI.has(first[1] ?? '') && first.slice(1).every((arg) => PLAIN_CLI_ARGUMENT.test(arg))) {
    return { type: 'run_cli', args: first.slice(1) };
  }
  if (action.commands?.length) return { type: 'copy_command', text: action.commands.map(formatCommand).join('\n') };
  return { type: 'show', text: `${action.title}\n${action.detail}` };
}

export interface SignInHint { instructions: string; command?: string; docs?: string }

/** Official sign-in guidance from packaged capabilities; anything malformed is dropped, never executed. */
export function signInHint(value: unknown): SignInHint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { instructions, command, docs } = value as Record<string, unknown>;
  if (typeof instructions !== 'string' || !instructions) return undefined;
  const hint: SignInHint = { instructions };
  if (Array.isArray(command) && command.length && command.every((part) => typeof part === 'string' && PLAIN_ARGUMENT.test(part))) hint.command = formatCommand(command as string[]);
  if (typeof docs === 'string' && /^https:\/\/[^\s]+$/.test(docs)) hint.docs = docs;
  return hint;
}
