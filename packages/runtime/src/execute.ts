import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAssignment, AgentResult, ApprovalRecord, ApprovalRequest, HandoffPacket, MergeDecision, RunManifest, TaskEnvelope } from '@code-conductor/schemas';
import { buildHandoffPacket, describeHandoff, handoffExpired, renderHandoff, validHandoffTtl } from './handoff.js';
import type { ClientAuthStatus, HarnessAdapter, HarnessExecutionRequest } from '@code-conductor/adapters';
import { configurationInsideRepository, createBuiltinAdapters } from '@code-conductor/adapters';
import { RunStore } from '@code-conductor/evidence';
import { blockingGateFailure, detectGateProfiles, executeGatePlan, planGates, type CommandExecutor, type GateExecution, type PlannedGate } from '@code-conductor/gates';
import { assertAgentWorktree, assertSafeChangedPaths, commitAgentChanges, commitsSince, gitControlState, headTree, isAncestor, isSensitiveRepositoryPath, MAX_SCAN_BYTES, newGitlinks, removeCleanAgentWorktree, scanForNewSecrets, scanHistoryForNewSecrets, treeChangedFiles, workingTreeState, WorktreeManager, type WorktreeHandle } from '@code-conductor/git';
import { ApprovalGate, approvalBlocker, type Approver } from '@code-conductor/policy';
import { externalAwaitingResult, parseAgentResult } from './result.js';
import { planTask, type TaskPlan } from './planner.js';
import { CLIENT_BILLS_SEPARATELY, CLIENT_NOT_SIGNED_IN, GIT_CONTROL_CHANGED } from './next-actions.js';
import { shortList, summarizeFiles } from './change-summary.js';

export interface ExecuteOptions {
  execute?: boolean;
  adapters?: Map<string, HarnessAdapter>;
  store?: RunStore;
  worktrees?: WorktreeManager;
  gateExecutor?: CommandExecutor;
  timeoutMs?: number;
  keepWorktrees?: boolean;
  /** Workstation trust for this harness, mode and surface, bound to the installed client version when given. */
  isHarnessTrusted?: (harness: string, mode: 'read' | 'modify', surface?: string, clientVersion?: string) => boolean;
  /**
   * Asked immediately before each consequential action: starting a provider
   * process, disclosing context to it, running gate commands and committing.
   * Without one, every such action fails closed. Workstation trust is not approval.
   */
  approver?: Approver;
  /** Gate profiles a person chose for this run; otherwise profiles are detected. */
  gateProfiles?: string[];
  approvalTtlMs?: number;
  /** How long a handoff packet stays valid (default 24 hours). */
  handoffTtlMs?: number;
  now?: () => number;
}
export interface ExecuteOutcome { plan: TaskPlan; manifest: RunManifest; manifestPath: string; pendingExternal: AgentAssignment[]; worktrees: WorktreeHandle[] }

/** The exact prompt an assignment receives; also used for a person-driven manual handoff. */
export function assignmentPrompt(task: TaskEnvelope, assignment: AgentAssignment, handoff?: { packet: HandoffPacket; sha256?: string }): string {
  return [
    `Code Conductor task ${task.id}.`, `Objective: ${task.objective}`, `Role: ${assignment.role}. Stance: ${assignment.stance}.`,
    `Harness: ${assignment.harness}. Surface: ${assignment.surface ?? 'unspecified'}.`,
    `Authority: ${assignment.authority.join(', ') || 'observe'}.`,
    `Acceptance criteria: ${task.acceptanceCriteria.length ? task.acceptanceCriteria.join(' | ') : 'Use repository task definition and policy.'}`,
    `Specializations: ${task.specializations?.length ? task.specializations.join(', ') : 'Use approved routing/configuration.'}`,
    'Read AGENTS.md and applicable repository instructions before acting.',
    'Do not reveal private chain-of-thought. Return conclusions, evidence, changes, tests, findings, risks, blockers, and recommendation only.',
    ...(handoff ? [renderHandoff(handoff.packet, handoff.sha256)] : []),
    'Your FINAL line MUST be CC_RESULT_JSON:<single-line JSON object> matching AgentResult fields that you control: status, changes, tests, evidence, findings, risks, blockers, recommendation, and optionally notVerified (a list of checks you did not perform or could not verify).',
  ].join('\n');
}

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

