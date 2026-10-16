import { spawnSync } from 'node:child_process';
import { resolveExecutable } from '@code-conductor/core/processes';

export interface GitHubCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the official GitHub CLI; authentication stays with `gh auth`. */
export type GhRunner = (cwd: string, args: string[]) => GitHubCommandResult;

// gh is resolved from absolute PATH entries only, so a `gh` in the working directory
// (on Windows, a bare name is looked up there first) never runs with the person's token.
export const gh: GhRunner = (cwd, args) => {
  const executable = resolveExecutable('gh');
  if (!executable.path) return { ok: false, status: null, stdout: '', stderr: executable.problem ?? 'gh not found' };
  const result = spawnSync(executable.path, args, { cwd, encoding: 'utf8', shell: false, timeout: 60_000, windowsHide: true });
  const stderr = [result.stderr || '', result.error?.message || ''].filter(Boolean).join('\n');
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr };
};

export function githubAuthStatus(cwd: string, run: GhRunner = gh): GitHubCommandResult {
  return run(cwd, ['auth', 'status']);
}

// Mutations (push, pull request creation) are not exported here: they go through the
// approval-gated openDraftPullRequest in @code-conductor/runtime.

const PR_FIELDS = 'number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,reviews';

export function pullRequestStatus(cwd: string, selector?: string, run: GhRunner = gh): GitHubCommandResult {
  // After --, a selector that starts with a dash is a selector, never a gh option.
  return run(cwd, ['pr', 'view', '--json', PR_FIELDS, ...(selector ? ['--', selector] : [])]);
}

export interface CheckSummary { name: string; state: 'passed' | 'failed' | 'pending'; url?: string }
export interface ReviewSummary { author: string; state: string; commit?: string; stale: boolean | 'unknown' }
export interface PullRequestSummary {
  number: number; url: string; state: string; draft: boolean;
  head: string; headSha: string; base: string;
  mergeState: string; reviewDecision: string;
  checks: { passed: number; failed: CheckSummary[]; pending: CheckSummary[]; total: number };
  reviews: ReviewSummary[];
  /** Every native signal that is green; merging itself remains a person's decision in GitHub. */
  ready: boolean;
  blockers: string[];
}

type Json = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function check(item: Json): CheckSummary {
  if (item.__typename === 'StatusContext' || 'context' in item) {
    const state = text(item.state).toUpperCase();
    return { name: text(item.context) || 'status', state: state === 'SUCCESS' ? 'passed' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failed', ...(text(item.targetUrl) ? { url: text(item.targetUrl) } : {}) };
  }
  const status = text(item.status).toUpperCase();
  const conclusion = text(item.conclusion).toUpperCase();
  const state = status && status !== 'COMPLETED' ? 'pending' : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) ? 'passed' : conclusion ? 'failed' : 'pending';
  const name = [text(item.workflowName), text(item.name)].filter(Boolean).join(' / ') || 'check';
  return { name, state, ...(text(item.detailsUrl) ? { url: text(item.detailsUrl) } : {}) };
}

/** Interpret `gh pr view --json` output. Unknown fields are ignored; missing data is never treated as passing. */
export function summarizePullRequest(value: unknown): PullRequestSummary {
  const pr = (value && typeof value === 'object' ? value : {}) as Json;
  const headSha = text(pr.headRefOid);
  const checks = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).filter((item): item is Json => Boolean(item) && typeof item === 'object').map(check);
  const reviews = (Array.isArray(pr.reviews) ? pr.reviews : []).filter((item): item is Json => Boolean(item) && typeof item === 'object').map((item): ReviewSummary => {
    const commit = text((item.commit as Json | undefined)?.oid);
    return { author: text((item.author as Json | undefined)?.login) || 'unknown', state: text(item.state), ...(commit ? { commit } : {}), stale: commit ? commit !== headSha : 'unknown' };
  });
  const failed = checks.filter((item) => item.state === 'failed');
  const pending = checks.filter((item) => item.state === 'pending');
  const summary: PullRequestSummary = {
    number: typeof pr.number === 'number' ? pr.number : 0, url: text(pr.url), state: text(pr.state), draft: pr.isDraft !== false,
    head: text(pr.headRefName), headSha, base: text(pr.baseRefName), mergeState: text(pr.mergeStateStatus) || 'UNKNOWN', reviewDecision: text(pr.reviewDecision) || 'NONE',
    checks: { passed: checks.length - failed.length - pending.length, failed, pending, total: checks.length }, reviews, ready: false, blockers: [],
  };
  if (summary.state !== 'OPEN') summary.blockers.push(`Pull request is ${summary.state || 'in an unknown state'}.`);
  if (summary.draft) summary.blockers.push(pr.isDraft === true ? 'Pull request is a draft.' : 'Draft state is not reported.');
  if (!checks.length) summary.blockers.push('No checks reported for the head commit.');
  if (failed.length) summary.blockers.push(`${failed.length} check(s) failed: ${failed.map((item) => item.name).join(', ')}.`);
  if (pending.length) summary.blockers.push(`${pending.length} check(s) pending: ${pending.map((item) => item.name).join(', ')}.`);
  if (summary.reviewDecision !== 'APPROVED') summary.blockers.push(`Review decision is ${summary.reviewDecision}.`);
  if (reviews.some((review) => review.state === 'APPROVED' && review.stale === true)) summary.blockers.push('An approval was given on an earlier commit; re-review the current head.');
  // UNSTABLE is "mergeable with non-passing commit status", which a check list can miss.
  if (!['CLEAN', 'HAS_HOOKS'].includes(summary.mergeState)) summary.blockers.push(`Merge state is ${summary.mergeState}.`);
  summary.ready = summary.blockers.length === 0;
  return summary;
}
