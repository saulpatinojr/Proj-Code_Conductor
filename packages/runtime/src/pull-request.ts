import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRecord, ApprovalRequest, RunManifest, WorktreeRecord } from '@code-conductor/schemas';
import { commitsSince, gitChangedFiles, isSensitiveRepositoryPath, MAX_SCAN_BYTES, onRemote, pushCommit, redactSecrets, redactUrl, remoteUrls, resolveCommit, scanHistoryForNewSecrets, treeChangedFiles } from '@code-conductor/git';
import { ApprovalGate, approvalBlocker, type Approver } from '@code-conductor/policy';
import type { RunStore } from '@code-conductor/evidence';
import { shortList, summarizeFiles } from './change-summary.js';
import { recordedAgentWorktrees, stoppedForGitControl } from './next-actions.js';

/** Runs the official GitHub CLI (`gh`); authentication stays with `gh auth`. Injected so tests never reach GitHub. */
export type GitHubCliRunner = (cwd: string, args: string[]) => { ok: boolean; status: number | null; stdout: string; stderr: string };
/** Pushes one commit to one branch of a remote; `pushCommit` unless a test injects a local destination. */
export type CommitPusher = (path: string, remote: string, sha: string, branch: string) => void;

export interface PullRequestOptions {
  assignmentId?: string; base?: string; remote?: string; title?: string;
  /** Only worktrees under this directory are used (run records can be imported or edited). */
  worktreeRoot?: string;
}

/** Everything a draft pull request for one agent branch would push and disclose. */
export interface PullRequestPlan {
  runId: string; taskId: string; assignmentId: string;
  path: string; branch: string; baseSha: string; head: string;
  /** Display forms (no credentials). `pushUrl` is the one push URL, or empty when there is not exactly one. */
  remote: string; fetchUrl: string; pushUrl: string; pushUrls: string[]; repository: string;
  /** SHA-256 of the exact push URL, which the approval binds; the URL itself may hold a credential. */
  pushUrlDigest: string;
  base: string; title: string; body: string;
  /** SHA-256 of the pull request text, shown in the preview and the approval so they can be compared. */
  textDigest: string;
  /** Credential-looking strings replaced in the title and body. */
  redacted: number;
  commits: string[]; files: string[]; uncommitted: string[];
  /** Reasons Code Conductor refuses to push this branch at all. */
  refusals: string[];
}

export interface PullRequestOutcome { status: 'created' | 'refused'; plan?: PullRequestPlan; url?: string; blocker?: string; approvals: ApprovalRecord[] }

