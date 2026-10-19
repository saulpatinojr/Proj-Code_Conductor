import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentAssignment, AgentResult, ApprovalRecord, ApprovalRequest, HandoffPacket, MergeDecision, RunManifest, TaskEnvelope } from '@code-conductor/schemas';
import { buildHandoffPacket, describeHandoff, handoffExpired, renderHandoff, validHandoffTtl } from './handoff.js';
import type { ClientAuthStatus, HarnessAdapter, HarnessExecutionRequest } from '@code-conductor/adapters';
import { configurationInsideRepository, createBuiltinAdapters, processEnding, processSucceeded } from '@code-conductor/adapters';
import { RunStore } from '@code-conductor/evidence';
import { blockingGateFailure, detectGateProfiles, executeGatePlan, planGates, type CommandExecutor, type GateExecution, type PlannedGate } from '@code-conductor/gates';
import { assertAgentWorktree, assertSafeChangedPaths, commitAgentChanges, commitsSince, controlStateChanges, gitControlState, headTree, isAncestor, isSensitiveRepositoryPath, MAX_SCAN_BYTES, newGitlinks, redactSecrets, removeCleanAgentWorktree, scanForNewSecrets, scanHistoryForNewSecrets, treeChangedFiles, workingTreeState, WorktreeManager, worktreeTips, type GitControlState, type WorktreeHandle, type WorktreeTips } from '@code-conductor/git';
import { ApprovalGate, approvalBlocker, type Approver } from '@code-conductor/policy';
import { externalAwaitingResult, parseAgentResult } from './result.js';
import { planTask, roleInstructions, type TaskPlan } from './planner.js';
import { CLIENT_BILLS_SEPARATELY, CLIENT_NOT_SIGNED_IN, GIT_CONTROL_CHANGED } from './next-actions.js';
import { shortList, summarizeFiles } from './change-summary.js';
import { gateOutputRenderer, type ToolOutputMode } from './tool-output.js';

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
  /**
   * How gate output appears in evidence: `bounded` (default, the first 8,000 characters)
   * or the opt-in `summary` (verbatim-line summary). The full output is stored with the
   * run either way, and every record ends with its recovery pointer (#94).
   */
  toolOutput?: ToolOutputMode;
  approvalTtlMs?: number;
  /** How long a handoff packet stays valid (default 24 hours). */
  handoffTtlMs?: number;
  now?: () => number;
}
export interface ExecuteOutcome { plan: TaskPlan; manifest: RunManifest; manifestPath: string; pendingExternal: AgentAssignment[]; worktrees: WorktreeHandle[] }

/**
 * The exact prompt an assignment receives; also used for a person-driven manual handoff.
 * `rules` are the role's configured instructions (`roleInstructions`), rendered after the
 * role line so every client gets the same role text whatever agents it has installed.
 */