// Location and kind only, never the matched value.
function describeSecrets(secrets: ReadonlyArray<{ path: string; line: number; kind: string }>): string {
  return `${secrets.slice(0, 10).map((item) => `${item.path}:${item.line} ${item.kind}`).join('; ')}${secrets.length > 10 ? `; and ${secrets.length - 10} more` : ''}`;
}
// Content Code Conductor did not scan is never committed by it.
function describeUnscanned(files: readonly string[]): string {
  return `${files.length} file(s) past the ${MAX_SCAN_BYTES / (1024 * 1024)} MiB credential-scan budget were not scanned: ${files.slice(0, 10).join(', ')}${files.length > 10 ? `, … (${files.length - 10} more)` : ''}`;
}

function mergeDecision(task: TaskEnvelope, results: AgentResult[], gates: GateExecution[], approvals: readonly ApprovalRecord[]): MergeDecision {
  const evidenceIds = [...new Set([...results.flatMap((r) => r.evidence.map((e) => e.id)), ...gates.flatMap((g) => g.result.evidenceIds)])];
  if (results.some((r) => r.status === 'awaiting_external')) return { decision: 'human_required', rationale: 'One or more assignments require an external/manual platform step.', evidenceIds };
  if (approvals.some((record) => record.status !== 'approved')) return { decision: 'human_required', rationale: 'A required pre-action approval was missing, denied, expired or invalidated by a context change; those actions were not performed.', evidenceIds };
  if (results.some((r) => r.recommendation === 'human_required')) return { decision: 'human_required', rationale: 'An assignment needs a person to review it before merge, for example commits the agent made itself, which Code Conductor did not approve, or Git configuration changed during the run.', evidenceIds };
  if (results.some((r) => r.status === 'failed' || r.status === 'blocked')) return { decision: 'changes_required', rationale: 'One or more agent assignments failed or are blocked.', evidenceIds };
  if (blockingGateFailure(gates)) return { decision: 'changes_required', rationale: 'A blocking deterministic gate failed.', evidenceIds };
  if (results.some((r) => r.findings.some((f) => f.blocking))) return { decision: 'blocked', rationale: 'An unresolved blocking finding remains.', evidenceIds };
  if (task.risk === 'R3' || task.risk === 'R4') return { decision: 'human_required', rationale: `${task.risk} policy requires explicit human approval.`, evidenceIds };
  return { decision: 'ready', rationale: 'Required assignments completed and blocking deterministic gates passed.', evidenceIds };
}

