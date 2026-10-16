import { isAbsolute, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import type { AgentAssignment, AgentResult, ApprovalRecord, RunManifest, WorktreeRecord } from '@code-conductor/schemas';

/**
 * Where a person completes the next step. Code Conductor presents the step and
 * links to the native surface; it never performs outward-facing steps (push,
 * pull request, sign-in, deployment) on the person's behalf from here.
 */
export type NativeSurface = 'source_control' | 'terminal' | 'official_client' | 'github' | 'manual';

export interface NextAction {
  kind: 'review_changes' | 'approve_interactively' | 'decide' | 'validate_harness' | 'manual_handoff' | 'github_review' | 'fix_validation' | 'resolve_findings' | 'retry_or_revise' | 'prepare_pull_request' | 'inspect_git_configuration';
  title: string;
  detail: string;
  surface: NativeSurface;
  assignmentId?: string;
  /** Local agent worktree for native Source Control review. */
  path?: string;
  /** Commands for the person to run in a native terminal. Code Conductor never runs them. */
  commands?: string[][];
  evidenceIds: string[];
}

export interface NextActionOptions {
  /** Only worktrees under this directory are offered for native review (imported manifests may name arbitrary paths). */
  worktreeRoot?: string;
  /** The shell commands will be pasted into; commands that cannot be pasted into it exactly are withheld. */
  shell?: CommandShell;
}

/**
 * Prefix of the blocker Code Conductor records when it stops a run because Git
 * configuration or history files changed under a provider. Shared with the runtime so
 * next actions never suggest running Git (status, diff, Source Control) in that state.
 */
export const GIT_CONTROL_CHANGED = 'Git configuration or history files';
/** Recorded when the official client reports no sign-in Code Conductor recognises. */
export const CLIENT_NOT_SIGNED_IN = 'is not signed in through its official client';
/** Recorded when a subscription assignment's client is signed in with a separately billed credential. */
export const CLIENT_BILLS_SEPARATELY = 'a separately billed sign-in';

const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Single-line rendering of untrusted text (run records can be imported) for a terminal
 * or editor: control characters, Unicode format characters (bidirectional overrides,
 * zero-width characters) and line/paragraph separators are replaced, so the text
 * cannot rewrite the terminal, add lines or reorder what is shown. With `ascii`, other
 * non-ASCII characters are escaped too, so look-alike letters cannot disguise a value.
 * Long values are truncated with a visible marker.
 */
export function printable(value: string, limit = 600, ascii = true, truncationNote = ''): string {
  let safe = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
  if (ascii) safe = safe.replace(/[^\x20-\x7E]/gu, (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`);
  return safe.length > limit ? `${safe.slice(0, limit)}… [${safe.length - limit} more characters not shown${truncationNote}]` : safe;
}

export type CommandShell = 'posix' | 'powershell';
/** The shell a person on this platform most likely pastes into (VS Code's default terminal). */
export const DEFAULT_SHELL: CommandShell = process.platform === 'win32' ? 'powershell' : 'posix';

// Never quoted. A leading '=' (zsh path expansion) or '~' (home expansion) is not plain.
const POSIX_PLAIN = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;
const POWERSHELL_PLAIN = /^[A-Za-z0-9_./:\\-]+$/;
// PowerShell treats typographic single quotes as quote characters too (about_Quoting_Rules).
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

/**
 * Display form of an argument vector for the given shell: POSIX single quotes, or
 * PowerShell single quotes with embedded quotes doubled. Callers only pass arguments
 * without control or format characters; nextActions drops any command that has them.
 */
export function formatCommand(argv: readonly string[], shell: CommandShell = DEFAULT_SHELL): string {
  return argv.map((arg) => {
    if (shell === 'powershell') return POWERSHELL_PLAIN.test(arg) && !arg.startsWith('@') ? arg : `'${arg.replace(POWERSHELL_QUOTES, (quote) => `${quote}${quote}`)}'`;
    return POSIX_PLAIN.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  }).join(' ');
}

// PowerShell's stop-parsing token. However it is quoted, PowerShell passes the rest of
// the line on raw: re-split into new arguments and with %NAME% replaced by environment
// values (about_Parsing). It is never a legitimate value here, on any platform.
const STOP_PARSING = /^--%/;

/**
 * Whether an argument, once quoted by formatCommand, reaches the program as exactly that
 * one argument when pasted into `shell`. Windows PowerShell 5.1 passes arguments to
 * native programs by legacy rules that drop an empty argument and do not escape an
 * embedded double quote, or the trailing backslash of an argument it wraps in quotes for
 * containing a space, so each can drop, split or merge arguments there.
 */
function copyable(arg: unknown, shell: CommandShell): boolean {
  if (typeof arg !== 'string' || UNSAFE_DISPLAY.test(arg) || STOP_PARSING.test(arg)) return false;
  return shell !== 'powershell' || !(arg === '' || arg.includes('"') || (/\s/.test(arg) && arg.endsWith('\\')));
}

/** Only commands whose every argument can be shown and pasted exactly are presented. */
function present(action: NextAction, shell: CommandShell): NextAction {
  if (!action.commands || action.commands.every((argv) => argv.every((arg) => copyable(arg, shell)))) return action;
  const { commands: _withheld, ...rest } = action;
  return { ...rest, detail: `${action.detail} (The command is not shown because a value from the run record cannot be shown or pasted exactly; use the native surface directly.)` };
}

function withCommands(action: Omit<NextAction, 'commands'>, commands: string[][]): NextAction {
  return { ...action, commands };
}

const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const AGENT_BRANCH = /^cc\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** True when `path` is an existing directory strictly inside `root` after resolving symlinks. */
function within(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const offset = relative(realpathSync(root), realpathSync(path));
    return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
  } catch { return false; }
}

/**
 * Worktree records that name a Code Conductor agent branch and base, and (with `root`)
 * an existing directory under that root. Anything else in a record, which may have been
 * imported or edited, is never handed to Git or offered for review.
 */
export function recordedAgentWorktrees(manifest: RunManifest, root?: string): WorktreeRecord[] {
  return (manifest.worktrees ?? []).filter((record) => AGENT_BRANCH.test(record.branch) && SHA.test(record.baseSha) && (!root || within(root, record.path)));
}

/** Whether the run stopped because Git configuration or history files changed; then nothing may run Git in its worktrees. */
export function stoppedForGitControl(manifest: RunManifest): boolean {
  return (manifest.results ?? []).some((result) => (result.blockers ?? []).some((blocker) => blocker.includes(GIT_CONTROL_CHANGED)));
}

function label(assignment: AgentAssignment | undefined, result: AgentResult): string {
  return `${result.role} (${assignment?.harness ?? result.harness}${result.surface ? `@${result.surface}` : ''})`;
}

function runCommand(manifest: RunManifest): string[] {
  return ['cc', 'run', '--repo', manifest.task.repository ?? '.', '--risk', manifest.task.risk, '--objective', manifest.task.objective, ...(manifest.task.specializations?.length ? ['--specializations', manifest.task.specializations.join(',')] : []), '--execute'];
}

function approvalAction(manifest: RunManifest, result: AgentResult, assignment: AgentAssignment | undefined, record: ApprovalRecord): NextAction {
  const subject = `${record.action}${record.recipient ? ` → ${record.recipient}` : ''}`;
  const base = { assignmentId: result.assignmentId, evidenceIds: [] };
  // A refused commit happens after the provider ran: its changes are kept uncommitted in
  // the agent worktree. Re-running the task would start (and possibly bill) the provider
  // again, so the next step is native review and a commit of the person's own.
  if (record.action === 'commit') {
    return { ...base, kind: 'decide', title: `Review the uncommitted agent changes (${subject} was ${record.status})`, detail: `The ${label(assignment, result)} provider ran and its changes are kept uncommitted in its worktree. Review them in Source Control, then commit or discard them yourself. Re-running the task would start the provider again.`, surface: 'source_control' };
  }
  if (record.recipient === 'local:deterministic-gates') {
    return withCommands({ ...base, kind: 'decide', title: `Deterministic gates did not run (${record.status})`, detail: 'The gate commands were not approved, so they did not run and nothing was validated. Run the repository checks yourself, or start a new run from an interactive terminal and approve them when asked.', surface: 'terminal' }, [runCommand(manifest)]);
  }
  if (record.status === 'denied') {
    return withCommands({ ...base, kind: 'decide', title: `You declined ${subject}`, detail: `The ${label(assignment, result)} step did not run. Revise the task or start a new run and decide again.`, surface: 'terminal' }, [runCommand(manifest)]);
  }
  const why = record.status === 'missing'
    ? 'No interactive approver was available, so nothing was performed. Approvals can only be given in an interactive terminal.'
    : record.status === 'expired'
      ? 'The approval prompt was answered after its window closed.'
      : 'The bound context changed while approval was pending, so the stale approval was rejected.';
  return withCommands({ ...base, kind: 'approve_interactively', title: `Approve ${subject} in an interactive terminal`, detail: `${why} Start a new run from a terminal and approve each action when asked.`, surface: 'terminal' }, [runCommand(manifest)]);
}

/**
 * Derive the next native steps for a stored run. Pure apart from resolving worktree
 * paths. Callers pass a manifest that satisfies the RunManifest contract; text taken
 * from it must be rendered with `printable` before display.
 */
export function nextActions(manifest: RunManifest, options: NextActionOptions = {}): NextAction[] {
  const actions: NextAction[] = [];
  const assignments = new Map((manifest.assignments ?? []).map((assignment) => [assignment.id, assignment]));
  const approvals = manifest.approvals ?? [];
  const worktrees = recordedAgentWorktrees(manifest, options.worktreeRoot);
  const gitStopped = stoppedForGitControl(manifest);

  for (const result of manifest.results ?? []) {
    const assignment = assignments.get(result.assignmentId);
    const refused = approvals.find((record) => record.assignmentId === result.assignmentId && record.status !== 'approved');
    const blockers = (result.blockers ?? []).join(' ');
    if (refused) { actions.push(approvalAction(manifest, result, assignment, refused)); continue; }
    if (result.status === 'blocked' && blockers.includes('has not passed Code Conductor workstation')) {
      const mode = assignment?.authority?.includes('modify_worktree') ? 'modify' : 'read';
      const harness = assignment?.harness ?? result.harness;
      const kiro = harness === 'kiro' ? ` Kiro also requires --ack-kiro-policy after you read its current subscription/automation policy${mode === 'modify' ? ', and its read smoke must pass before the modify smoke' : ''}.` : '';
      const action = {
        kind: 'validate_harness' as const, title: `Validate ${harness} for ${mode} work`,
        detail: `Sign in through the official ${harness} client first, then run the ${mode} smoke test on this workstation.${kiro}`,
        surface: 'official_client' as const, assignmentId: result.assignmentId, evidenceIds: [],
      };
      // The harness name comes from the run record; only a plain name goes into a command.
      actions.push(PLAIN_ID.test(harness) ? withCommands(action, [['cc', 'harness-smoke', harness, '--mode', mode]]) : { ...action, detail: `${action.detail} (No command is shown because the harness name is not plain.)` });
      continue;
    }
    if (result.status === 'blocked' && (blockers.includes(CLIENT_NOT_SIGNED_IN) || blockers.includes(CLIENT_BILLS_SEPARATELY))) {
      const harness = assignment?.harness ?? result.harness;
      const billing = !blockers.includes(CLIENT_NOT_SIGNED_IN);
      actions.push(withCommands({
        kind: 'validate_harness', title: billing ? `Use your subscription sign-in for ${harness}` : `Sign in to ${harness} in its official client`,
        detail: billing
          ? 'The client is signed in with a credential billed separately from your subscription, so Code Conductor did not start it. Sign in with your subscription in the official client, or remove that credential from the client\'s own configuration, then run the task again.'
          : 'The official client did not report a sign-in, so Code Conductor did not start it. `cc doctor` shows each client\'s official sign-in command and documentation. Sign in there, then run the task again.',
        surface: 'official_client', assignmentId: result.assignmentId, evidenceIds: [],
      }, [['cc', 'doctor']]));
      continue;
    }
    if (result.status === 'awaiting_external') {
      if ((assignment?.harness ?? result.harness) === 'copilot-github') {
        actions.push({ kind: 'github_review', title: 'Review the change on GitHub', detail: 'GitHub review (Copilot review, required checks, branch protection) is the native gate. Push the agent branch and open a draft pull request yourself, then review there.', surface: 'github', assignmentId: result.assignmentId, evidenceIds: [] });
      } else {
        const modifies = assignment?.authority?.includes('modify_worktree');
        const detail = `No supported unattended surface is available for this assignment. Print its exact prompt and run it yourself in the official client.${modifies ? ' It changes files: work in an isolated branch or worktree (for example `git worktree add`), never in a checkout that holds other work (AGENTS.md §6).' : ''} To keep the outcome with Code Conductor's evidence, record it as a RunManifest file and bring it in with \`cc import\`.`;
        const action = { kind: 'manual_handoff' as const, title: `Complete ${label(assignment, result)} manually`, detail, surface: 'manual' as const, assignmentId: result.assignmentId, evidenceIds: [] };
        // Only plain identifiers go into a command; anything else could break out of shell quoting.
        actions.push(PLAIN_ID.test(manifest.runId) && PLAIN_ID.test(result.assignmentId)
          ? withCommands(action, [['cc', 'handoff', '--run', manifest.runId, '--assignment', result.assignmentId]])
          : { ...action, detail: `${detail} (No command is shown because the run or assignment identifier is not plain.)` });
      }
      continue;
    }
    const failedGates = Array.isArray(result.tests) ? result.tests.filter((gate) => gate.status === 'failed') : [];
    if (failedGates.length) {
      actions.push({ kind: 'fix_validation', title: `Fix failing validation: ${failedGates.map((gate) => gate.gate).join(', ')}`, detail: failedGates.map((gate) => gate.summary ?? gate.gate).join(' '), surface: 'terminal', assignmentId: result.assignmentId, evidenceIds: failedGates.flatMap((gate) => gate.evidenceIds) });
      continue;
    }
    const blocking = Array.isArray(result.findings) ? result.findings.filter((finding) => finding.blocking) : [];
    if (blocking.length) {
      actions.push({ kind: 'resolve_findings', title: `Resolve ${blocking.length} blocking finding(s) from ${label(assignment, result)}`, detail: blocking.map((finding) => `[${finding.severity}] ${finding.summary}`).join(' '), surface: 'source_control', assignmentId: result.assignmentId, evidenceIds: blocking.flatMap((finding) => finding.evidenceIds) });
      continue;
    }
    if (result.status === 'failed' || result.status === 'blocked' || result.status === 'cancelled') {
      if (blockers.startsWith('Dependencies not completed')) continue;
      actions.push({ kind: 'retry_or_revise', title: `${label(assignment, result)} ${result.status}`, detail: blockers || 'See the run evidence.', surface: 'terminal', assignmentId: result.assignmentId, evidenceIds: (result.evidence ?? []).map((item) => item.id) });
    }
  }

  for (const worktree of worktrees) {
    if (gitStopped) {
      // Source Control, `git status` and `git diff` would run Git (fsmonitor, diff drivers)
      // under the configuration that changed; inspecting the configuration does not.
      actions.push(withCommands({
        kind: 'inspect_git_configuration', title: `Check Git configuration before reviewing ${worktree.branch}`,
        detail: 'The run stopped because Git configuration or history files changed while it ran. Opening this worktree in Source Control or running git status/diff would run Git under that configuration. Inspect and restore the configuration first, then review the changes.',
        surface: 'terminal', assignmentId: worktree.assignmentId, path: worktree.path, evidenceIds: [],
      }, [['git', '-C', worktree.path, 'config', '--list', '--show-origin']]));
      continue;
    }
    actions.push(withCommands({
      kind: 'review_changes', title: `Review ${worktree.branch} in Source Control`,
      detail: `Agent changes are isolated in their own worktree based on ${worktree.baseSha.slice(0, 12)}. Review the diff natively before anything is pushed or merged.`,
      surface: 'source_control', assignmentId: worktree.assignmentId, path: worktree.path, evidenceIds: [],
    }, [['git', '-C', worktree.path, 'status'], ['git', '-C', worktree.path, 'diff', worktree.baseSha]]));
  }

  const results = new Map((manifest.results ?? []).map((result) => [result.assignmentId, result]));
  const committed = worktrees.filter((worktree) => (results.get(worktree.assignmentId)?.changes ?? []).length > 0);
  const builder = committed.find((worktree) => assignments.get(worktree.assignmentId)?.role === 'builder') ?? committed[0];
  if (manifest.mergeDecision?.decision === 'ready' && builder && !gitStopped) {
    actions.push(withCommands({
      kind: 'prepare_pull_request', title: 'Open a draft pull request',
      detail: 'Deterministic gates and required reviews passed locally. Pushing and opening a pull request are your actions; merge remains a GitHub decision under branch protection and review. Run gh from inside the agent worktree so it targets this repository.',
      surface: 'github', assignmentId: builder.assignmentId, path: builder.path, evidenceIds: manifest.mergeDecision.evidenceIds,
    }, [['git', '-C', builder.path, 'push', '-u', 'origin', builder.branch], ['gh', 'pr', 'create', '--draft', '--head', builder.branch, '--fill']]));
  } else if (manifest.mergeDecision?.decision === 'human_required' && !actions.some((action) => action.kind === 'approve_interactively' || action.kind === 'decide' || action.kind === 'manual_handoff' || action.kind === 'github_review' || action.kind === 'inspect_git_configuration')) {
    actions.push({ kind: 'decide', title: 'Human decision required', detail: manifest.mergeDecision.rationale, surface: 'github', evidenceIds: manifest.mergeDecision.evidenceIds });
  }
  const shell = options.shell ?? DEFAULT_SHELL;
  return actions.map((action) => present(action, shell));
}
