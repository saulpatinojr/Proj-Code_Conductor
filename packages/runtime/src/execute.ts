import { randomUUID } from 'node:crypto';
import type { AgentAssignment, AgentResult, MergeDecision, RunManifest, TaskEnvelope } from '@code-conductor/schemas';
import type { HarnessAdapter, HarnessExecutionRequest } from '@code-conductor/adapters';
import { createBuiltinAdapters } from '@code-conductor/adapters';
import { RunStore } from '@code-conductor/evidence';
import { blockingGateFailure, runGates, type CommandExecutor, type GateExecution } from '@code-conductor/gates';
import { commitAgentChanges, WorktreeManager, type WorktreeHandle } from '@code-conductor/git';
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

function mergeDecision(task: TaskEnvelope, results: AgentResult[], gates: GateExecution[]): MergeDecision {
  const evidenceIds = [...new Set([...results.flatMap((r) => r.evidence.map((e) => e.id)), ...gates.flatMap((g) => g.result.evidenceIds)])];
  if (results.some((r) => r.status === 'awaiting_external')) return { decision: 'human_required', rationale: 'One or more assignments require an external/manual platform step.', evidenceIds };
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
  const pendingExternal: AgentAssignment[] = [];
  const createdWorktrees: WorktreeHandle[] = [];
  const executedGates: GateExecution[] = [];
  let primaryBuilderWorktree: WorktreeHandle | undefined;
  const save = (): string => store.saveManifest(manifest);
  store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'run.planned', message: `Planned ${plan.assignments.length} assignment(s).` });
  let manifestPath = save();
  if (!options.execute) return { plan, manifest, manifestPath, pendingExternal, worktrees: createdWorktrees };

  try {
    for (const assignment of plan.assignments) {
      const unmet = assignment.dependsOn.filter((id) => !manifest.results.some((result) => result.assignmentId === id && result.status === 'completed'));
      if (unmet.length) {
        const waiting = externalAwaitingResult(assignment, `Dependencies not completed: ${unmet.join(', ')}`);
        manifest.results.push({ ...waiting, status: 'blocked', recommendation: 'changes_required' });
        manifestPath = save();
        continue;
      }

      if (assignment.harness === 'internal-validator') {
        const validationRoot = primaryBuilderWorktree?.path ?? root;
        const gateExecutions = runGates(validationRoot, undefined, options.gateExecutor);
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
        createdWorktrees.push(assignmentWorktree); primaryBuilderWorktree ??= assignmentWorktree; cwd = assignmentWorktree.path;
      } else if (primaryBuilderWorktree) cwd = primaryBuilderWorktree.path;

      const request: HarnessExecutionRequest = { task, assignment, cwd, timeoutMs: options.timeoutMs ?? 1800000, prompt: buildPrompt(task, assignment) };
      let result: AgentResult | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
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
        } catch (error) { lastError = error; }
      }
      result ??= { taskId: task.id, assignmentId: assignment.id, agentId: assignment.agentId, role: assignment.role, stance: assignment.stance, provider: assignment.provider, harness: assignment.harness, ...(assignment.surface ? { surface: assignment.surface } : {}), billingChannel: assignment.billingChannel, status: 'failed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [lastError instanceof Error ? lastError.message : 'Harness execution failed after bounded retry.'], recommendation: 'changes_required' };

      if (assignmentWorktree && result.status === 'completed') {
        try {
          const commit = commitAgentChanges(assignmentWorktree, `feat(agent): ${assignment.agentId} for ${task.id}`);
          result.changes = commit?.files ?? [];
          if (commit) {
            result.evidence.push({ id: `E-${randomUUID()}`, kind: 'repository', source: `git:${commit.sha}`, summary: `${commit.created ? 'Committed' : 'Preserved existing commits for'} ${commit.files.length} changed file(s) on ${assignmentWorktree.branch}: ${commit.files.join(', ')}` });
            store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'worktree.committed', assignmentId: assignment.id, message: `${assignmentWorktree.branch}@${commit.sha}` });
          }
        } catch (error) {
          result.status = 'blocked';
          result.recommendation = 'changes_required';
          result.blockers.push(error instanceof Error ? error.message : String(error));
        }
      }

      manifest.results.push(result);
      store.appendEvent({ at: new Date().toISOString(), runId: plan.runId, type: 'assignment.completed', assignmentId: assignment.id, message: result.status });
      manifestPath = save();
    }

    manifest.mergeDecision = mergeDecision(task, manifest.results, executedGates);
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