export async function executeTask(root: string, task: TaskEnvelope, options: ExecuteOptions = {}): Promise<ExecuteOutcome> {
  const adapters = options.adapters ?? createBuiltinAdapters();
  const store = options.store ?? new RunStore();
  const worktrees = options.worktrees ?? new WorktreeManager();
  const available = new Set([...adapters.entries()].filter(([, adapter]) => adapter.available()).map(([id]) => id));
  const plan = planTask(root, task, { availableHarnesses: available.size ? available : undefined });
  const manifest: RunManifest = { runId: plan.runId, task, assignments: plan.assignments, results: [], gates: [] };
  if (options.handoffTtlMs !== undefined && !validHandoffTtl(options.handoffTtlMs)) throw new Error('Handoff TTL must be a positive number of milliseconds, at most 7 days.');
  const clock = options.now ?? Date.now;
  const approvals = new ApprovalGate({ ...(options.approver ? { approver: options.approver } : {}), ...(options.approvalTtlMs !== undefined ? { ttlMs: options.approvalTtlMs } : {}), ...(options.now ? { now: options.now } : {}) });
  // Every consequential action goes through here. A request that cannot even be
  // built (for example Git failing to report the working tree) fails closed.
  const authorize = async (build: () => ApprovalRequest[]): Promise<{ approved: boolean; blocker: string }> => {
    try {
      const outcome = await approvals.authorize(build);
      manifest.approvals = [...approvals.records];
      for (const record of outcome.records) store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'approval.decided', ...(record.assignmentId ? { assignmentId: record.assignmentId } : {}), message: `${record.action}: ${record.status}`, data: { requestDigest: record.requestDigest, approver: record.approver } });
      return { approved: outcome.approved, blocker: approvalBlocker(outcome.records) };
    } catch (error) {
      return { approved: false, blocker: `Pre-action approval could not be established (${error instanceof Error ? error.message : String(error)}); the action was not performed.` };
    }
  };
  const blockedResult = (assignment: AgentAssignment, blocker: string): AgentResult => ({ ...externalAwaitingResult(assignment, blocker), status: 'blocked', recommendation: 'human_required' });
  // Versioned handoff from the completed work an assignment depends on: explicit
  // recipient, expiry, prior findings, unresolved disagreements and provenance. Only
  // called after the Git-control check for `cwd` passed, because its provenance hashes
  // the working tree with `git add`, which runs filters the configuration defines.
  const prepareHandoff = (assignment: AgentAssignment, cwd: string): { handoff?: { packet: HandoffPacket; sha256: string }; blocker?: string } => {
    if (!assignment.dependsOn.length) return {};
    try {
      const state = workingTreeState(cwd);
      const packet = buildHandoffPacket(manifest, assignment, { repository: cwd, revision: state.revision, tree: state.tree }, { ...(options.handoffTtlMs !== undefined ? { ttlMs: options.handoffTtlMs } : {}), now: clock() });
      if (!packet) return {};
      const digest = store.saveHandoff(packet);
      manifest.handoffs = [...(manifest.handoffs ?? []), { id: packet.id, to: assignment.id, sha256: digest, expiresAt: packet.expiresAt }];
      return { handoff: { packet, sha256: digest } };
    } catch (error) {
      return { blocker: `The handoff packet for ${assignment.id} could not be prepared (${error instanceof Error ? error.message : String(error)}).` };
    }
  };
  const pendingExternal: AgentAssignment[] = [];
  const createdWorktrees: WorktreeHandle[] = [];
  const executedGates: GateExecution[] = [];
  let primaryBuilderWorktree: WorktreeHandle | undefined;
  // Git configuration defines programs Code Conductor's own `git add` runs (clean and
  // process filters), and grafts or a shallow file change which history it sees. A
  // provider that changed them could get its programs run outside its own sandbox. Each
  // directory's state is read once per run and every later check compares against that
  // first reading, so a change between assignments is caught too. Once anything changed
  // (or cannot be read), nothing that would run Git under it happens for the rest of the run.
  let stopped: string | undefined;
  const sharedBaselines = new Map<string, string>();
  const worktreeBaselines = new Map<string, string>();
  const controlChange = (cwd: string, when: string): string | undefined => {
    let changed: string | undefined;
    try {
      const current = gitControlState(cwd);
      if (!current) return undefined;
      // Shared state is keyed by repository, so a new agent worktree is compared with what
      // earlier assignments saw; worktree-scope configuration is keyed by worktree.
      for (const [baselines, key, digest] of [[sharedBaselines, current.commonDir, current.shared], [worktreeBaselines, resolve(cwd), current.worktree]] as const) {
        const baseline = baselines.get(key);
        if (baseline === undefined) baselines.set(key, digest);
        else if (baseline !== digest) changed = 'changed since Code Conductor first read them in this run';
      }
    } catch { changed = 'could not be read'; }
    return changed && `${GIT_CONTROL_CHANGED} (config of any scope, info/attributes, info/grafts, shallow, objects/info/alternates, repositories nested in the work tree) for ${cwd} ${changed} (checked ${when}). Code Conductor ran no further Git operations under configuration it had not seen and stopped the run; check \`git -C ${cwd} config --list --show-origin\`, the repository's .git directory and any repository nested in the work tree before running again. Agent changes are preserved uncommitted.`;
  };
  const save = (): string => store.saveManifest(manifest);
  store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'run.planned', message: `Planned ${plan.assignments.length} assignment(s).` });
  let manifestPath = save();
  if (!options.execute) return { plan, manifest, manifestPath, pendingExternal, worktrees: createdWorktrees };

  try {
    for (const assignment of plan.assignments) {
      if (stopped) {
        manifest.results.push(blockedResult(assignment, stopped));
        save();
        continue;
      }
      const unmet = assignment.dependsOn.filter((id) => !manifest.results.some((result) => result.assignmentId === id && result.status === 'completed'));
      if (unmet.length) {
        const waiting = externalAwaitingResult(assignment, `Dependencies not completed: ${unmet.join(', ')}`);
        manifest.results.push({ ...waiting, status: 'blocked', recommendation: 'changes_required' });
        save();
        continue;
      }

      if (assignment.harness === 'internal-validator') {
        const validationRoot = primaryBuilderWorktree?.path ?? root;
        let gatePlan: PlannedGate[];
        let dropped: string[] = [];
        try {
          gatePlan = planGates(validationRoot, options.gateProfiles);
          // An explicit choice replaces detection; say what that leaves out.
          const chosen = new Set(gatePlan.map((item) => item.profile));
          if (gatePlan.some((item) => item.explicit)) dropped = detectGateProfiles(validationRoot).filter((name) => !chosen.has(name));
        }
        catch (error) {
          manifest.results.push({ ...externalAwaitingResult(assignment, `Gate selection failed: ${error instanceof Error ? error.message : String(error)}`), status: 'failed', recommendation: 'changes_required' });
          save();
          continue;
        }
        stopped = controlChange(validationRoot, 'before running gate commands');
        if (stopped) {
          manifest.results.push(blockedResult(assignment, stopped));
          save();
          continue;
        }
        const runnable = gatePlan.filter((item) => !item.missing.length);
        if (runnable.length) {
          // Gate profiles run the target repository's own scripts, so they are local execution.
          const commands = runnable.map((item) => `${[item.gate.command, ...(item.gate.args ?? [])].join(' ')} [${item.executable ?? item.gate.command}]${item.gate.blocking === false ? ' (advisory)' : ''}`);
          const disclosures = [...new Set(runnable.flatMap((item) => (item.gate.disclosure ? [item.gate.disclosure] : [])))];
          // In an agent worktree, dependencies, .terraform and build output exist only because
          // something in this run created them, possibly the agent; they are ignored by Git.
          const skipped = dropped.length ? ` Detected profile(s) not run because you chose others: ${dropped.join(', ')}.` : '';
          const untrusted = validationRoot === primaryBuilderWorktree?.path ? ' Prerequisites such as installed dependencies, .terraform or build output in this agent worktree were created during the run, possibly by the agent, and are not bound by this approval.' : '';
          const approval = await authorize(() => {
            // Built again after the person decides: Git configuration may have changed meanwhile.
            stopped = controlChange(validationRoot, 'while gate commands were being approved');
            if (stopped) throw new Error(stopped);
            const state = workingTreeState(validationRoot);
            return [{
              action: 'local_execution', runId: plan.runId, taskId: task.id, assignmentId: assignment.id, repository: validationRoot, revision: state.revision, recipient: 'local:deterministic-gates',
              bindings: { tree: state.tree, commands: sha256(JSON.stringify(gatePlan.map((item) => [item.profile, item.gate.id, item.gate.command, item.executable ?? null, item.gate.args ?? [], item.timeoutMs, item.missing]))), selection: gatePlan.some((item) => item.explicit) ? 'explicit' : 'detected' },
              summary: `Run ${runnable.length} deterministic gate command(s) from the target repository in ${validationRoot}, with your environment: ${commands.join('; ')}${runnable.length < gatePlan.length ? ` (${gatePlan.length - runnable.length} gate(s) with missing prerequisites will not run and count as blocking failures)` : ''}.${skipped}${disclosures.map((text) => ` ${text}`).join('')}${untrusted}`,
            }];
          });
          if (!approval.approved) {
            manifest.results.push(blockedResult(assignment, stopped ? `${stopped} The gate commands did not run.` : approval.blocker));
            save();
            continue;
          }
        }
        const gateExecutions = await executeGatePlan(validationRoot, gatePlan, options.gateExecutor);
        executedGates.push(...gateExecutions);
        manifest.gates.push(...gateExecutions.map((item) => item.result));
        const failed = blockingGateFailure(gateExecutions);
        // Gate commands run the repository's own scripts, which can change Git configuration too.
        stopped = controlChange(validationRoot, 'after running gate commands');
        manifest.results.push({
          taskId: task.id, assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, stance: assignment.stance,
          provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}), billingChannel: 'local', status: stopped ? 'blocked' : failed ? 'failed' : 'completed', changes: [],
          tests: gateExecutions.map((item) => item.result), evidence: gateExecutions.map((item) => item.evidence), findings: [], risks: [],
          blockers: [...(failed ? ['Blocking deterministic gate failed.'] : []), ...(stopped ? [stopped] : [])], recommendation: stopped ? 'human_required' : failed ? 'changes_required' : 'continue',
        });
        store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'validation.completed', assignmentId: assignment.id, message: failed ? 'failed' : 'completed' });
        save();
        continue;
      }

      const adapter = adapters.get(assignment.harness);
      if (!adapter || !adapter.available()) {
        // A person completes it with `ccon handoff`, which prints the same packet.
        const manualCwd = primaryBuilderWorktree?.path ?? root;
        stopped = assignment.dependsOn.length ? controlChange(manualCwd, 'before preparing a manual handoff') : undefined;
        if (stopped) { manifest.results.push(blockedResult(assignment, stopped)); save(); continue; }
        const prepared = prepareHandoff(assignment, manualCwd);
        const result = externalAwaitingResult(assignment, `Harness ${assignment.harness} surface ${assignment.surface ?? 'unknown'} requires manual/platform integration or is unavailable on this workstation.${prepared.blocker ? ` ${prepared.blocker}` : ''}`);
        manifest.results.push(result); pendingExternal.push(assignment); save(); continue;
      }

      if (assignment.surface && adapter.executionSurface !== assignment.surface) {
        manifest.results.push({ ...externalAwaitingResult(assignment, `Harness ${assignment.harness} is configured for ${assignment.surface}, but the installed adapter exposes ${adapter.executionSurface}.`), status: 'blocked', recommendation: 'changes_required' });
        save();
        continue;
      }

      const trustMode = assignment.authority.includes('modify_worktree') ? 'modify' : 'read';
      const clientVersion = adapter.version();
      if (!options.isHarnessTrusted?.(assignment.harness, trustMode, assignment.surface ?? adapter.executionSurface, clientVersion)) {
        manifest.results.push({ ...externalAwaitingResult(assignment, `Harness ${assignment.harness} surface ${assignment.surface ?? adapter.executionSurface} has not passed Code Conductor workstation ${trustMode} smoke validation${clientVersion ? ` for its installed version (${clientVersion})` : ''}.`), status: 'blocked', recommendation: 'changes_required' });
        save(); continue;
      }
      // A client whose user configuration lives in the repository would take the
      // repository's hooks, env block and credential helper as "user" settings, which the
      // sign-in probe cannot see.
      const inside = configurationInsideRepository(assignment.harness, root);
      if (inside.length) {
        manifest.results.push({ ...externalAwaitingResult(assignment, `Harness ${assignment.harness} would read its user configuration from inside the repository: ${inside.join(', ')}. The repository could then supply the client's settings (hooks, environment, credential helper) after the sign-in check. Point it outside the repository. The provider was not started.`), status: 'blocked', recommendation: 'changes_required' });
        save(); continue;
      }
      // Installed and trusted is not signed in: ask the official client, before any
      // worktree or approval, and never start a provider that is not signed in or would
      // bill an assignment meant for a subscription separately.
      const signInProblem = adapter.authStatus ? await (async () => {
        let auth: ClientAuthStatus;
        try { auth = await adapter.authStatus!(); } catch { auth = { state: 'unknown', billing: 'unknown', command: [adapter.command ?? assignment.harness] }; }
        const command = `\`${auth.command.join(' ')}\``;
        if (auth.state !== 'authenticated') return `Harness ${assignment.harness} ${CLIENT_NOT_SIGNED_IN}: ${command} ${auth.state === 'unauthenticated' ? 'reports that it is not signed in' : 'did not report a sign-in state Code Conductor recognises'}. Sign in with the official client (\`ccon doctor\` shows how), then run the task again. The provider was not started.`;
        if (assignment.billingChannel === 'subscription' && auth.billing !== 'subscription') return `Harness ${assignment.harness} ${auth.billing === 'separately_billed' ? 'would use' : 'may use'} ${CLIENT_BILLS_SEPARATELY} (${auth.method ?? 'unrecognised method'}, from ${command}) for an assignment billed to the subscription (subscription_first). Sign in with your subscription in the official client, or remove that credential from the client's own configuration. The provider was not started.`;
        return undefined;
      })() : undefined;
      if (signInProblem) {
        manifest.results.push({ ...externalAwaitingResult(assignment, signInProblem), status: 'blocked', recommendation: 'changes_required' });
        save(); continue;
      }

      let cwd = root;
      let assignmentWorktree: WorktreeHandle | undefined;
      if (assignment.authority.includes('modify_worktree')) {
        // `git worktree add` checks files out, which runs smudge filters.
        stopped = controlChange(root, 'before creating an agent worktree');
        if (stopped) { manifest.results.push(blockedResult(assignment, `${stopped} The provider was not started.`)); save(); continue; }
        assignmentWorktree = worktrees.create(root, task.id, assignment.agentId);
        createdWorktrees.push(assignmentWorktree); cwd = assignmentWorktree.path;
        manifest.worktrees = [...(manifest.worktrees ?? []), { assignmentId: assignment.id, path: assignmentWorktree.path, branch: assignmentWorktree.branch, baseSha: assignmentWorktree.baseSha }];
      } else if (primaryBuilderWorktree) cwd = primaryBuilderWorktree.path;

      const surface = assignment.surface ?? adapter.executionSurface;
      const recipient = `${assignment.provider}/${assignment.harness}@${surface}`;
      stopped = controlChange(cwd, `before starting ${recipient}`);
      const prepared = stopped ? {} : prepareHandoff(assignment, cwd);
      const handoff = prepared.handoff;
      const request: HarnessExecutionRequest = { task, assignment, cwd, timeoutMs: options.timeoutMs ?? 1800000, prompt: assignmentPrompt(task, assignment, handoff) };
      // Starting the client and disclosing the prompt plus repository access are
      // approved together but recorded separately, each bound to this recipient.
      // Every start, including a retry, is a new process and a new disclosure, so
      // each attempt needs its own approval of the then-current working tree.
      const promptBytes = Buffer.byteLength(request.prompt, 'utf8');
      const invocation = adapter.invocation?.(request) ?? { command: adapter.command ?? 'platform', args: [] };
      // The prompt is bound by digest; redact it wherever an adapter embeds it.
      const argv = [invocation.command, ...invocation.args.map((arg) => (request.prompt && arg.includes(request.prompt) ? arg.replaceAll(request.prompt, '<prompt>') : arg))];
      const authorizeStart = (attempt: number) => authorize((): ApprovalRequest[] => {
        // Also checked when the request is rebuilt after the decision: a packet that expired
        // while the person was deciding is never disclosed.
        if (handoff && handoffExpired(handoff.packet, clock())) throw new Error(`handoff packet ${handoff.packet.id} expired at ${handoff.packet.expiresAt}`);
        // Git configuration may have changed while the person was deciding; hashing the tree
        // under changed configuration would run its filters.
        stopped = controlChange(cwd, `while ${recipient}'s start was being approved`);
        if (stopped) throw new Error(stopped);
        const state = workingTreeState(cwd);
        const bound = { runId: plan.runId, taskId: task.id, assignmentId: assignment.id, repository: cwd, revision: state.revision, recipient };
        const prefix = attempt ? `Retry attempt ${attempt + 1}: ` : '';
        return [
          { ...bound, action: 'local_execution', bindings: { attempt: String(attempt + 1), tree: state.tree, argv: sha256(JSON.stringify(argv)), surface, authority: assignment.authority.join(','), billingChannel: assignment.billingChannel }, summary: `${prefix}Start \`${argv.join(' ')}\` (${surface}, ${assignment.billingChannel}) as ${assignment.role} with authority ${assignment.authority.join(', ')} in ${cwd}.` },
          { ...bound, action: 'context_disclosure', bindings: { attempt: String(attempt + 1), tree: state.tree, prompt: sha256(request.prompt), promptBytes: String(promptBytes) }, summary: `${prefix}Disclose the ${promptBytes}-byte task prompt${handoff ? `, including ${describeHandoff(handoff.packet, handoff.sha256)},` : ''} to ${recipient}, running in ${cwd} at ${state.revision.slice(0, 12)}. What else it can read is set by that client's own sandbox and permissions, not by Code Conductor.` },
        ];
      });
      const approval = stopped ? { approved: false, blocker: `${stopped} The provider was not started.` }
        : prepared.blocker ? { approved: false, blocker: `${prepared.blocker} The provider was not started.` }
          : await authorizeStart(0);
      if (!approval.approved) {
        // A configuration change found while the approval was rebuilt is recorded as such, so
        // `ccon next` and `ccon worktrees` run no Git for this run either.
        let blocker = stopped && !approval.blocker.includes(GIT_CONTROL_CHANGED) ? `${stopped} The provider was not started.` : approval.blocker;
        if (assignmentWorktree) {
          // Nothing ran in the fresh worktree; remove it and its branch rather than leave them
          // behind, unless Git configuration changed: removal would run Git under it.
          const unused = assignmentWorktree;
          if (stopped) blocker += ` The unused worktree ${unused.path} and its branch ${unused.branch} were kept, because removing them would run Git under the changed configuration; remove them after checking it.`;
          else {
            try { worktrees.remove(unused, true, false); }
            catch (error) { blocker += ` Cleanup of the unused worktree/branch ${unused.branch} was incomplete: ${error instanceof Error ? error.message : String(error)}`; }
          }
          if (!existsSync(unused.path)) {
            createdWorktrees.splice(createdWorktrees.indexOf(unused), 1);
            manifest.worktrees = (manifest.worktrees ?? []).filter((record) => record.path !== unused.path);
          }
        }
        manifest.results.push(blockedResult(assignment, blocker));
        save();
        continue;
      }
      if (assignmentWorktree) primaryBuilderWorktree ??= assignmentWorktree;
      const controlChanged = (): string | undefined => controlChange(cwd, `after ${recipient} was started`);
      let result: AgentResult | undefined;
      let lastFailure: AgentResult | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
        if (attempt > 0) {
          stopped = controlChanged();
          if (stopped) { result = lastFailure; break; }
          const retry = await authorizeStart(attempt);
          if (!retry.approved) {
            result = lastFailure ?? { taskId: task.id, assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, stance: assignment.stance, provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}), billingChannel: assignment.billingChannel, status: 'failed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [lastError instanceof Error ? lastError.message : 'Harness execution failed.'], recommendation: 'changes_required' };
            result.blockers = [...result.blockers, `${retry.blocker} The automatic retry was not started.`];
            break;
          }
        }
        try {
          const outcome = await adapter.execute(request);
          const parsed = parseAgentResult(assignment, outcome);
          if (outcome.timedOut) {
            parsed.status = 'failed';
            parsed.recommendation = 'changes_required';
            parsed.blockers = [...new Set([...parsed.blockers, `Harness ${assignment.harness} surface ${assignment.surface ?? adapter.executionSurface} timed out; automatic retry was suppressed to avoid repeating potentially paid or side-effecting work.`])];
            result = parsed;
            break;
          }
          if (parsed.status !== 'failed' || attempt === 1) result = parsed;
          else lastFailure = parsed;
        } catch (error) { lastError = error; }
      }
      result ??= { taskId: task.id, assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, stance: assignment.stance, provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}), billingChannel: assignment.billingChannel, status: 'failed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [lastError instanceof Error ? lastError.message : 'Harness execution failed after bounded retry.'], recommendation: 'changes_required' };
      stopped ??= controlChanged();
      if (stopped) {
        result.status = 'blocked';
        result.recommendation = 'human_required';
        result.blockers = [...result.blockers, stopped];
      }

      if (assignmentWorktree && !stopped) {
        const handle = assignmentWorktree;
        try {
          // Commits the agent made itself, whatever its result, happened under its own
          // sandbox rather than through a Code Conductor approval. Name them, check every
          // path they ever touched (a secret committed and then deleted is still in
          // history), and leave the merge decision to a person.
          const history = commitsSince(handle.path, handle.baseSha);
          let ownCommits = '';
          if (history.commits.length) {
            ownCommits = ` The branch already carries ${history.commits.length} commit(s) the agent made itself (${shortList(history.commits)}), which this approval does not cover; the file list is the net change since base.`;
            result.recommendation = 'human_required';
            result.risks = [...result.risks, `The agent made ${history.commits.length} commit(s) itself on ${handle.branch} (${shortList(history.commits)}) that Code Conductor did not approve; review them before merging.`];
            result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${history.commits[0]}`, summary: `Agent-authored commits on ${handle.branch} since ${handle.baseSha.slice(0, 12)}: ${shortList(history.commits)}. Paths touched: ${history.files.join(', ')}` });
            const sensitive = history.files.filter(isSensitiveRepositoryPath);
            if (sensitive.length) throw new Error(`The agent's own commits on ${handle.branch} touch sensitive repository paths: ${sensitive.join(', ')}. Even if later removed, their content stays in history. Code Conductor committed nothing; review the branch before using it.`);
            // Every file version the commits introduced is scanned, so a credential added and
            // removed again is still found; history past the scan budget fails closed.
            const scan = scanHistoryForNewSecrets(handle.path, handle.baseSha);
            if (scan.findings.length) throw new Error(`The agent's own commits on ${handle.branch} add credential-looking strings (${describeSecrets(scan.findings)}). Even if later removed, their content stays in history. Code Conductor committed nothing; review the branch before using it.`);
            if (scan.unscanned.length) throw new Error(`The agent's own commits on ${handle.branch} could not be fully scanned for credentials: ${describeUnscanned(scan.unscanned)}. Code Conductor committed nothing; review the branch before using it.`);
          }
          // An agent can also move its branch away from the base (for example reset to an
          // older commit); the net file list then includes undoing the base's own changes.
          if (!isAncestor(handle.path, handle.baseSha)) {
            ownCommits += ` ${handle.branch} no longer descends from its base ${handle.baseSha.slice(0, 12)}, so the file list also undoes changes the base had.`;
            result.recommendation = 'human_required';
            result.risks = [...result.risks, `${handle.branch} no longer descends from its base ${handle.baseSha.slice(0, 12)}; the agent rewrote or reset the branch.`];
          }
          if (result.status === 'completed') {
            let expectedTree: string | undefined;
            let expectedHead: string | undefined;
            let commitAllowed = true;
            // Content-exact comparison (not git status), so an edit hidden from the stat
            // cache still requires an approved commit instead of silently staying out of it.
            const before = workingTreeState(handle.path);
            if (before.tree !== headTree(handle.path)) {
              // Refuse unsafe targets before asking a person to approve a commit that cannot happen.
              assertAgentWorktree(handle);
              const approval = await authorize(() => {
                // Built again after the person decides, so this also covers the wait.
                stopped = controlChanged();
                if (stopped) throw new Error(stopped);
                const state = workingTreeState(handle.path);
                // Shown files, the sensitive-path check and the bound tree come from one snapshot.
                const files = treeChangedFiles(handle.path, handle.baseSha, state.tree);
                assertSafeChangedPaths(files);
                // A nested repository Git did not report as one (for example under paths the
                // agent staged) would be recorded as a gitlink, which Git then enters.
                const links = newGitlinks(handle.path, handle.baseSha, state.tree);
                if (links.length) throw new Error(`the change adds nested Git repositories (${links.join(', ')}), which Code Conductor never commits. Inspect them yourself`);
                const scan = scanForNewSecrets(handle.path, handle.baseSha, state.tree);
                if (scan.findings.length) throw new Error(`possible credentials in changed files (${describeSecrets(scan.findings)}). Remove them, or commit yourself after review if they are not secrets`);
                if (scan.unscanned.length) throw new Error(`${describeUnscanned(scan.unscanned)}. Review them and commit yourself`);
                expectedTree = state.tree;
                expectedHead = state.revision;
                return [{
                  action: 'commit', runId: plan.runId, taskId: task.id, assignmentId: assignment.id, repository: handle.path, revision: state.revision, recipient: `git:${handle.branch}`,
                  bindings: { tree: state.tree, branch: handle.branch, baseSha: handle.baseSha, files: sha256(files.join('\n')) },
                  summary: `Commit on ${handle.branch} (base ${handle.baseSha.slice(0, 12)}).${ownCommits} ${summarizeFiles(files)}. Review the full diff first in native Source Control or with \`git -C ${handle.path} diff ${handle.baseSha}\` and \`git -C ${handle.path} status\`.`,
                }];
              });
              if (!approval.approved) {
                commitAllowed = false;
                result.status = 'blocked';
                result.recommendation = 'human_required';
                result.blockers.push(`${approval.blocker} Changes are preserved uncommitted in ${handle.path} for review in native Source Control.`);
              }
            }
            // Re-check right before Code Conductor's own commit re-hashes the worktree.
            if (commitAllowed) {
              stopped = controlChanged();
              if (stopped) {
                result.recommendation = 'human_required';
                throw new Error(stopped);
              }
            }
            const commit = commitAllowed ? commitAgentChanges(handle, `feat(agent): ${assignment.agentId} for ${task.id}`, { expectedTree: expectedTree ?? before.tree, expectedHead: expectedHead ?? before.revision }) : undefined;
            result.changes = commit?.files ?? [];
            if (commit) {
              result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${commit.sha}`, summary: `${commit.created ? 'Committed' : 'Preserved existing commits for'} ${commit.files.length} changed file(s) on ${handle.branch}: ${commit.files.join(', ')}` });
              store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'worktree.committed', assignmentId: assignment.id, message: `${handle.branch}@${commit.sha}` });
            }
          }
        } catch (error) {
          result.status = 'blocked';
          if (result.recommendation !== 'human_required') result.recommendation = 'changes_required';
          result.blockers.push(error instanceof Error ? error.message : String(error));
        }
      }

      manifest.results.push(result);
      store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'assignment.completed', assignmentId: assignment.id, message: result.status });
      save();
    }

    manifest.mergeDecision = mergeDecision(task, manifest.results, executedGates, approvals.records);
    manifestPath = save();
    store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'run.completed', message: manifest.mergeDecision.decision });
    return { plan, manifest, manifestPath, pendingExternal, worktrees: createdWorktrees };
  } finally {
    // Keep modifying worktrees by default so agent changes and commits cannot be
    // silently discarded. Cleanup is an explicit caller choice and applies the same rule
    // as `ccon worktrees --remove-clean`: only a content-clean worktree on its own agent
    // branch is removed (branches and their commits stay). Removal runs Git in the
    // worktree, so nothing is removed once Git configuration changed. It never hides or
    // changes the run outcome.
    if (options.keepWorktrees === false) {
      const note = (type: 'worktree.removed' | 'worktree.retained', message: string): void => {
        try { store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type, message }); } catch { /* The outcome is still returned to the caller. */ }
      };
      for (const handle of [...createdWorktrees]) {
        const changed = stopped ?? controlChange(handle.path, 'before removing agent worktrees');
        let kept = changed ? 'Git configuration or history files changed during the run; check them before removing it' : undefined;
        if (!kept) {
          try { removeCleanAgentWorktree(handle.path, worktrees.root, handle.branch); }
          catch (error) { kept = error instanceof Error ? error.message : String(error); }
        }
        if (existsSync(handle.path)) { note('worktree.retained', `${handle.path}: ${kept ?? 'still present after removal'}`); continue; }
        createdWorktrees.splice(createdWorktrees.indexOf(handle), 1);
        manifest.worktrees = (manifest.worktrees ?? []).filter((record) => record.path !== handle.path);
        note('worktree.removed', kept ? `${handle.path} was already gone (branch ${handle.branch} kept)` : `${handle.path} (branch ${handle.branch} kept)`);
      }
      try { store.saveManifest(manifest); } catch { /* The outcome is still returned to the caller. */ }
    }
  }
}
