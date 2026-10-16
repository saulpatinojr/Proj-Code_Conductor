import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRecord, ApprovalRequest, RunManifest, WorktreeRecord } from '@code-conductor/schemas';
import { commitsSince, gitChangedFiles, isSensitiveRepositoryPath, MAX_SCAN_BYTES, pushCommit, redactUrl, remoteUrls, resolveCommit, scanHistoryForNewSecrets, treeChangedFiles } from '@code-conductor/git';
import { ApprovalGate, approvalBlocker, type Approver } from '@code-conductor/policy';
import type { RunStore } from '@code-conductor/evidence';
import { shortList, summarizeFiles } from './change-summary.js';
import { recordedAgentWorktrees, stoppedForGitControl } from './next-actions.js';

/** Runs the official GitHub CLI (`gh`); authentication stays with `gh auth`. Injected so tests never reach GitHub. */
export type GitHubCliRunner = (cwd: string, args: string[]) => { ok: boolean; status: number | null; stdout: string; stderr: string };

export interface PullRequestOptions {
  assignmentId?: string; base?: string; remote?: string; title?: string;
  /** Only worktrees under this directory are used (run records can be imported or edited). */
  worktreeRoot?: string;
}

/** Everything a draft pull request for one agent branch would push and disclose. */
export interface PullRequestPlan {
  runId: string; taskId: string; assignmentId: string;
  path: string; branch: string; baseSha: string; head: string;
  remote: string; fetchUrl: string; pushUrl: string; repository: string;
  base: string; title: string; body: string;
  commits: string[]; files: string[]; uncommitted: string[];
  /** Reasons Code Conductor refuses to push this branch at all. */
  refusals: string[];
}

export interface PullRequestOutcome { status: 'created' | 'refused'; plan?: PullRequestPlan; url?: string; blocker?: string; approvals: ApprovalRecord[] }

const MAX_TITLE = 120;
const MAX_BODY = 60_000;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * `[HOST/]OWNER/REPO` for a GitHub remote URL (HTTPS, SSH or scp-style), as `gh --repo`
 * accepts it; undefined for anything else, for example a local path.
 */
export function githubRepository(url: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}/${scp[3]}`;
  try {
    const parsed = new URL(url);
    if (!['https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    return parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part)) ? `${parsed.hostname}/${parts[0]}/${parts[1]}` : undefined;
  } catch { return undefined; }
}

function pickWorktree(manifest: RunManifest, assignmentId?: string, root?: string): WorktreeRecord {
  const records = recordedAgentWorktrees(manifest, root);
  if (assignmentId) {
    const record = records.find((item) => item.assignmentId === assignmentId);
    if (!record) throw new Error(`Run ${manifest.runId} recorded no usable agent worktree for assignment ${assignmentId}.`);
    return record;
  }
  const completed = records.filter((item) => manifest.results.some((result) => result.assignmentId === item.assignmentId && result.status === 'completed'));
  if (completed.length === 1) return completed[0]!;
  throw new Error(completed.length
    ? `Run ${manifest.runId} has several completed agent worktrees (${completed.map((item) => item.assignmentId).join(', ')}); choose one with --assignment.`
    : `Run ${manifest.runId} has no completed agent worktree to open a pull request from.`);
}

function pullRequestBody(manifest: RunManifest, plan: Pick<PullRequestPlan, 'assignmentId' | 'branch' | 'baseSha' | 'head' | 'commits' | 'files'>): string {
  const decision = manifest.mergeDecision;
  const approvals = manifest.approvals ?? [];
  const counted = (status: string): number => approvals.filter((record) => record.status === status).length;
  const lines = [
    `Opened as a draft by Code Conductor at a person's explicit, approved request. Merging remains a GitHub decision under this repository's reviews and branch protection.`,
    '',
    `- **Run:** \`${manifest.runId}\`, task \`${manifest.task.id}\` (${manifest.task.risk})`,
    `- **Objective:** ${oneLine(manifest.task.objective)}`,
    `- **Branch:** \`${plan.branch}\` at \`${plan.head}\`, ${plan.commits.length} commit(s) and ${plan.files.length} changed file(s) since \`${plan.baseSha}\``,
    `- **Local decision:** ${decision ? `\`${decision.decision}\`: ${oneLine(decision.rationale)}` : 'not executed'}`,
    `- **Pre-action approvals:** ${approvals.length ? `${counted('approved')} approved, ${approvals.length - counted('approved')} not approved` : 'none recorded'}`,
    '',
    '| Assignment | Agent | Role | Status | Recommendation |',
    '|---|---|---|---|---|',
    ...manifest.results.map((result) => `| ${result.assignmentId}${result.assignmentId === plan.assignmentId ? ' (this branch)' : ''} | ${result.agentId} (${result.provider}/${result.harness}) | ${result.role} | ${result.status} | ${result.recommendation} |`),
    '',
    `Deterministic gates: ${manifest.gates.length ? manifest.gates.map((gate) => `${gate.gate} ${gate.status}`).join(', ') : 'none run'}.`,
  ];
  const notVerified = [...new Set(manifest.results.flatMap((result) => result.notVerified ?? []))];
  if (notVerified.length) lines.push('', `Not verified by the agents: ${notVerified.map(oneLine).join('; ')}`);
  const risks = [...new Set(manifest.results.flatMap((result) => result.risks))];
  if (risks.length) lines.push('', `Reported risks: ${risks.map(oneLine).join('; ')}`);
  const body = lines.join('\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n[Truncated; the full run evidence stays in the local Code Conductor run store.]` : body;
}

