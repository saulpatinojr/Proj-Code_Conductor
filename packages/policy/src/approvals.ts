import { createHash } from 'node:crypto';
import type { ApprovalAction, ApprovalRecord, ApprovalRequest, ApprovalStatus } from '@code-conductor/schemas';

/** A human decision for one batch of requests shown together. */
export interface ApprovalDecision { approved: boolean; approver: string }

/**
 * Presents requests to a person immediately before the actions they describe.
 * Return undefined when no person can be asked (for example a non-interactive
 * process); the gate then records the requests as missing and refuses them.
 */
export interface Approver { decide(requests: readonly ApprovalRequest[]): Promise<ApprovalDecision | undefined> }

export interface ApprovalOutcome { approved: boolean; records: ApprovalRecord[] }
export interface ApprovalGateOptions { approver?: Approver; ttlMs?: number; now?: () => number }

/** A decision older than this, measured from when the request was built, is stale. */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const actions = new Set<ApprovalAction>(['local_execution', 'context_disclosure', 'commit', 'deployment']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertRequest(request: ApprovalRequest): void {
  const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  if (!actions.has(request.action)) throw new Error(`Unsupported approval action: ${String(request.action)}`);
  if (!text(request.runId) || !text(request.taskId) || !text(request.repository) || !text(request.revision)) {
    throw new Error(`Approval request for ${request.action} must bind run, task, repository and revision.`);
  }
  if ((request.action === 'context_disclosure' || request.action === 'deployment') && !text(request.recipient)) {
    throw new Error(`Approval request for ${request.action} must name its recipient.`);
  }
  const bindings = Object.entries(request.bindings ?? {});
  if (!bindings.length || bindings.some(([key, value]) => !key || !text(value))) {
    throw new Error(`Approval request for ${request.action} must bind at least one non-empty action-specific value.`);
  }
}

/** Digest over every bound field. The human-readable summary is deliberately excluded. */
export function approvalDigest(request: ApprovalRequest): string {
  const { summary: _summary, ...bound } = request;
  return createHash('sha256').update(canonical(bound)).digest('hex');
}

/**
 * Pre-action authorization. Each authorize() call is single-use: it builds the
 * requests, asks the approver, then rebuilds them and requires identical digests
 * before reporting approval, so a change between review and action (a new
 * revision, a different diff, prompt or recipient) invalidates the decision.
 * Missing approvers, denials and decisions older than the TTL are refused.
 * Records are non-secret evidence; nothing reads them back as authority.
 */
export class ApprovalGate {
  readonly records: ApprovalRecord[] = [];
  readonly #approver: Approver | undefined;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: ApprovalGateOptions = {}) {
    this.#approver = options.approver;
    this.#ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error('Approval TTL must be a positive integer number of milliseconds.');
  }

  async authorize(build: () => ApprovalRequest[] | Promise<ApprovalRequest[]>): Promise<ApprovalOutcome> {
    const requests = await build();
    if (!requests.length) throw new Error('An approval batch must contain at least one request.');
    for (const request of requests) assertRequest(request);
    const requestedAt = this.#now();
    const digests = requests.map(approvalDigest);
    const decision = this.#approver ? await this.#approver.decide(requests) : undefined;
    const decidedAt = this.#now();
    let status: ApprovalStatus;
    if (!decision) status = 'missing';
    else if (!decision.approved) status = 'denied';
    else if (decidedAt - requestedAt > this.#ttlMs) status = 'expired';
    else {
      const current = await build();
      const unchanged = current.length === digests.length && current.every((request, index) => {
        assertRequest(request);
        return approvalDigest(request) === digests[index];
      });
      status = unchanged ? 'approved' : 'changed';
    }
    const records = requests.map((request, index): ApprovalRecord => ({
      requestDigest: digests[index]!,
      action: request.action,
      runId: request.runId,
      taskId: request.taskId,
      ...(request.assignmentId ? { assignmentId: request.assignmentId } : {}),
      ...(request.recipient ? { recipient: request.recipient } : {}),
      revision: request.revision,
      status,
      approver: decision?.approver ?? 'none',
      requestedAt: new Date(requestedAt).toISOString(),
      ...(decision ? { decidedAt: new Date(decidedAt).toISOString() } : {}),
      ...(status === 'approved' ? { expiresAt: new Date(requestedAt + this.#ttlMs).toISOString() } : {}),
      summary: request.summary,
    }));
    this.records.push(...records);
    return { approved: status === 'approved', records };
  }
}

export function approvalBlocker(records: readonly ApprovalRecord[]): string {
  const record = records[0];
  if (!record) return 'Pre-action approval was not obtained.';
  const subject = `${record.action}${record.recipient ? ` to ${record.recipient}` : ''}`;
  switch (record.status) {
    case 'missing': return `Pre-action approval required for ${subject}; no interactive approver was available, so the action was not performed.`;
    case 'denied': return `Pre-action approval for ${subject} was denied; the action was not performed.`;
    case 'expired': return `Pre-action approval for ${subject} expired before it was given; the action was not performed.`;
    case 'changed': return `The ${subject} context changed after approval was requested; the stale approval was rejected and the action was not performed.`;
    default: return `Pre-action approval for ${subject} was not obtained.`;
  }
}
