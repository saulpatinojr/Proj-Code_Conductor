import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AgentAssignment, AgentResult, ApprovalRecord, ApprovalRequest, MergeDecision, RunManifest, TaskEnvelope } from '@code-conductor/schemas';
import type { HarnessAdapter, HarnessExecutionRequest } from '@code-conductor/adapters';
import { createBuiltinAdapters } from '@code-conductor/adapters';
import { RunStore } from '@code-conductor/evidence';
import { blockingGateFailure, executeGatePlan, planGates, type CommandExecutor, type GateExecution } from '@code-conductor/gates';
import { assertAgentWorktree, assertSafeChangedPaths, commitAgentChanges, commitsSince, gitControlState, headTree, isSensitiveRepositoryPath, treeChangedFiles, workingTreeState, WorktreeManager, type WorktreeHandle } from '@code-conductor/git';
import { ApprovalGate, approvalBlocker, type Approver } from '@code-conductor/policy';
import { externalAwaitingResult, parseAgentResult } from './result.js';
import { planTask, type TaskPlan } from './planner.js';

export interface ExecuteOptions {
  execute?: boolean;
  adapters?: Map<string, HarnessAdapter>;
  store?: RunStore;
  worktrees?: WorktreeManager;
  gateExecutor?: CommandExecutor;
  timeoutMs?: number;
  keepWorktrees?: boolean;
  isHarnessTrusted?: (harness: string, mode: 'read' | 'modify', surface?: string) => boolean;
  /**
   * Asked immediately before each consequential action: starting a provider
   * process, disclosing context to it, running gate commands and committing.
   * Without one, every such action fails closed. Workstation trust is not approval.
   */
  approver?: Approver;
  approvalTtlMs?: number;
  now?: () => number;
}
export interface ExecuteOutcome { plan: TaskPlan; manifest: RunManifest; manifestPath: string; pendingExternal: AgentAssignment[]; worktrees: WorktreeHandle[] }

function buildPrompt(task: TaskEnvelope, assignment: AgentAssignment): string {
  return [
    `Code Conductor task ${task.id}.`, `Objective: ${task.objective}`, `Role: ${assignment.role}. Stance: ${assignment.stance}.`,
    `Harness: ${assignment.harness}. Surface: ${assignment.surface ?? 'unspecified'}.`,
    `Authority: ${assignment.authority.join(', ') || 'observe'}.`,
    `Acceptance criteria: ${task.acceptanceCriteria.length ? task.acceptanceCriteria.join(' | ') : 'Use repository task definition and policy.'}`,
    `Specializations: ${task.specializations?.length ? task.specializations.join(', ') : 'Use approved routing/configuration.'}`,
    'Read AGENTS.md and applicable repository instructions before acting.',
    'Do not reveal private chain-of-thought. Return conclusions, evidence, changes, tests, findings, risks, blockers, and recommendation only.',
    'Your FINAL line MUST be CC_RESULT_JSON:<single-line JSON object> matching AgentResult fields that you control: status, changes, tests, evidence, findings, risks, blockers, recommendation, and optionally notVerified (a list of checks you did not perform or could not verify).',
  ].join('\n');
}

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

