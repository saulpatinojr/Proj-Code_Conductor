import { planGates } from '@code-conductor/gates';
import { randomUUID } from 'node:crypto';
import { loadConfiguration, roleInstructionsProblem, type ConfigurationName } from '@code-conductor/policy';
import type { AgentAssignment, PlanReviewSnapshot, BillingChannel, RiskClass, Stance, TaskEnvelope } from '@code-conductor/schemas';

interface RoleConstraints {
  different_provider_from_builder_when_risk_at_least?: RiskClass;
}
interface RoleDefinition {
  stance: Stance;
  preferred_harnesses?: string[];
  may_modify_code?: boolean;
  may_review?: boolean;
  may_block?: boolean;
  may_execute_validation?: boolean;
  may_resolve_disagreement?: boolean;
  may_recommend_merge?: boolean;
  may_approve?: boolean;
  may_merge?: boolean;
  constraints?: RoleConstraints;
  instructions?: unknown;
}
interface RolesDocument { roles: Record<string, RoleDefinition> }
interface RiskDefinition { required_roles?: string[]; inherits?: RiskClass }
interface RiskDocument { risk_classes: Record<RiskClass, RiskDefinition> }
interface SurfaceDefinition {
  kind?: string;
  machine_execution?: boolean;
  requires_local_client?: boolean;
  separately_billed_api?: boolean;
  enabled_by_default?: boolean;
}
interface HarnessDefinition {
  provider: string;
  subscription?: string;
  preferred_execution_surface?: string;
  surfaces?: Record<string, SurfaceDefinition>;
  primary_specializations?: string[];
}
interface CapabilityDocument {
  version?: number;
  routing?: { objective_signals?: Record<string, string[]> };
  harnesses: Record<string, HarnessDefinition>;
}

const riskRank: Record<RiskClass, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

function load<T>(root: string, name: ConfigurationName): T { return loadConfiguration<T>(root, name).document; }

/**
 * The rules a role's assignment prompt carries, from the configured role (packaged
 * defaults, narrowed by user and workspace preferences). Malformed rules are refused
 * here as well, so a configuration `ccon validate` would reject never reaches a prompt.
 */
