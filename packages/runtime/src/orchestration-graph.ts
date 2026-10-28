/** Model advice is a selection over validated inputs, never an authority definition. */
export interface TeamAgent {
  id: string;
  provider: string;
  capabilities: string[];
  sourceDigest: string;
  binding: 'verified-native' | 'manual' | 'unavailable';
}
export interface TeamRole {
  id: string;
  requiredCapabilities: string[];
}
export interface TeamInputs {
  digest: string;
  agents: readonly TeamAgent[];
  roles: readonly TeamRole[];
  requiredRoles: readonly string[];
  separateAgents: readonly [string, string][];
  separateProviders: readonly [string, string][];
  /** Each recipient-role assignment must depend transitively on every source-role assignment. */
  requiredHandoffs: readonly [string, string][];
}
export interface TeamAssignment { id: string; agentId: string; role: string; dependsOn: string[] }
export interface TeamAdvice { version: 1; inputDigest: string; assignments: TeamAssignment[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(identifier) && new Set(value).size === value.length;
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
function invalid(reason: string): never { throw new Error(`Orchestrator proposal rejected: ${reason}.`); }

function checkedInputs(inputs: TeamInputs): { agents: Map<string, TeamAgent>; roles: Map<string, TeamRole> } {
  if (!digest(inputs.digest) || inputs.agents.length > 256 || inputs.roles.length > 64 || !strings([...inputs.requiredRoles])) invalid('unsupported input inventory');
  const agents = new Map(inputs.agents.map((agent) => [agent.id, agent]));
  const roles = new Map(inputs.roles.map((role) => [role.id, role]));
  if (agents.size !== inputs.agents.length || roles.size !== inputs.roles.length) invalid('ambiguous input identities');
  for (const agent of agents.values()) if (!identifier(agent.id) || !identifier(agent.provider) || !strings(agent.capabilities) || !digest(agent.sourceDigest) || !['verified-native', 'manual', 'unavailable'].includes(agent.binding)) invalid('unsupported agent metadata');
  for (const role of roles.values()) if (!identifier(role.id) || !strings(role.requiredCapabilities)) invalid('unsupported role metadata');
  if (inputs.requiredRoles.some((role) => !roles.has(role))) invalid('unknown required role');
  for (const pairs of [inputs.separateAgents, inputs.separateProviders, inputs.requiredHandoffs]) {
    if (!Array.isArray(pairs) || pairs.length > 256 || pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((role) => !roles.has(role)))) invalid('unsupported role policy');
  }
  return { agents, roles };
}

/** Metadata and policy validation before any model invocation. */
export function validateTeamInputs(inputs: TeamInputs): void { checkedInputs(inputs); }

/** Full graph validation applies even when only a small pack delta was reviewed. */
export function validateTeamAdvice(value: unknown, inputs: TeamInputs): TeamAdvice {
  const { agents, roles } = checkedInputs(inputs);
  if (!object(value) || !keys(value, ['version', 'inputDigest', 'assignments']) || value.version !== 1 || value.inputDigest !== inputs.digest || !Array.isArray(value.assignments) || !value.assignments.length || value.assignments.length > 256) invalid('unsupported schema or stale inputs');
  const assignments: TeamAssignment[] = [];
  for (const item of value.assignments) {
    if (!object(item) || !keys(item, ['id', 'agentId', 'role', 'dependsOn']) || !identifier(item.id) || !identifier(item.agentId) || !identifier(item.role) || !strings(item.dependsOn)) invalid('unsupported assignment');
    const agent = agents.get(item.agentId); const role = roles.get(item.role);
    if (!agent || !role || agent.binding === 'unavailable') invalid('unknown or unavailable agent/role');
    if (role.requiredCapabilities.some((capability) => !agent.capabilities.includes(capability))) invalid('missing required capability');
    assignments.push({ id: item.id, agentId: item.agentId, role: item.role, dependsOn: [...item.dependsOn] });
  }
  const byId = new Map(assignments.map((item) => [item.id, item]));
  if (byId.size !== assignments.length) invalid('duplicate assignment identity');
  if (new Set(assignments.map((item) => `${item.role}:${item.agentId}`)).size !== assignments.length) invalid('duplicate agent/role assignment');
  if (inputs.requiredRoles.some((role) => !assignments.some((item) => item.role === role))) invalid('missing mandatory role');
  for (const item of assignments) if (item.dependsOn.some((id) => !byId.has(id))) invalid('missing handoff recipient');
  const visiting = new Set<string>(); const done = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) invalid('cyclic handoffs');
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id); done.add(id);
  }
  for (const item of assignments) visit(item.id);
  if (inputs.requiredHandoffs.length > 256) invalid('unsupported handoff policy');
  function ancestors(id: string, found = new Set<string>()): Set<string> {
    for (const dependency of byId.get(id)!.dependsOn) if (!found.has(dependency)) { found.add(dependency); ancestors(dependency, found); }
    return found;
  }
  for (const pair of inputs.requiredHandoffs) {
    if (pair.length !== 2 || pair.some((role) => !roles.has(role))) invalid('unknown handoff role');
    const recipients = assignments.filter((item) => item.role === pair[0]);
    const sources = assignments.filter((item) => item.role === pair[1]);
    if (recipients.some((recipient) => { const prior = ancestors(recipient.id); return sources.some((source) => !prior.has(source.id)); })) invalid('missing required handoff');
  }
  for (const [pairs, provider] of [[inputs.separateAgents, false], [inputs.separateProviders, true]] as const) {
    if (pairs.length > 256) invalid('unsupported separation policy');
    for (const pair of pairs) {
      if (pair.length !== 2 || pair.some((role) => !roles.has(role))) invalid('unknown separation role');
      const left = assignments.filter((item) => item.role === pair[0]);
      const right = assignments.filter((item) => item.role === pair[1]);
      if (left.some((a) => right.some((b) => provider ? agents.get(a.agentId)!.provider === agents.get(b.agentId)!.provider : a.agentId === b.agentId))) invalid('role separation violation');
    }
  }
  return { version: 1, inputDigest: inputs.digest, assignments };
}