/**
 * Describe the draft pull request for one agent branch of a stored run, without
 * pushing or creating anything. Refusals are reported, not thrown, so a preview
 * can show them.
 */
export function planPullRequest(manifest: RunManifest, options: PullRequestOptions = {}): PullRequestPlan {
  // Everything below runs Git in the agent worktree, which must not happen under
  // configuration that changed during the run, or while the run may still be using it.
  if (stoppedForGitControl(manifest)) throw new Error(`Run ${manifest.runId} stopped because Git configuration or history files changed, so no Git command was run for it. Check the configuration of its worktree first.`);
  if (!manifest.mergeDecision) throw new Error(`Run ${manifest.runId} has no outcome yet (still running, or interrupted).`);
  const record = pickWorktree(manifest, options.assignmentId, options.worktreeRoot);
  const remote = options.remote ?? 'origin';
  const head = resolveCommit(record.path, `refs/heads/${record.branch}`);
  const history = commitsSince(record.path, record.baseSha, head);
  const files = treeChangedFiles(record.path, record.baseSha, head);
  const { fetch, push } = remoteUrls(record.path, remote);
  const repository = githubRepository(fetch) ?? '';
  const refusals: string[] = [];
  if (!history.commits.length) refusals.push(`${record.branch} has no commits since ${record.baseSha.slice(0, 12)}; there is nothing to push.`);
  if (!repository) refusals.push(`Remote ${remote} (${redactUrl(fetch)}) is not a GitHub repository URL.`);
  const sensitive = history.files.filter(isSensitiveRepositoryPath);
  if (sensitive.length) refusals.push(`The commits to push touch sensitive repository paths: ${sensitive.join(', ')}. Their content stays in history even if later removed.`);
  // Every file version in the pushed history, so a credential a later commit removed is still found.
  const scan = scanHistoryForNewSecrets(record.path, record.baseSha, head);
  if (scan.findings.length) refusals.push(`The commits to push add credential-looking strings: ${scan.findings.map((finding) => `${finding.path}:${finding.line} (${finding.kind})`).join(', ')}. Their content stays in history even if later removed.`);
  if (scan.unscanned.length) refusals.push(`${scan.unscanned.length} file(s) in the commits to push are past the ${MAX_SCAN_BYTES / (1024 * 1024)} MiB credential-scan budget and were not scanned: ${scan.unscanned.slice(0, 10).join(', ')}.`);
  const title = oneLine(options.title ?? `Code Conductor: ${manifest.task.objective}`).slice(0, MAX_TITLE) || `Code Conductor run ${manifest.runId}`;
  const base = options.base ?? 'main';
  const partial = { assignmentId: record.assignmentId, branch: record.branch, baseSha: record.baseSha, head, commits: history.commits, files };
  return {
    runId: manifest.runId, taskId: manifest.task.id, ...partial, path: record.path,
    remote, fetchUrl: redactUrl(fetch), pushUrl: redactUrl(push), repository, base, title,
    body: pullRequestBody(manifest, partial), uncommitted: gitChangedFiles(record.path), refusals,
  };
}