const MAX_TITLE = 120;
const MAX_BODY = 60_000;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
// Agent-written text is shown as a code span, where GitHub renders no @-mentions, issue
// references, closing keywords, links or images. Inside a table cell a pipe would still
// end the cell, so it is escaped there too.
const literal = (text: string): string => {
  const value = oneLine(text);
  const fence = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  return value ? `${fence} ${value} ${fence}` : '';
};
const cell = (text: string): string => literal(text).replaceAll('|', '\\|');
const sameRepository = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

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
    const status = manifest.results.find((result) => result.assignmentId === assignmentId)?.status;
    if (status !== 'completed') throw new Error(`Assignment ${assignmentId} of run ${manifest.runId} is ${status ?? 'without a result'}, not completed; only completed work is opened as a pull request.`);
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
    `- **Local decision:** ${decision ? `\`${decision.decision}\`: ${literal(decision.rationale)}` : 'not executed'}`,
    `- **Pre-action approvals:** ${approvals.length ? `${counted('approved')} approved, ${approvals.length - counted('approved')} not approved` : 'none recorded'}`,
    '',
    '| Assignment | Agent | Role | Status | Recommendation |',
    '|---|---|---|---|---|',
    ...manifest.results.map((result) => `| ${cell(result.assignmentId)}${result.assignmentId === plan.assignmentId ? ' (this branch)' : ''} | ${cell(`${result.agentId} (${result.provider}/${result.harness})`)} | ${cell(result.role)} | ${cell(result.status)} | ${cell(result.recommendation)} |`),
    '',
    `Deterministic gates: ${manifest.gates.length ? manifest.gates.map((gate) => literal(`${gate.gate} ${gate.status}`)).join(', ') : 'none run'}.`,
  ];
  const notVerified = [...new Set(manifest.results.flatMap((result) => result.notVerified ?? []))];
  if (notVerified.length) lines.push('', `Not verified by the agents: ${notVerified.map(literal).join('; ')}`);
  const risks = [...new Set(manifest.results.flatMap((result) => result.risks))];
  if (risks.length) lines.push('', `Reported risks: ${risks.map(literal).join('; ')}`);
  return lines.join('\n');
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
  // A push goes to every push URL of the remote. Exactly one is allowed, and it must be
  // the repository the pull request is opened in, so the approval names every destination.
  if (push.length !== 1) refusals.push(`Remote ${remote} pushes to ${push.length} URLs (${push.map(redactUrl).join(', ')}); Code Conductor pushes to exactly one. Give it a single push URL, or name another remote with --remote.`);
  else if (repository && !sameRepository(githubRepository(push[0]!) ?? '', repository)) refusals.push(`Remote ${remote} pushes to ${redactUrl(push[0]!)}, which is not ${repository}, where the pull request would be opened. Configure push and fetch URLs that name the same repository and host, or name another remote with --remote.`);
  // A push also publishes every ancestor the remote lacks, which this plan does not list.
  if (!onRemote(record.path, record.baseSha, remote)) refusals.push(`Base ${record.baseSha.slice(0, 12)} is not on any ${remote} branch as of the last fetch, so the push would also publish it and any unpushed commits before it, unlisted and unscanned. Push them yourself first, or run \`git fetch ${remote}\` if they are already there.`);
  const sensitive = history.files.filter(isSensitiveRepositoryPath);
  if (sensitive.length) refusals.push(`The commits to push touch sensitive repository paths: ${sensitive.join(', ')}. Their content stays in history even if later removed.`);
  // Every file version in the pushed history, so a credential a later commit removed is still found.
  const scan = scanHistoryForNewSecrets(record.path, record.baseSha, head);
  if (scan.findings.length) refusals.push(`The commits to push add credential-looking strings: ${scan.findings.map((finding) => `${finding.path}:${finding.line} (${finding.kind})`).join(', ')}. Their content stays in history even if later removed.`);
  if (scan.unscanned.length) refusals.push(`${scan.unscanned.length} file(s) in the commits to push are past the ${MAX_SCAN_BYTES / (1024 * 1024)} MiB credential-scan budget and were not scanned: ${scan.unscanned.slice(0, 10).join(', ')}.`);
  // The text is published to everyone who can read the repository, and the approval shows
  // it only by digest, so credential-looking strings agents reported are replaced.
  const title = redactSecrets(oneLine(options.title ?? `Code Conductor: ${manifest.task.objective}`).slice(0, MAX_TITLE) || `Code Conductor run ${manifest.runId}`);
  const base = options.base ?? 'main';
  const partial = { assignmentId: record.assignmentId, branch: record.branch, baseSha: record.baseSha, head, commits: history.commits, files };
  // Redacted before it is shortened, so a credential cut in two cannot slip past the patterns.
  const full = redactSecrets(pullRequestBody(manifest, partial));
  const body = { ...full, text: full.text.length > MAX_BODY ? `${full.text.slice(0, MAX_BODY)}\n\n[Truncated; the full run evidence stays in the local Code Conductor run store.]` : full.text };
  return {
    runId: manifest.runId, taskId: manifest.task.id, ...partial, path: record.path,
    remote, fetchUrl: redactUrl(fetch), pushUrl: push.length === 1 ? redactUrl(push[0]!) : '', pushUrls: push.map(redactUrl), pushUrlDigest: sha256(push.join('\n')), repository, base,
    title: title.text, body: body.text, textDigest: sha256(`${title.text}\n${body.text}`), redacted: title.redacted + body.redacted,
    uncommitted: gitChangedFiles(record.path), refusals,
  };
}