export function assignmentPrompt(task: TaskEnvelope, assignment: AgentAssignment, handoff?: { packet: HandoffPacket; sha256?: string }, rules: readonly string[] = []): string {
  return [
    `Code Conductor task ${task.id}.`, `Objective: ${task.objective}`, `Role: ${assignment.role}. Stance: ${assignment.stance}.`,
    ...(rules.length ? ['Role rules:', ...rules.map((rule) => `- ${rule}`)] : []),
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

// The ends of an agent worktree's history, each labelled as a person would look for it: the
// branch, or HEAD with the branch it is on or "detached".
function historyEnds(found: WorktreeTips, branch: string): Map<string, string> {
  const ends = new Map<string, string>();
  if (found.branch) ends.set(found.branch, branch);
  if (found.head && found.head !== found.branch) ends.set(found.head, `HEAD (${found.headRef ? `on ${found.headRef.replace(/^refs\/heads\//, '')}` : 'detached'} at ${found.head.slice(0, 12)})`);
  return ends;
}

// The commits between `from` and each end, the paths they touched, and the ends that carry them.
function historySince(path: string, from: string, ends: ReadonlyMap<string, string>): { commits: string[]; files: string[]; where: string } {
  const histories = [...ends].map(([tip, label]) => ({ label, ...commitsSince(path, from, tip) }));
  return {
    commits: [...new Set(histories.flatMap((item) => item.commits))],
    files: [...new Set(histories.flatMap((item) => item.files))].sort(),
    where: histories.filter((item) => item.commits.length).map((item) => item.label).join(' and '),
  };
}

// Every file version those commits introduced is scanned, so a credential added and removed
// again is still found; history past the scan budget fails closed.
function assertHistoryClean(path: string, from: string, ends: ReadonlyMap<string, string>, subject: (label: string) => string, then: (label: string) => string): void {
  for (const [tip, label] of ends) {
    const scan = scanHistoryForNewSecrets(path, from, tip);
    if (scan.findings.length) throw new Error(`${subject(label)} add credential-looking strings (${describeSecrets(scan.findings)}). Even if later removed, their content stays in history. ${then(label)}`);
    if (scan.unscanned.length) throw new Error(`${subject(label)} could not be fully scanned for credentials: ${describeUnscanned(scan.unscanned)}. ${then(label)}`);
  }
}

/**
 * The run's merge decision, which fails closed: `ready` needs every result completed with
 * a positive recommendation, no unresolved blocking finding, every approval granted and
 * at least one blocking deterministic gate that ran and passed. A reviewer's
 * `changes_required`, a cancelled assignment, a run with no results and a run in which no
 * gate ran were each `ready` before the 2026-10-19 dogfood review found them (#4).
 */
export function mergeDecision(task: TaskEnvelope, results: readonly AgentResult[], gates: readonly GateExecution[], approvals: readonly ApprovalRecord[]): MergeDecision {
  const evidenceIds = [...new Set([...results.flatMap((r) => r.evidence.map((e) => e.id)), ...gates.flatMap((g) => g.result.evidenceIds)])];
  if (!results.length) return { decision: 'human_required', rationale: 'No assignment produced a result, so nothing was built, reviewed or validated.', evidenceIds };
  if (results.some((r) => r.status === 'awaiting_external')) return { decision: 'human_required', rationale: 'One or more assignments require an external/manual platform step.', evidenceIds };
  if (approvals.some((record) => record.status !== 'approved')) return { decision: 'human_required', rationale: 'A required pre-action approval was missing, denied, expired or invalidated by a context change; those actions were not performed.', evidenceIds };
  if (results.some((r) => r.recommendation === 'human_required')) return { decision: 'human_required', rationale: 'An assignment needs a person to review it before merge, for example commits the agent made itself, which Code Conductor did not approve, or Git configuration changed during the run.', evidenceIds };
  if (results.some((r) => r.status === 'failed' || r.status === 'blocked' || r.status === 'cancelled')) return { decision: 'changes_required', rationale: 'One or more agent assignments failed, were blocked or were cancelled.', evidenceIds };
  if (blockingGateFailure(gates)) return { decision: 'changes_required', rationale: 'A blocking deterministic gate failed.', evidenceIds };
  if (results.some((r) => r.findings.some((f) => f.blocking))) return { decision: 'blocked', rationale: 'An unresolved blocking finding remains.', evidenceIds };
  if (results.some((r) => r.recommendation === 'changes_required')) return { decision: 'changes_required', rationale: 'An assignment recommends changes before merge.', evidenceIds };
  if (!gates.some((g) => g.blocking && g.result.status === 'passed')) return { decision: 'changes_required', rationale: 'No blocking deterministic gate ran and passed; readiness requires at least one (AGENTS.md section 5).', evidenceIds };
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
  // Where each agent worktree's history ended once its own commits were checked, and the steps
  // that ran in it afterwards (reviewers and gate commands use the builder's worktree).
  const checked = new Map<string, { handle: WorktreeHandle; assignmentId: string; tips: WorktreeTips }>();
  const laterSteps = new Map<string, string[]>();
  const ranIn = (path: string, step: string): void => { if (checked.has(path)) laterSteps.set(path, [...(laterSteps.get(path) ?? []), step]); };
  const createdWorktrees: WorktreeHandle[] = [];
  const executedGates: GateExecution[] = [];
  let primaryBuilderWorktree: WorktreeHandle | undefined;
  // Git configuration defines programs Code Conductor's own `git add` runs (clean and
  // process filters), and grafts or a shallow file change which history it sees. A
  // provider that changed them could get its programs run outside its own sandbox. Each
  // directory's state is read once per run and every later check compares against that
  // first reading, so a change between assignments is caught too. Git reports configuration
  // as seen from where it runs, so a directory is only ever compared with itself; the
  // directory that first read a repository (its root, in practice) is read again whenever
  // another of its worktrees is checked, so what an earlier assignment changed there is
  // caught before Git runs in a new agent worktree. Once anything changed (or cannot be
  // read), nothing that would run Git under it happens for the rest of the run.
  let stopped: string | undefined;
  const baselines = new Map<string, GitControlState>();
  const firstReaders = new Map<string, string>();
  const controlChange = (cwd: string, when: string): string | undefined => {
    let changed: string | undefined;
    try {
      const directory = resolve(cwd);
      const current = gitControlState(directory);
      const first = baselines.get(directory);
      // Outside Git from the start there is nothing to guard. A directory that stopped being a
      // work tree after its first reading (a rewritten .git file or core.worktree) has changed.
      if (!current && !first) return undefined;
      const commonDir = (current ?? first!).commonDir;
      const reader = firstReaders.get(commonDir) ?? directory;
      firstReaders.set(commonDir, reader);
      const found = new Set<string>();
      const compare = (path: string, state: GitControlState | undefined): void => {
        const baseline = baselines.get(path);
        if (!state) found.add(`${path} is no longer a Git work tree`);
        else if (!baseline) baselines.set(path, state);
        else {
          for (const change of controlStateChanges(baseline, state)) {
            if (path === directory) found.add(change);
            // A shared change is named once. Repositories nested in the reader matter only to
            // Git run there, and a check of the reader itself compares them.
            else if (!found.has(change) && !change.startsWith('nested repository ')) found.add(`${change} (read in ${path})`);
          }
        }
      };
      compare(directory, current);
      if (reader !== directory) compare(reader, gitControlState(reader));
      // Names are paths, some chosen by the agent; a credential-shaped one is not repeated.
      const list = [...found];
      if (list.length) changed = `changed since Code Conductor first read them in this run (checked ${when}): ${redactSecrets(list.slice(0, 5).join('; ')).text}${list.length > 5 ? `; and ${list.length - 5} more` : ''}`;
    } catch { changed = `could not be read (checked ${when})`; }
    return changed && `${GIT_CONTROL_CHANGED} (config of any scope, info/attributes, info/grafts, shallow, objects/info/alternates, repositories nested in the work tree) for ${cwd} ${changed}. Code Conductor ran no further Git operations under configuration it had not seen and stopped the run; check \`git -C ${cwd} config --list --show-origin\`, the repository's .git directory and any repository nested in the work tree before running again. Agent changes are preserved uncommitted.`;
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
          const commands = runnable.map((item) => `${[item.gate.command, ...(item.gate.args ?? [])].join(' ')} [${[item.executable ?? item.gate.command, ...(item.prefixArgs ?? [])].join(' ')}]${item.gate.blocking === false ? ' (advisory)' : ''}`);
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
              bindings: { tree: state.tree, commands: sha256(JSON.stringify(gatePlan.map((item) => [item.profile, item.gate.id, item.gate.command, item.executable ?? null, item.prefixArgs ?? [], item.gate.args ?? [], item.timeoutMs, item.missing]))), selection: gatePlan.some((item) => item.explicit) ? 'explicit' : 'detected' },
              summary: `Run ${runnable.length} deterministic gate command(s) from the target repository in ${validationRoot}, with your environment: ${commands.join('; ')}${runnable.length < gatePlan.length ? ` (${gatePlan.length - runnable.length} gate(s) with missing prerequisites will not run and count as blocking failures)` : ''}.${skipped}${disclosures.map((text) => ` ${text}`).join('')}${untrusted}`,
            }];
          });
          if (!approval.approved) {
            manifest.results.push(blockedResult(assignment, stopped ? `${stopped} The gate commands did not run.` : approval.blocker));
            save();
            continue;
          }
        }
        const render = gateOutputRenderer(store, plan.runId, options.toolOutput ?? 'bounded', (telemetry) => store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'gate.output.recorded', assignmentId: assignment.id, message: `${telemetry.evidenceId}: ${telemetry.mode}`, data: { ...telemetry } }));
        const gateExecutions = await executeGatePlan(validationRoot, gatePlan, options.gateExecutor, { render });
        ranIn(validationRoot, `gate commands (${assignment.id})`);
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
      const request: HarnessExecutionRequest = { task, assignment, cwd, timeoutMs: options.timeoutMs ?? 1800000, prompt: assignmentPrompt(task, assignment, handoff, roleInstructions(root, assignment.role)) };
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
          // A completion claim from a client that did not end cleanly is not trusted: whatever
          // it reported, it crashed, was ended by a signal or exited with an error afterwards.
          if (!outcome.timedOut && parsed.status === 'completed' && !processSucceeded(outcome)) {
            parsed.status = 'failed';
            parsed.recommendation = 'changes_required';
            parsed.blockers = [...new Set([...parsed.blockers, `The ${assignment.harness} client ${processEnding(assignment.harness, outcome)} after reporting completion; a report from a client that did not end cleanly is not trusted.`])];
          }
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
      if (!assignmentWorktree) ranIn(cwd, `${assignment.role} ${assignment.id}`);
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
          // history), and leave the merge decision to a person. Its history ends at HEAD and at
          // its branch, which is what a person merges: an agent can move HEAD off the branch
          // (git checkout --detach) and leave commits on the branch, or the other way round.
          // Every end that names a commit is named and scanned before anything is refused.
          const found = worktreeTips(handle.path, handle.branch);
          const tips = historyEnds(found, handle.branch);
          const paths = (files: readonly string[]): string => redactSecrets(files.join(', ')).text;
          if (found.head && found.branch && found.head !== found.branch) {
            result.recommendation = 'human_required';
            result.risks = [...result.risks, `${tips.get(found.head)} in ${handle.path} is not the tip of ${handle.branch} (${found.branch.slice(0, 12)}); the agent moved one off the other. Review both before merging.`];
          }
          const history = historySince(handle.path, handle.baseSha, tips);
          const { where } = history;
          let ownCommits = '';
          if (history.commits.length) {
            ownCommits = ` The branch already carries ${history.commits.length} commit(s) the agent made itself (${shortList(history.commits)}), which this approval does not cover; the file list is the net change since base.`;
            result.recommendation = 'human_required';
            result.risks = [...result.risks, `The agent made ${history.commits.length} commit(s) itself on ${where} (${shortList(history.commits)}) that Code Conductor did not approve; review them before merging.`];
            result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${history.commits[0]}`, summary: `Agent-authored commits on ${where} since ${handle.baseSha.slice(0, 12)}: ${shortList(history.commits)}. Paths touched: ${paths(history.files)}` });
            const sensitive = history.files.filter(isSensitiveRepositoryPath);
            if (sensitive.length) throw new Error(`The agent's own commits on ${where} touch sensitive repository paths: ${paths(sensitive)}. Even if later removed, their content stays in history. Code Conductor committed nothing; review ${where} before using it.`);
            assertHistoryClean(handle.path, handle.baseSha, tips, (label) => `The agent's own commits on ${label}`, (label) => `Code Conductor committed nothing; review ${label} before using it.`);
          }
          // An agent can also move its branch or HEAD away from the base (for example reset to
          // an older commit); the net file list then includes undoing the base's own changes.
          const strays = [...tips].filter(([tip]) => !isAncestor(handle.path, handle.baseSha, tip)).map(([, label]) => label);
          if (strays.length) {
            const moved = `${strays.join(' and ')} no longer descend${strays.length === 1 ? 's' : ''} from its base ${handle.baseSha.slice(0, 12)}`;
            ownCommits += ` ${moved}, so the file list also undoes changes the base had.`;
            result.recommendation = 'human_required';
            result.risks = [...result.risks, `${moved}; the agent rewrote or reset ${strays.length === 1 ? 'it' : 'them'}.`];
          }
          if (!found.branch) {
            // A detached HEAD, or one still on the missing branch, means the agent removed it.
            if (!found.headRef || found.headRef === `refs/heads/${handle.branch}`) result.recommendation = 'human_required';
            // A worktree that is not an agent worktree at all (#48) is refused as such.
            assertAgentWorktree(handle);
            throw new Error(`${handle.branch} names no commit: the agent deleted it, or it is unreadable. Code Conductor committed nothing; check ${handle.path} and its reflog before using it.`);
          }
          if (!found.head) {
            result.recommendation = 'human_required';
            throw new Error(`HEAD in ${handle.path} names no commit (an unborn or orphan branch${found.headRef ? `, ${found.headRef}` : ''}). Code Conductor committed nothing; check it before using it.`);
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
                // The approval covers the history checked above; a commit added since is not in it.
                if (state.revision !== found.head) throw new Error(`HEAD moved to ${state.revision.slice(0, 12)} after the agent's own commits were checked at ${found.head!.slice(0, 12)}`);
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
            // Bound to the HEAD whose history was checked above, also when nothing needed approval.
            const commit = commitAllowed ? commitAgentChanges(handle, `feat(agent): ${assignment.agentId} for ${task.id}`, { expectedTree: expectedTree ?? before.tree, expectedHead: expectedHead ?? found.head }) : undefined;
            result.changes = commit?.files ?? [];
            if (commit) {
              result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${commit.sha}`, summary: `${commit.created ? 'Committed' : 'Preserved existing commits for'} ${commit.files.length} changed file(s) on ${handle.branch}: ${commit.files.join(', ')}` });
              store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'worktree.committed', assignmentId: assignment.id, message: `${handle.branch}@${commit.sha}` });
            }
          }
          checked.set(handle.path, { handle, assignmentId: assignment.id, tips: worktreeTips(handle.path, handle.branch) });
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

    // Later steps run in the builder's worktree after its own commits were checked, and anything
    // they left running can still write there. Before the decision, its history must still end
    // where that check left it; commits added since are named and scanned the same way.
    for (const [path, { handle, assignmentId, tips }] of checked) {
      const result = manifest.results.find((item) => item.assignmentId === assignmentId);
      if (!result) continue;
      if (stopped) {
        // No Git runs under changed configuration, so say where the history was last checked.
        result.recommendation = 'human_required';
        result.risks = [...result.risks, `${handle.branch} was checked at ${tips.branch!.slice(0, 12)}; nothing after that was re-checked, because the run stopped for a Git configuration change. Compare ${handle.branch} with ${tips.branch!.slice(0, 12)} before using it.`];
        continue;
      }
      try {
        stopped = controlChange(path, 'before the merge decision');
        if (stopped) throw new Error(stopped);
        const now = worktreeTips(path, handle.branch);
        if (now.head === tips.head && now.branch === tips.branch) continue;
        result.recommendation = 'human_required';
        const steps = laterSteps.get(path);
        const when = `after the agent's own commits were checked${steps ? `, while ${steps.join(', ')} ran in ${path}` : ` (${path})`}`;
        const ends = historyEnds(now, handle.branch);
        const from = tips.branch!;
        const added = historySince(path, from, ends);
        if (added.commits.length) {
          result.risks = [...result.risks, `${added.commits.length} commit(s) were added on ${added.where} ${when}: ${shortList(added.commits)}. Code Conductor did not approve them; review them before merging.`];
          result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${added.commits[0]}`, summary: `Commits added on ${added.where} ${when}: ${shortList(added.commits)}. Paths touched: ${redactSecrets(added.files.join(', ')).text}` });
          const sensitive = added.files.filter(isSensitiveRepositoryPath);
          if (sensitive.length) throw new Error(`The commits added on ${added.where} ${when} touch sensitive repository paths: ${redactSecrets(sensitive.join(', ')).text}. Review ${added.where} before using it.`);
          assertHistoryClean(path, from, ends, (label) => `The commits added on ${label} ${when}`, (label) => `Review ${label} before using it.`);
        }
        if (!now.branch || !now.head) throw new Error(`${now.branch ? 'HEAD' : handle.branch} in ${path} names no commit ${when}. Check it and its reflog before using it.`);
        if (now.head !== now.branch) result.risks = [...result.risks, `${ends.get(now.head)} in ${path} is not the tip of ${handle.branch} (${now.branch.slice(0, 12)}) ${when}. Review both before merging.`];
        const strays = [...ends].filter(([tip]) => !isAncestor(path, from, tip)).map(([, label]) => label);
        if (strays.length) result.risks = [...result.risks, `${strays.join(' and ')} no longer contain${strays.length === 1 ? 's' : ''} ${from.slice(0, 12)}, where the check left ${handle.branch}, ${when}; it was rewritten or reset.`];
      } catch (error) {
        result.status = 'blocked';
        result.recommendation = 'human_required';
        result.blockers = [...result.blockers, error instanceof Error ? error.message : String(error)];
      }
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