export function roleInstructions(root: string, role: string): string[] {
  const definition = load<RolesDocument>(root, 'roles').roles?.[role];
  const problem = roleInstructionsProblem(definition?.instructions);
  if (problem) throw new Error(`Role ${role} in config/roles.yaml: ${problem}.`);
  return [...((definition?.instructions as string[] | undefined) ?? [])];
}
function inheritedRoles(risks: RiskDocument, risk: RiskClass, seen = new Set<RiskClass>()): string[] {
  if (seen.has(risk)) throw new Error(`Risk inheritance cycle at ${risk}`);
  seen.add(risk);
  const entry = risks.risk_classes[risk];
  if (!entry) throw new Error(`Unknown risk class: ${risk}`);
  const base = entry.inherits ? inheritedRoles(risks, entry.inherits, seen) : [];
  return [...new Set([...base, ...(entry.required_roles ?? [])])];
}
function authorityFor(role: RoleDefinition): string[] {
  const authority = ['observe', 'recommend'];
  if (role.may_modify_code) authority.push('modify_worktree');
  if (role.may_review) authority.push('review');
  if (role.may_block) authority.push('block');
  if (role.may_execute_validation) authority.push('execute_validation');
  if (role.may_resolve_disagreement) authority.push('resolve_disagreement');
  if (role.may_recommend_merge) authority.push('recommend_merge');
  if (role.may_approve) authority.push('approve');
  if (role.may_merge) authority.push('merge');
  return authority;
}
function preferredSurface(capability: HarnessDefinition): string {
  if (capability.preferred_execution_surface) return capability.preferred_execution_surface;
  const machine = Object.entries(capability.surfaces ?? {}).find(([, surface]) => surface.machine_execution && surface.enabled_by_default !== false);
  return machine?.[0] ?? Object.keys(capability.surfaces ?? {})[0] ?? 'unknown';
}
function requiresWorkstationClient(capability: HarnessDefinition): boolean {
  const surface = capability.surfaces?.[preferredSurface(capability)];
  return Boolean(surface?.requires_local_client);
}
function billingChannelFor(capability: HarnessDefinition): BillingChannel {
  const surfaceName = preferredSurface(capability);
  const surface = capability.surfaces?.[surfaceName];
  if (surfaceName === 'local' || surface?.kind === 'local') return 'local';
  if (surfaceName === 'manual' || surface?.kind === 'manual') return 'manual';
  if (surface?.separately_billed_api || surface?.kind === 'mcp_api' || surface?.kind === 'api') return 'api';
  return 'subscription';
}
function riskAtLeast(actual: RiskClass, threshold: RiskClass): boolean {
  return riskRank[actual] >= riskRank[threshold];
}
function inferredSpecializations(task: TaskEnvelope, capabilities: CapabilityDocument): Set<string> {
  if (task.specializations?.length) return new Set(task.specializations);
  const objective = task.objective.toLowerCase();
  const inferred = new Set<string>();
  for (const [specialization, signals] of Object.entries(capabilities.routing?.objective_signals ?? {})) {
    if (signals.some((signal) => objective.includes(signal.toLowerCase()))) inferred.add(specialization);
  }
  return inferred;
}
function specializationScore(capability: HarnessDefinition, requested: Set<string>): number {
  return (capability.primary_specializations ?? []).reduce((score, specialization) => score + (requested.has(specialization) ? 1 : 0), 0);
}
function orderBySpecialization(candidates: string[], capabilities: CapabilityDocument, requested: Set<string>): string[] {
  return candidates
    .map((harness, index) => ({ harness, index, score: specializationScore(capabilities.harnesses[harness]!, requested) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.harness);
}

export interface PlanOptions { availableHarnesses?: Set<string>; inventoryHarnesses?: Set<string>; gateProfiles?: string[] }
export interface TaskPlan { planReview: PlanReviewSnapshot; runId: string; task: TaskEnvelope; assignments: AgentAssignment[] }

export function planTask(root: string, task: TaskEnvelope, options: PlanOptions = {}): TaskPlan {
  const roles = load<RolesDocument>(root, 'roles');
  const risks = load<RiskDocument>(root, 'risk');
  const capabilities = load<CapabilityDocument>(root, 'capabilities');
  const requiredRoles = inheritedRoles(risks, task.risk);
  const requestedSpecializations = inferredSpecializations(task, capabilities);
  const available = options.availableHarnesses;
  const assignments: AgentAssignment[] = [];
  let builderProvider: string | undefined;
  let builderAssignmentId: string | undefined;

  for (const roleName of requiredRoles) {
    const role = roles.roles[roleName];
    if (!role) throw new Error(`Role ${roleName} is not defined.`);
    const preferred = role.preferred_harnesses ?? Object.keys(capabilities.harnesses);
    let candidates = preferred.filter((harness) => capabilities.harnesses[harness]);
    if (available) {
      candidates = candidates.filter((harness) => {
        const capability = capabilities.harnesses[harness];
        if (!capability) return false;
        return !requiresWorkstationClient(capability) || available.has(harness);
      });
    }
    const independenceThreshold = role.constraints?.different_provider_from_builder_when_risk_at_least;
    if (builderProvider && independenceThreshold && riskAtLeast(task.risk, independenceThreshold)) {
      candidates = candidates.filter((harness) => capabilities.harnesses[harness]?.provider !== builderProvider);
    }
    candidates = orderBySpecialization(candidates, capabilities, requestedSpecializations);
    const harness = candidates[0];
    if (!harness) throw new Error(`No eligible harness is available for role ${roleName}.`);
    const capability = capabilities.harnesses[harness];
    if (!capability) throw new Error(`Harness ${harness} is not defined.`);
    const dependsOn: string[] = [];
    if (roleName !== 'builder' && builderAssignmentId && !['researcher', 'spec_lead'].includes(roleName)) dependsOn.push(builderAssignmentId);
    if (roleName === 'builder') for (const assignment of assignments.filter((item) => ['researcher', 'spec_lead'].includes(item.role))) dependsOn.push(assignment.id);
    const assignment: AgentAssignment = {
      id: `A-${assignments.length + 1}-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      agentId: `${roleName}-${harness}`,
      role: roleName,
      stance: role.stance,
      provider: capability.provider,
      harness,
      surface: preferredSurface(capability),
      billingChannel: billingChannelFor(capability),
      authority: authorityFor(role),
      dependsOn,
    };
    assignments.push(assignment);
    if (roleName === 'builder') { builderProvider = capability.provider; builderAssignmentId = assignment.id; }
  }
  const inventory = options.inventoryHarnesses ?? available;
  const providers = Object.entries(capabilities.harnesses).map(([harness, capability]) => ({
    harness, provider: capability.provider, surface: preferredSurface(capability),
    localClientRequired: requiresWorkstationClient(capability),
    inventory: !inventory ? 'not_checked' as const : inventory.has(harness) ? 'present' as const : 'absent' as const,
  }));
  let checks: PlanReviewSnapshot['checks'] = { state: 'unavailable', selection: options.gateProfiles?.length ? 'explicit' : 'detected', gates: [] };
  try {
    const planned = planGates(root, options.gateProfiles, undefined, { maxEntries: 2000, maxDepth: 12 });
    if (planned.length <= 256) checks = { ...checks, state: 'recorded', gates: planned.map(({ profile, gate, timeoutMs, missing, executable, prefixArgs }) => ({
      profile, id: gate.id, command: gate.command, args: [...(gate.args ?? [])], configuredBlocking: gate.blocking !== false,
      timeoutMs, missing: [...missing], ...(executable ? { executable } : {}), ...(prefixArgs ? { prefixArgs: [...prefixArgs] } : {}),
    })) };
  } catch { /* An unavailable read-only preview cannot grant or bypass later gate execution. */ }
  const planReview: PlanReviewSnapshot = {
    version: 1, capturedAt: new Date().toISOString(),
    specializations: { source: task.specializations?.length ? 'requested' : requestedSpecializations.size ? 'objective_signals' : 'none', values: [...requestedSpecializations] },
    providers, checks,
  };
  return { runId: `CC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`, task, assignments, planReview };
}

export function createTask(objective: string, risk: RiskClass, repository?: string, specializations: string[] = []): TaskEnvelope {
  return {
    id: `T-${randomUUID()}`,
    objective,
    ...(repository ? { repository } : {}),
    acceptanceCriteria: [],
    risk,
    constraints: [],
    ...(specializations.length ? { specializations: [...new Set(specializations)] } : {}),
    createdAt: new Date().toISOString(),
  };
}
