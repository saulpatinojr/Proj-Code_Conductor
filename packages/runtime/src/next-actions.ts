import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentAssignment, AgentResult, ApprovalRecord, RunManifest, WorktreeRecord } from '@code-conductor/schemas';

/**
 * Where a person completes the next step. Code Conductor presents the step and
 * links to the native surface; it never performs outward-facing steps (push,
 * pull request, sign-in, deployment) on the person's behalf from here.
 */
export type NativeSurface = 'source_control' | 'terminal' | 'official_client' | 'github' | 'manual';

export interface NextAction {
  kind: 'review_changes' | 'approve_interactively' | 'decide' | 'validate_harness' | 'manual_handoff' | 'github_review' | 'fix_validation' | 'resolve_findings' | 'retry_or_revise' | 'prepare_pull_request';
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
}

const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX-shell display form of an argument vector. */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((arg) => (SAFE_ARGUMENT.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');
}

function within(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

function label(assignment: AgentAssignment | undefined, result: AgentResult): string {
  return `${result.role} (${assignment?.harness ?? result.harness}${result.surface ? `@${result.surface}` : ''})`;
}

function runCommand(manifest: RunManifest): string[] {
  return ['cc', 'run', '--repo', manifest.task.repository ?? '.', '--risk', manifest.task.risk, '--objective', manifest.task.objective, ...(manifest.task.specializations?.length ? ['--specializations', manifest.task.specializations.join(',')] : []), '--execute'];
}

function approvalAction(manifest: RunManifest, result: AgentResult, assignment: AgentAssignment | undefined, record: ApprovalRecord): NextAction {
  const subject = `${record.action}${record.recipient ? ` → ${record.recipient}` : ''}`;
  if (record.status === 'denied') {
    return { kind: 'decide', title: `You declined ${subject}`, detail: `The ${label(assignment, result)} step did not run. Revise the task or start a new run and decide again.`, surface: 'terminal', assignmentId: result.assignmentId, commands: [runCommand(manifest)], evidenceIds: [] };
  }
  const why = record.status === 'missing'
    ? 'No interactive approver was available, so nothing was performed. Approvals can only be given in an interactive terminal.'
    : record.status === 'expired'
      ? 'The approval prompt was answered after its window closed.'
      : 'The bound context changed while approval was pending, so the stale approval was rejected.';
  return { kind: 'approve_interactively', title: `Approve ${subject} in an interactive terminal`, detail: `${why} Start a new run from a terminal and approve each action when asked.`, surface: 'terminal', assignmentId: result.assignmentId, commands: [runCommand(manifest)], evidenceIds: [] };
}

/** Derive the next native steps for a stored run. Pure; tolerant of partial manifests. */
export function nextActions(manifest: RunManifest, options: NextActionOptions = {}): NextAction[] {
  const actions: NextAction[] = [];
  const assignments = new Map((manifest.assignments ?? []).map((assignment) => [assignment.id, assignment]));
  const approvals = manifest.approvals ?? [];
  const worktrees: WorktreeRecord[] = (manifest.worktrees ?? []).filter((record) => !options.worktreeRoot || within(options.worktreeRoot, record.path));

  for (const result of manifest.results ?? []) {
    const assignment = assignments.get(result.assignmentId);
    const refused = approvals.find((record) => record.assignmentId === result.assignmentId && record.status !== 'approved');
    const blockers = (result.blockers ?? []).join(' ');
    if (refused) { actions.push(approvalAction(manifest, result, assignment, refused)); continue; }
    if (result.status === 'blocked' && blockers.includes('has not passed Code Conductor workstation')) {
      const mode = assignment?.authority.includes('modify_worktree') ? 'modify' : 'read';
      const harness = assignment?.harness ?? result.harness;
      actions.push({
        kind: 'validate_harness', title: `Validate ${harness} for ${mode} work`,
        detail: `Sign in through the official ${harness} client first, then run the ${mode} smoke test on this workstation.${harness === 'kiro' ? ' Kiro also requires --ack-kiro-policy after you read its current subscription/automation policy.' : ''}`,
        surface: 'official_client', assignmentId: result.assignmentId, commands: [['cc', 'harness-smoke', harness, '--mode', mode]], evidenceIds: [],
      });
      continue;
    }
    if (result.status === 'awaiting_external') {
      if ((assignment?.harness ?? result.harness) === 'copilot-github') {
        actions.push({ kind: 'github_review', title: 'Review the change on GitHub', detail: 'GitHub review (Copilot review, required checks, branch protection) is the native gate. Push the agent branch and open a draft pull request yourself, then review there.', surface: 'github', assignmentId: result.assignmentId, evidenceIds: [] });
      } else {
        actions.push({ kind: 'manual_handoff', title: `Complete ${label(assignment, result)} manually`, detail: 'No supported unattended surface is available for this assignment. Print its exact prompt, run it yourself in the official client, and keep the evidence with the run.', surface: 'manual', assignmentId: result.assignmentId, commands: [['cc', 'handoff', '--run', manifest.runId, '--assignment', result.assignmentId]], evidenceIds: [] });
      }
      continue;
    }
    const failedGates = result.tests?.filter((gate) => gate.status === 'failed') ?? [];
    if (failedGates.length) {
      actions.push({ kind: 'fix_validation', title: `Fix failing validation: ${failedGates.map((gate) => gate.gate).join(', ')}`, detail: failedGates.map((gate) => gate.summary ?? gate.gate).join(' '), surface: 'terminal', assignmentId: result.assignmentId, evidenceIds: failedGates.flatMap((gate) => gate.evidenceIds) });
      continue;
    }
    const blocking = result.findings?.filter((finding) => finding.blocking) ?? [];
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
    actions.push({
      kind: 'review_changes', title: `Review ${worktree.branch} in Source Control`,
      detail: `Agent changes are isolated in their own worktree based on ${worktree.baseSha.slice(0, 12)}. Review the diff natively before anything is pushed or merged.`,
      surface: 'source_control', assignmentId: worktree.assignmentId, path: worktree.path,
      commands: [['git', '-C', worktree.path, 'status'], ['git', '-C', worktree.path, 'diff', worktree.baseSha]], evidenceIds: [],
    });
  }

  const builder = worktrees.find((worktree) => assignments.get(worktree.assignmentId)?.role === 'builder') ?? worktrees[0];
  if (manifest.mergeDecision?.decision === 'ready' && builder) {
    actions.push({
      kind: 'prepare_pull_request', title: 'Open a draft pull request',
      detail: 'Deterministic gates and required reviews passed locally. Pushing and opening a pull request are your actions; merge remains a GitHub decision under branch protection and review.',
      surface: 'github', assignmentId: builder.assignmentId, path: builder.path,
      commands: [['git', '-C', builder.path, 'push', '-u', 'origin', builder.branch], ['gh', 'pr', 'create', '--draft', '--head', builder.branch, '--fill']], evidenceIds: manifest.mergeDecision.evidenceIds,
    });
  } else if (manifest.mergeDecision?.decision === 'human_required' && !actions.some((action) => action.kind === 'approve_interactively' || action.kind === 'decide' || action.kind === 'manual_handoff' || action.kind === 'github_review')) {
    actions.push({ kind: 'decide', title: 'Human decision required', detail: manifest.mergeDecision.rationale, surface: 'github', evidenceIds: manifest.mergeDecision.evidenceIds });
  }
  return actions;
}