function approvalRequest(plan: PullRequestPlan): ApprovalRequest {
  const destination = plan.pushUrl === plan.fetchUrl ? plan.pushUrl : `${plan.pushUrl} (your Git configuration rewrites pushes to ${plan.fetchUrl} there)`;
  return {
    action: 'context_disclosure', runId: plan.runId, taskId: plan.taskId, assignmentId: plan.assignmentId,
    repository: plan.path, revision: plan.head, recipient: `github:${plan.repository}`,
    bindings: {
      remote: plan.remote, pushUrl: plan.pushUrlDigest, fetchUrl: plan.fetchUrl, branch: plan.branch, head: plan.head, base: plan.base,
      commits: sha256(plan.commits.join('\n')), files: sha256(plan.files.join('\n')), title: sha256(plan.title), body: sha256(plan.body),
    },
    summary: [
      `Push ${plan.head.slice(0, 12)} with ${plan.commits.length} commit(s) (${shortList(plan.commits)}) to ${destination} as ${plan.branch}, and nothing else (no tags), then open a draft pull request in ${plan.repository} into ${plan.base} titled "${plan.title}".`,
      `Everyone who can read that repository will see these commits and the pull request text (sha256 ${plan.textDigest.slice(0, 16)}, as in the preview).`,
      plan.redacted ? `${plan.redacted} credential-looking string(s) agents reported were replaced in that text.` : '',
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
export async function openDraftPullRequest(manifest: RunManifest, options: PullRequestOptions, dependencies: { gh: GitHubCliRunner; push?: CommitPusher; approver?: Approver; store?: RunStore; ttlMs?: number; now?: () => number }): Promise<PullRequestOutcome> {
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
  const refused = (type: string, blocker: string): PullRequestOutcome => {
    record(type, oneLine(blocker).slice(0, 2000));
    return { status: 'refused', plan: approved, blocker, approvals: outcome.records };
  };
  try {
    // The push goes to whatever the remote names at this moment, so check it once more.
    const { push } = remoteUrls(approved.path, approved.remote);
    if (push.length !== 1 || sha256(push.join('\n')) !== approved.pushUrlDigest) throw new Error(`the push URLs of ${approved.remote} changed after approval`);
    (dependencies.push ?? pushCommit)(approved.path, approved.remote, approved.head, approved.branch);
  } catch (error) {
    return refused('branch.push_refused', `Push was refused, so no pull request was opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  record('branch.pushed', `${approved.branch}@${approved.head}`, { remote: approved.remote, pushUrl: approved.pushUrl });
  // The body goes through a private file: a long body would exceed Windows command-line
  // limits. gh runs there too, not in the agent worktree: --repo and --head say everything.
  const directory = mkdtempSync(join(tmpdir(), 'cc-pr-'));
  try {
    const bodyFile = join(directory, 'body.md');
    writeFileSync(bodyFile, approved.body, { encoding: 'utf8', mode: 0o600 });
    const created = dependencies.gh(directory, ['pr', 'create', '--draft', '--repo', approved.repository, '--base', approved.base, '--head', approved.branch, '--title', approved.title, '--body-file', bodyFile]);
    if (!created.ok) return refused('pull_request.failed', `${approved.branch} was pushed, but gh could not open the draft pull request: ${oneLine(created.stderr) || `exit ${String(created.status)}`}. Open it yourself with \`gh pr create --draft --head ${approved.branch}\`.`);
    const url = pullRequestUrl(created.stdout, approved.repository);
    if (!url) return refused('pull_request.unconfirmed', `${approved.branch} was pushed and gh exited successfully, but printed no pull request URL in ${approved.repository}. Check with \`gh pr list --repo ${approved.repository} --head ${approved.branch}\`.`);
    record('pull_request.created', url, { repository: approved.repository, head: approved.head, base: approved.base });
    return { status: 'created', plan: approved, url, approvals: outcome.records };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** The pull request URL gh printed, only when it names a pull request in `repository` ([HOST/]OWNER/REPO). */
export function pullRequestUrl(stdout: string, repository: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  const [host, owner, repo] = repository.split('/');
  try {
    const parsed = new URL(line);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(parsed.pathname);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !match || !host || !owner || !repo) return undefined;
    return sameRepository(`${parsed.hostname}/${match[1]}/${match[2]}`, `${host}/${owner}/${repo}`) ? `https://${parsed.host}/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
  } catch { return undefined; }
}