// Files that can change what later runs: CI, Git hooks, scripts, dependencies and
// package-manager settings, Git behaviour, and agent, editor or dev-container
// configuration that clients load automatically. Matched case-insensitively, because
// case-insensitive file systems load `.Claude/` as `.claude/`.
const EXECUTION_RELEVANT_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.envrc', 'makefile', 'dockerfile', 'jenkinsfile',
  '.gitattributes', '.gitmodules', '.gitignore', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml',
  '.gitlab-ci.yml', 'azure-pipelines.yml', '.mcp.json', 'agents.md', 'claude.md', 'gemini.md', 'apm.yml', 'apm.lock.yaml', 'apm-policy.yml',
]);
const EXECUTION_RELEVANT_DIRECTORIES = new Set(['.github', '.husky', '.githooks', 'scripts', '.circleci', '.devcontainer', '.vscode', '.claude', '.codex', '.cursor', '.gemini', '.kiro']);
const EXECUTABLE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|exe)$/;
function executionRelevant(file: string): boolean {
  const segments = file.toLowerCase().split('/');
  const leaf = segments.at(-1) ?? '';
  return EXECUTION_RELEVANT_FILES.has(leaf) || EXECUTABLE.test(leaf) || segments.slice(0, -1).some((segment) => EXECUTION_RELEVANT_DIRECTORIES.has(segment));
}
// Leads with the counts, so a truncated display still says how many files can change
// what later runs; those files are listed before any others.
function summarizeFiles(files: readonly string[]): string {
  const relevant = files.filter(executionRelevant);
  const others = files.filter((file) => !executionRelevant(file));
  const shown = others.slice(0, 20);
  return `${files.length} changed file(s), ${relevant.length} of them able to change what later runs (CI, hooks, scripts, dependencies, agent or editor configuration)${relevant.length ? `: ${relevant.join(', ')}` : ''}. ${others.length ? `Other files: ${shown.join(', ')}${others.length > shown.length ? `, … (${others.length - shown.length} more)` : ''}` : 'No other files'}`;
}
function shortList(shas: readonly string[], limit = 10): string {
  return `${shas.slice(0, limit).map((sha) => sha.slice(0, 12)).join(', ')}${shas.length > limit ? `, … (${shas.length - limit} more)` : ''}`;
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
  const pendingExternal: AgentAssignment[] = [];
  const createdWorktrees: WorktreeHandle[] = [];
  const executedGates: GateExecution[] = [];
  let primaryBuilderWorktree: WorktreeHandle | undefined;
  // Set when Git configuration or history files changed under a provider; nothing that
  // would run Git under that configuration happens for the rest of the run.
  let stopped: string | undefined;
  const save = (): string => store.saveManifest(manifest);
  store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'run.planned', message: `Planned ${plan.assignments.length} assignment(s).` });
  let manifestPath = save();
  if (!options.execute) return { plan, manifest, manifestPath, pendingExternal, worktrees: createdWorktrees };

  try {
    for (const assignment of plan.assignments) {
      if (stopped) {
        manifest.results.push(blockedResult(assignment, stopped));
        manifestPath = save();
        continue;
      }
      const unmet = assignment.dependsOn.filter((id) => !manifest.results.some((result) => result.assignmentId === id && result.status === 'completed'));
      if (unmet.length) {
        const waiting = externalAwaitingResult(assignment, `Dependencies not completed: ${unmet.join(', ')}`);
        manifest.results.push({ ...waiting, status: 'blocked', recommendation: 'changes_required' });
        manifestPath = save();
        continue;
      }

      if (assignment.harness === 'internal-validator') {
        const validationRoot = primaryBuilderWorktree?.path ?? root;
        const gatePlan = planGates(validationRoot);
        if (gatePlan.length) {
          // Gate profiles run the target repository's own scripts, so they are local execution.
          const commands = gatePlan.map((item) => [item.gate.command, ...(item.gate.args ?? [])].join(' '));
          const approval = await authorize(() => {
            const state = workingTreeState(validationRoot);
            return [{
              action: 'local_execution', runId: plan.runId, taskId: task.id, assignmentId: assignment.id, repository: validationRoot, revision: state.revision, recipient: 'local:deterministic-gates',
              bindings: { tree: state.tree, commands: sha256(JSON.stringify(gatePlan.map((item) => [item.profile, item.gate.id, item.gate.command, item.gate.args ?? [], item.timeoutMs]))) },
              summary: `Run ${gatePlan.length} deterministic gate command(s) in ${validationRoot}: ${commands.join('; ')}`,
            }];
          });
          if (!approval.approved) {
            manifest.results.push(blockedResult(assignment, approval.blocker));
            manifestPath = save();
            continue;
          }
        }
        const gateExecutions = executeGatePlan(validationRoot, gatePlan, options.gateExecutor);
        executedGates.push(...gateExecutions);
        manifest.gates.push(...gateExecutions.map((item) => item.result));
        const failed = blockingGateFailure(gateExecutions);
        manifest.results.push({
          taskId: task.id, assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, stance: assignment.stance,
          provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}), billingChannel: 'local', status: failed ? 'failed' : 'completed', changes: [],
          tests: gateExecutions.map((item) => item.result), evidence: gateExecutions.map((item) => item.evidence), findings: [], risks: [],
          blockers: failed ? ['Blocking deterministic gate failed.'] : [], recommendation: failed ? 'changes_required' : 'continue',
        });
        store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'validation.completed', assignmentId: assignment.id, message: failed ? 'failed' : 'completed' });
        manifestPath = save();
        continue;
      }

      const adapter = adapters.get(assignment.harness);
      if (!adapter || !adapter.available()) {
        const result = externalAwaitingResult(assignment, `Harness ${assignment.harness} surface ${assignment.surface ?? 'unknown'} requires manual/platform integration or is unavailable on this workstation.`);
        manifest.results.push(result); pendingExternal.push(assignment); manifestPath = save(); continue;
      }

      if (assignment.surface && adapter.executionSurface !== assignment.surface) {
        manifest.results.push({ ...externalAwaitingResult(assignment, `Harness ${assignment.harness} is configured for ${assignment.surface}, but the installed adapter exposes ${adapter.executionSurface}.`), status: 'blocked', recommendation: 'changes_required' });
        manifestPath = save();
        continue;
      }

      const trustMode = assignment.authority.includes('modify_worktree') ? 'modify' : 'read';
      if (!options.isHarnessTrusted?.(assignment.harness, trustMode, assignment.surface ?? adapter.executionSurface)) {
        manifest.results.push({ ...externalAwaitingResult(assignment, `Harness ${assignment.harness} surface ${assignment.surface ?? adapter.executionSurface} has not passed Code Conductor workstation ${trustMode} smoke validation.`), status: 'blocked', recommendation: 'changes_required' });
        manifestPath = save(); continue;
      }

      let cwd = root;
      let assignmentWorktree: WorktreeHandle | undefined;
      if (assignment.authority.includes('modify_worktree')) {
        assignmentWorktree = worktrees.create(root, task.id, assignment.agentId);
        createdWorktrees.push(assignmentWorktree); cwd = assignmentWorktree.path;
      } else if (primaryBuilderWorktree) cwd = primaryBuilderWorktree.path;

      const request: HarnessExecutionRequest = { task, assignment, cwd, timeoutMs: options.timeoutMs ?? 1800000, prompt: buildPrompt(task, assignment) };
      // Starting the client and disclosing the prompt plus repository access are
      // approved together but recorded separately, each bound to this recipient.
      // Every start, including a retry, is a new process and a new disclosure, so
      // each attempt needs its own approval of the then-current working tree.
      const surface = assignment.surface ?? adapter.executionSurface;
      const recipient = `${assignment.provider}/${assignment.harness}@${surface}`;
      const promptBytes = Buffer.byteLength(request.prompt, 'utf8');
      const invocation = adapter.invocation?.(request) ?? { command: adapter.command ?? 'platform', args: [] };
      // The prompt is bound by digest; redact it wherever an adapter embeds it.
      const argv = [invocation.command, ...invocation.args.map((arg) => (request.prompt && arg.includes(request.prompt) ? arg.replaceAll(request.prompt, '<prompt>') : arg))];
      const authorizeStart = (attempt: number) => authorize((): ApprovalRequest[] => {
        const state = workingTreeState(cwd);
        const bound = { runId: plan.runId, taskId: task.id, assignmentId: assignment.id, repository: cwd, revision: state.revision, recipient };
        const prefix = attempt ? `Retry attempt ${attempt + 1}: ` : '';
        return [
          { ...bound, action: 'local_execution', bindings: { attempt: String(attempt + 1), tree: state.tree, argv: sha256(JSON.stringify(argv)), surface, authority: assignment.authority.join(','), billingChannel: assignment.billingChannel }, summary: `${prefix}Start \`${argv.join(' ')}\` (${surface}, ${assignment.billingChannel}) as ${assignment.role} with authority ${assignment.authority.join(', ')} in ${cwd}.` },
          { ...bound, action: 'context_disclosure', bindings: { attempt: String(attempt + 1), tree: state.tree, prompt: sha256(request.prompt), promptBytes: String(promptBytes) }, summary: `${prefix}Disclose the ${promptBytes}-byte task prompt to ${recipient}, running in ${cwd} at ${state.revision.slice(0, 12)}. What else it can read is set by that client's own sandbox and permissions, not by Code Conductor.` },
        ];
      });
      // Git configuration defines programs Code Conductor's own `git add` runs (clean and
      // process filters), and grafts or a shallow file change which history it sees. A
      // provider that changed them could get its programs run outside its own sandbox,
      // so they must be as they were before any further Git operation here.
      let controlBefore = '';
      let approval: { approved: boolean; blocker: string };
      try {
        controlBefore = gitControlState(cwd);
        approval = await authorizeStart(0);
      } catch (error) {
        approval = { approved: false, blocker: `Git configuration in ${cwd} could not be read (${error instanceof Error ? error.message : String(error)}); the provider was not started.` };
      }
      if (!approval.approved) {
        if (assignmentWorktree) {
          // Nothing ran in the fresh worktree; remove it and its branch rather than leave them behind.
          const unused = assignmentWorktree;
          let cleanup = '';
          try { worktrees.remove(unused, true, false); }
          catch (error) { cleanup = ` Cleanup of the unused worktree/branch ${unused.branch} was incomplete: ${error instanceof Error ? error.message : String(error)}`; }
          if (!existsSync(unused.path)) createdWorktrees.splice(createdWorktrees.indexOf(unused), 1);
          approval.blocker += cleanup;
        }
        manifest.results.push(blockedResult(assignment, approval.blocker));
        manifestPath = save();
        continue;
      }
      if (assignmentWorktree) primaryBuilderWorktree ??= assignmentWorktree;
      const controlChanged = (): string | undefined => {
        let changed: boolean;
        try { changed = gitControlState(cwd) !== controlBefore; } catch { changed = true; }
        return changed ? `Git configuration or history files (config of any scope, info/attributes, info/grafts, shallow, objects/info/alternates) changed after ${recipient} was started in ${cwd}. Code Conductor ran no further Git operations under configuration it had not seen and stopped the run; check \`git -C ${cwd} config --list --show-origin\` and the repository's .git directory before running again. Agent changes are preserved uncommitted.` : undefined;
      };
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
                const state = workingTreeState(handle.path);
                // Shown files, the sensitive-path check and the bound tree come from one snapshot.
                const files = treeChangedFiles(handle.path, handle.baseSha, state.tree);
                assertSafeChangedPaths(files);
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
      manifestPath = save();
    }

    manifest.mergeDecision = mergeDecision(task, manifest.results, executedGates, approvals.records);
    manifestPath = save();
    store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'run.completed', message: manifest.mergeDecision.decision });
    return { plan, manifest, manifestPath, pendingExternal, worktrees: createdWorktrees };
  } finally {
    // Keep modifying worktrees by default so agent changes and commits cannot be
    // silently discarded. Cleanup must be an explicit caller choice.
    if (options.keepWorktrees === false) {
      for (const handle of createdWorktrees) worktrees.remove(handle, false, false);
    }
  }
}