function approvalRequest(plan: PullRequestPlan): ApprovalRequest {
  const destination = plan.pushUrl === plan.fetchUrl ? plan.pushUrl : `${plan.pushUrl} (your Git configuration rewrites pushes to ${plan.fetchUrl} there)`;
  return {
    action: 'context_disclosure', runId: plan.runId, taskId: plan.taskId, assignmentId: plan.assignmentId,
    repository: plan.path, revision: plan.head, recipient: `github:${plan.repository}`,
    bindings: {
      remote: plan.remote, pushUrl: plan.pushUrl, fetchUrl: plan.fetchUrl, branch: plan.branch, head: plan.head, base: plan.base,
      commits: sha256(plan.commits.join('\n')), files: sha256(plan.files.join('\n')), title: sha256(plan.title), body: sha256(plan.body),
    },
    summary: [
      `Push ${plan.head.slice(0, 12)} with ${plan.commits.length} commit(s) (${shortList(plan.commits)}) to ${destination} as ${plan.branch}, then open a draft pull request in ${plan.repository} into ${plan.base} titled "${plan.title}".`,
      'Everyone who can read that repository will see these commits and the pull request text.',
      plan.uncommitted.length ? `${plan.uncommitted.length} uncommitted file(s) in ${plan.path} are not included.` : '',
      `${summarizeFiles(plan.files)}.`,
    ].filter(Boolean).join(' '),
  };
}

/**
 * Push the agent branch's exact commit and open a draft pull request, only after a
 * person approves this exact push and text immediately beforehand. Repository hooks
 * never run (Code Conductor's Git calls disable them); authentication is the person's
 * own Git credentials and `gh auth`. Nothing is force-pushed.
 */
export async function openDraftPullRequest(manifest: RunManifest, options: PullRequestOptions, dependencies: { gh: GitHubCliRunner; approver?: Approver; store?: RunStore; ttlMs?: number; now?: () => number }): Promise<PullRequestOutcome> {
  const gate = new ApprovalGate({ ...(dependencies.approver ? { approver: dependencies.approver } : {}), ...(dependencies.ttlMs !== undefined ? { ttlMs: dependencies.ttlMs } : {}), ...(dependencies.now ? { now: dependencies.now } : {}) });
  let plan: PullRequestPlan | undefined;
  let outcome;
  try {
    outcome = await gate.authorize(() => {
      plan = planPullRequest(manifest, options);
      if (plan.refusals.length) throw new Error(plan.refusals.join(' '));
      return [approvalRequest(plan)];
    });
  } catch (error) {
    return { status: 'refused', ...(plan ? { plan } : {}), blocker: error instanceof Error ? error.message : String(error), approvals: [...gate.records] };
  }
  const record = (type: string, message: string, data?: Record<string, unknown>): void => {
    dependencies.store?.appendEvent({ at: new Date().toISOString(), runId: manifest.runId, type, ...(plan ? { assignmentId: plan.assignmentId } : {}), message, ...(data ? { data } : {}) });
  };
  for (const item of outcome.records) record('approval.decided', `${item.action}: ${item.status}`, { requestDigest: item.requestDigest, approver: item.approver });
  if (!outcome.approved || !plan) return { status: 'refused', ...(plan ? { plan } : {}), blocker: approvalBlocker(outcome.records), approvals: outcome.records };
  const approved = plan;
  try {
    pushCommit(approved.path, approved.remote, approved.head, approved.branch);
  } catch (error) {
    return { status: 'refused', plan: approved, blocker: `Push was refused, so no pull request was opened: ${error instanceof Error ? error.message : String(error)}`, approvals: outcome.records };
  }
  record('branch.pushed', `${approved.branch}@${approved.head}`, { remote: approved.remote, pushUrl: approved.pushUrl });
  // The body goes through a private file: a long body would exceed Windows command-line limits.
  const directory = mkdtempSync(join(tmpdir(), 'cc-pr-'));
  try {
    const bodyFile = join(directory, 'body.md');
    writeFileSync(bodyFile, approved.body, { encoding: 'utf8', mode: 0o600 });
    const created = dependencies.gh(approved.path, ['pr', 'create', '--draft', '--repo', approved.repository, '--base', approved.base, '--head', approved.branch, '--title', approved.title, '--body-file', bodyFile]);
    if (!created.ok) return { status: 'refused', plan: approved, blocker: `${approved.branch} was pushed, but gh could not open the draft pull request: ${created.stderr.trim() || `exit ${String(created.status)}`}. Open it yourself with \`gh pr create --draft --head ${approved.branch}\`.`, approvals: outcome.records };
    const url = /https?:\/\/\S+/.exec(created.stdout.trim().split(/\r?\n/).at(-1) ?? '')?.[0];
    record('pull_request.created', url ?? 'created', { repository: approved.repository, head: approved.head, base: approved.base });
    return { status: 'created', plan: approved, ...(url ? { url } : {}), approvals: outcome.records };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
