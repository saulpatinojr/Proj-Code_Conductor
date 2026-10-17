import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateContract, type ContractValidationResult, type RiskClass, type Stance } from '@code-conductor/schemas';

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

type RoleConfig = {
  stance?: Stance;
  may_modify_code?: boolean;
  may_review?: boolean;
  may_approve?: boolean;
  may_merge?: boolean;
  may_block?: boolean;
  may_execute_validation?: boolean;
  may_resolve_disagreement?: boolean;
  may_recommend_merge?: boolean;
};

type RolesConfig = { version: number; roles: Record<string, RoleConfig> };
type RiskConfig = {
  version: number;
  risk_classes: Record<RiskClass, {
    required_roles?: string[];
    human_approval?: boolean;
    independent_review?: boolean;
    challenger_must_use_different_provider_from_builder?: boolean;
    require_human_approval_before_side_effect?: boolean;
    unattended_execution?: boolean;
  }>;
};
type CapabilitySurface = {
  kind?: string;
  machine_execution?: boolean;
  separately_billed_api?: boolean;
  enabled_by_default?: boolean;
};
type CapabilityHarness = {
  provider?: string;
  preferred_execution_surface?: string;
  surfaces?: Record<string, CapabilitySurface>;
  native_capabilities?: string[];
  sign_in?: { command?: unknown; instructions?: unknown; docs?: unknown };
  primary_specializations?: string[];
};
type CapabilityConfig = {
  version: number;
  defaults?: { billing_policy?: string; allow_separately_billed_api?: boolean; require_official_client_or_api?: boolean };
  routing?: { objective_signals?: Record<string, string[]> };
  harnesses?: Record<string, CapabilityHarness>;
};
type ReferenceConfig = {
  version: number;
  authoritative_sources?: Record<string, string[]>;
  policy?: { blocking_findings_require_evidence?: boolean };
};
type ApmConfig = { name?: string; version?: string; targets?: string[]; dependencies?: { apm?: unknown[]; mcp?: unknown[] } };

const requiredFiles = [
  'AGENTS.md',
  'STARTER.md',
  'docs/DECISIONS.md',
  'docs/IMPLEMENTATION-PLAN.md',
  'apm.yml',
  'config/capabilities.yaml',
  'config/roles.yaml',
  'config/risk.yaml',
  'config/authorities.yaml',
  'config/references.yaml',
] as const;

const requiredTargets = ['copilot', 'claude', 'codex', 'kiro', 'antigravity', 'agent-skills'] as const;

function readYaml<T>(root: string, relativePath: string, issues: ValidationIssue[]): T | undefined {
  const full = join(root, relativePath);
  try {
    return parse(readFileSync(full, 'utf8')) as T;
  } catch (error) {
    issues.push({ level: 'error', code: 'yaml.invalid', path: relativePath, message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

export function validatePolicyObjects(roles: RolesConfig, risks: RiskConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [name, role] of Object.entries(roles.roles ?? {})) {
    if (role.may_modify_code && (role.may_approve || role.may_merge)) {
      issues.push({ level: 'error', code: 'authority.separation_of_duties', path: `roles.${name}`, message: `Role ${name} may modify code and may also approve/merge.` });
    }
    if (role.may_modify_code && role.may_review) {
      issues.push({ level: 'warning', code: 'authority.self_review_risk', path: `roles.${name}`, message: `Role ${name} can modify and review; assignments must enforce independence.` });
    }
  }

  for (const [riskName, risk] of Object.entries(risks.risk_classes ?? {})) {
    for (const roleName of risk.required_roles ?? []) {
      if (!roles.roles?.[roleName]) {
        issues.push({ level: 'error', code: 'risk.unknown_role', path: `risk_classes.${riskName}`, message: `Risk class ${riskName} requires unknown role ${roleName}.` });
      }
    }
  }

  const r2 = risks.risk_classes?.R2;
  if (!r2?.challenger_must_use_different_provider_from_builder) {
    issues.push({ level: 'error', code: 'risk.r2_independence', message: 'R2 must require a different-provider challenger.' });
  }

  for (const level of ['R3', 'R4'] as const) {
    if (!risks.risk_classes?.[level]?.human_approval) {
      issues.push({ level: 'error', code: 'risk.human_approval', path: `risk_classes.${level}`, message: `${level} must require human approval.` });
    }
  }

  const r4 = risks.risk_classes?.R4;
  if (!r4?.require_human_approval_before_side_effect || r4?.unattended_execution !== false) {
    issues.push({ level: 'error', code: 'risk.r4_side_effect_gate', message: 'R4 must stop for human approval before external side effects and disable unattended execution.' });
  }

  return issues;
}

export function validateCapabilities(capabilities: CapabilityConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (capabilities.version !== 2) {
    issues.push({ level: 'error', code: 'capabilities.version', path: 'config/capabilities.yaml', message: 'Surface-aware capability configuration must use version 2.' });
  }
  if (capabilities.defaults?.billing_policy !== 'subscription_first') {
    issues.push({ level: 'error', code: 'billing.subscription_first', path: 'config/capabilities.yaml', message: 'Default billing policy must be subscription_first.' });
  }
  if (capabilities.defaults?.allow_separately_billed_api !== false) {
    issues.push({ level: 'error', code: 'billing.api_default', path: 'config/capabilities.yaml', message: 'Separately billed API execution must be disabled by default.' });
  }

  for (const [id, harness] of Object.entries(capabilities.harnesses ?? {})) {
    const path = `config/capabilities.yaml#harnesses.${id}`;
    if (!harness.provider) issues.push({ level: 'error', code: 'capabilities.provider', path, message: `Harness ${id} must declare a provider.` });
    if (!harness.preferred_execution_surface) {
      issues.push({ level: 'error', code: 'capabilities.preferred_surface', path, message: `Harness ${id} must declare preferred_execution_surface.` });
    } else if (!harness.surfaces?.[harness.preferred_execution_surface]) {
      issues.push({ level: 'error', code: 'capabilities.unknown_preferred_surface', path, message: `Harness ${id} preferred surface ${harness.preferred_execution_surface} is not declared.` });
    }
    if (!harness.surfaces || Object.keys(harness.surfaces).length === 0) {
      issues.push({ level: 'error', code: 'capabilities.surfaces_required', path, message: `Harness ${id} must declare at least one surface.` });
    }
    if (harness.sign_in !== undefined) {
      const signIn = harness.sign_in;
      const command = signIn?.command;
      if (command !== undefined && (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(part)))) {
        issues.push({ level: 'error', code: 'capabilities.sign_in_command', path, message: `Harness ${id} sign_in.command must be a non-empty list of plain arguments (no shell syntax).` });
      }
      if (signIn?.docs !== undefined && (typeof signIn.docs !== 'string' || !/^https:\/\/[^\s]+$/.test(signIn.docs))) {
        issues.push({ level: 'error', code: 'capabilities.sign_in_docs', path, message: `Harness ${id} sign_in.docs must be an https URL to official documentation.` });
      }
      if (typeof signIn?.instructions !== 'string' || !signIn.instructions) {
        issues.push({ level: 'error', code: 'capabilities.sign_in_instructions', path, message: `Harness ${id} sign_in must explain where sign-in happens.` });
      }
    }
    if (!Array.isArray(harness.native_capabilities)) {
      issues.push({ level: 'error', code: 'capabilities.native_capabilities', path, message: `Harness ${id} must declare native_capabilities, even if empty.` });
    }
    for (const [surfaceName, surface] of Object.entries(harness.surfaces ?? {})) {
      if (surface.separately_billed_api && surface.machine_execution && surface.enabled_by_default !== false) {
        issues.push({ level: 'error', code: 'billing.api_surface_default', path: `${path}.surfaces.${surfaceName}`, message: `Separately billed machine surface ${id}.${surfaceName} must be disabled by default.` });
      }
    }
  }

  const kiro = capabilities.harnesses?.kiro;
  if (kiro?.preferred_execution_surface !== 'acp' || kiro.surfaces?.acp?.kind !== 'acp' || kiro.surfaces?.acp?.machine_execution !== true) {
    issues.push({ level: 'error', code: 'capabilities.kiro_acp', path: 'config/capabilities.yaml#harnesses.kiro', message: 'Kiro must use ACP as the preferred machine execution surface.' });
  }
  const perplexity = capabilities.harnesses?.perplexity;
  if (perplexity?.surfaces?.mcp_api && (perplexity.surfaces.mcp_api.separately_billed_api !== true || perplexity.surfaces.mcp_api.enabled_by_default !== false)) {
    issues.push({ level: 'error', code: 'capabilities.perplexity_paid_boundary', path: 'config/capabilities.yaml#harnesses.perplexity.surfaces.mcp_api', message: 'Perplexity automated MCP/API must remain explicitly separately billed and disabled by default.' });
  }

  return issues;
}

/** The parts of a catalog that passed the GateCatalog schema that the semantic checks read. */
type GateCatalog = { profiles: Record<string, { replaces?: string[]; detect?: { all_files?: string[]; any_file?: string[]; any_glob?: string[] }; gates: Array<{ id: string; command: string; args?: string[] }> }> };

// Gates validate; they never change infrastructure, state or credentials. Every gate tool
// has a fixed shape, checked positively: a command or argument this does not describe is
// refused, so a new spelling cannot slip past (inline interpreter code, package executors,
// wrappers, file-writing flags). Supporting another tool means describing its shape here.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
/** A path inside the repository: relative (no root, drive or UNC prefix), no `..` segment, plain characters. */
function repositoryRelative(path: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/\\-]*$/.test(path) && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes('..');
}
/**
 * A script the repository itself holds: no folder of installed dependencies (whose command
 * line programs could load code from anywhere, or download and run packages) and no hidden
 * folder (`.yarn/releases`, `.git`, tool caches). A segment ending in a dot is refused too:
 * Windows drops trailing dots, so `node_modules.` can name `node_modules` there.
 */
function repositoryScript(path: string): boolean {
  return repositoryRelative(path) && /\.[cm]?js$/.test(path)
    && !path.split(/[\\/]/).some((segment) => segment !== '.' && (segment.toLowerCase() === 'node_modules' || segment.startsWith('.') || segment.endsWith('.')));
}
// Terraform and OpenTofu: one optional `-chdir=<repository subfolder>`, then a read-only
// subcommand with only these flags (Go's flag parser stops at the first other argument,
// so a path or `--` before `-check` would silently drop it). Plan still runs provider
// plugins; see the terraform-plan disclosure in config/gates.yaml.
const TERRAFORM_FLAGS: Record<string, ReadonlySet<string>> = {
  fmt: new Set(['-check', '-recursive', '-diff', '-no-color']),
  validate: new Set(['-no-color', '-json']),
  plan: new Set(['-input=false', '-lock=false', '-no-color', '-refresh=false', '-detailed-exitcode', '-compact-warnings']),
  version: new Set(['-json']),
};
// Flags a subcommand must carry: fmt only checks; plan neither prompts nor takes the
// state lock (a plan stopped on timeout could leave it held).
const TERRAFORM_REQUIRED: Record<string, readonly string[]> = { fmt: ['-check'], plan: ['-input=false', '-lock=false'] };
const ANSIBLE_LINT_FLAGS: ReadonlySet<string> = new Set(['--offline', '--nocolor', '--parseable', '-p', '-q', '--strict']);

type GateShape = (args: readonly string[]) => string | undefined;
// `run env` is the package manager's own command (it prints the environment), not a script.
const packageScript: GateShape = (args) => (args.length === 1 && args[0] === 'test') || (args.length === 2 && args[0] === 'run' && SCRIPT_NAME.test(args[1] ?? '') && args[1] !== 'env')
  ? undefined : 'only `test` or `run <script>`, which run the repository\'s own scripts';
const terraformShape: GateShape = (args) => {
  const rest = args[0]?.startsWith('-chdir=') && repositoryRelative(args[0].slice('-chdir='.length)) ? args.slice(1) : args;
  const [subcommand = '', ...flags] = rest;
  const allowed = Object.hasOwn(TERRAFORM_FLAGS, subcommand) ? TERRAFORM_FLAGS[subcommand] : undefined;
  if (!allowed) return `only ${Object.keys(TERRAFORM_FLAGS).join(', ')}, after at most one -chdir=<repository subfolder>: gates check formatting, validate or plan, never change infrastructure`;
  const extra = flags.find((flag) => !allowed.has(flag));
  if (extra !== undefined) return `${subcommand} takes only ${[...allowed].join(' ')} here (not ${extra}): no paths, no files written, no other options`;
  const missing = (Object.hasOwn(TERRAFORM_REQUIRED, subcommand) ? TERRAFORM_REQUIRED[subcommand] ?? [] : []).filter((flag) => !flags.includes(flag));
  if (missing.length) return subcommand === 'fmt' ? 'fmt rewrites files unless -check is given; gates only check' : `plan needs ${missing.join(' ')}: a gate never prompts or takes the state lock`;
  return undefined;
};
const GATE_TOOLS: Record<string, GateShape> = {
  npm: packageScript,
  pnpm: packageScript,
  yarn: packageScript,
  node: (args) => (args[0] !== undefined && repositoryScript(args[0]) ? undefined : 'only a script file the repository holds as the first argument (no options, no inline code, nothing under node_modules, a hidden folder or a folder whose name ends in a dot)'),
  terraform: terraformShape,
  tofu: terraformShape,
  // --offline: without it, ansible-lint installs the collections and roles requirements.yml names.
  'ansible-lint': (args) => {
    const extra = args.find((arg) => !ANSIBLE_LINT_FLAGS.has(arg));
    if (extra !== undefined) return `only ${[...ANSIBLE_LINT_FLAGS].join(' ')} (not ${extra}): never --fix, no other options`;
    return args.includes('--offline') ? undefined : 'needs --offline: a gate never installs requirements';
  },
};

/** Why a gate command may never run, or undefined. Shared by `ccon validate` and the gate planner. */
export function gateCommandProblem(command: unknown, args: unknown = []): { code: string; message: string } | undefined {
  if (typeof command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return { code: 'gates.command', message: 'it must name a plain executable (no shell, no path)' };
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return { code: 'gates.command', message: 'args must be a list of strings' };
  const values = args as readonly string[];
  if (values.some((arg) => /^-?-auto-approve(=|$)/i.test(arg))) return { code: 'gates.auto_approve', message: 'auto-approval flags can never be part of a gate' };
  const name = command.toLowerCase().replace(/\.(exe|com|cmd|bat|ps1)$/, '');
  const shape = Object.hasOwn(GATE_TOOLS, name) ? GATE_TOOLS[name] : undefined;
  if (!shape) return { code: 'gates.tool', message: `${command} is not a gate tool (${Object.keys(GATE_TOOLS).join(', ')}); shells, wrappers and package executors never are, because they could run anything` };
  const problem = shape(values);
  if (problem) return { code: name === 'terraform' || name === 'tofu' ? 'gates.infrastructure_change' : 'gates.shape', message: `${command}: ${problem}` };
  return undefined;
}

type SchemaError = ContractValidationResult['errors'][number];
/** A key as shown in an issue path: quoted unless plain, so a `.` or a line break in a key cannot blur or forge the output. */
const keyLabel = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** A GateCatalog schema error as an issue at the exact key, for example `config/gates.yaml#profiles.node.gates.0.timeout`. */
function catalogIssue(error: SchemaError): ValidationIssue {
  const at = error.instancePath.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const params = error.params as Record<string, unknown>;
  const key = typeof params.additionalProperty === 'string' ? params.additionalProperty : error.propertyName;
  const segments = (key === undefined ? at : [...at, key]).map(keyLabel);
  const name = segments.join('.') || 'The catalog';
  const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : 'allowedValue' in params ? [params.allowedValue] : undefined;
  const message = error.keyword === 'additionalProperties' ? `${name} is not a key the gate catalog defines`
    : error.keyword === 'required' ? `${at.map(keyLabel).join('.') || 'The catalog'} needs ${String(params.missingProperty)}`
    : error.schemaPath.endsWith('/PlainName/pattern') ? `${name} must be a plain name: letters, digits, '.', '_' or '-', starting with a letter or digit`
    : allowed ? `${name} must be ${allowed.map(String).join(' or ')}`
    : ['minItems', 'minProperties', 'minLength'].includes(error.keyword) ? `${name} must not be empty`
    : `${name} ${error.message ?? 'is invalid'}`;
  return { level: 'error', code: 'gates.catalog', path: `config/gates.yaml${segments.length ? `#${segments.join('.')}` : ''}`, message: `${message}.` };
}

/**
 * Problems in a parsed gate catalog. Its shape is checked first, against the GateCatalog
 * JSON Schema (packages/schemas): every key, type and name, so a misspelt key such as
 * `timeout` is reported instead of ignored, and nothing the planner reads can make it
 * throw. Then what a schema cannot say: replaced profiles must exist, detection must name
 * files, and every gate command must fit its tool's shape.
 */
export function validateGateCatalog(catalog: unknown): ValidationIssue[] {
  let shape: ContractValidationResult;
  try { shape = validateContract('GateCatalog', catalog); } catch (error) {
    // Ajv recurses (uniqueItems compares nested values); input deep enough to exhaust the stack is reported.
    return [{ level: 'error', code: 'gates.catalog', path: 'config/gates.yaml', message: `The catalog could not be checked: ${error instanceof Error ? error.message : String(error)}.` }];
  }
  // Ajv reports a bad property name twice: the name's own error, then a summary.
  if (!shape.ok) return shape.errors.filter((error) => error.keyword !== 'propertyNames').map(catalogIssue);
  const { profiles } = catalog as GateCatalog;
  const names = new Set(Object.keys(profiles));
  const issues: ValidationIssue[] = [];
  for (const [name, profile] of Object.entries(profiles)) {
    const path = `config/gates.yaml#profiles.${keyLabel(name)}`;
    const unknown = (profile.replaces ?? []).filter((item) => !names.has(item));
    if (unknown.length) issues.push({ level: 'error', code: 'gates.replaces', path, message: `Profile ${name} replaces unknown profiles: ${unknown.join(', ')}.` });
    // Detection drops every profile something selected replaces, so replacing itself means never selected.
    if (profile.replaces?.includes(name)) issues.push({ level: 'error', code: 'gates.replaces', path, message: `Profile ${name} replaces itself, so it is never selected.` });
    // Detection selects a profile only when a file list matches; a package name alone never does.
    if (profile.detect && !profile.detect.all_files && !profile.detect.any_file && !profile.detect.any_glob) issues.push({ level: 'error', code: 'gates.catalog', path: `${path}.detect`, message: `Profile ${name} detect needs all_files, any_file or any_glob; package_name alone never selects it.` });
    for (const gate of profile.gates) {
      const problem = gateCommandProblem(gate.command, gate.args ?? []);
      if (problem) issues.push({ level: 'error', code: problem.code, path, message: `Gate ${gate.id} is not allowed: ${problem.message}.` });
    }
  }
  return issues;
}

export function validateRepositoryConfig(root: string): ValidationReport {
  const issues: ValidationIssue[] = [];

  for (const relativePath of requiredFiles) {
    if (!existsSync(join(root, relativePath))) {
      issues.push({ level: 'error', code: 'repo.missing_file', path: relativePath, message: `Missing required file: ${relativePath}` });
    }
  }
  if (issues.some((issue) => issue.code === 'repo.missing_file')) return { ok: false, issues };

  const apm = readYaml<ApmConfig>(root, 'apm.yml', issues);
  const capabilities = readYaml<CapabilityConfig>(root, 'config/capabilities.yaml', issues);
  const roles = readYaml<RolesConfig>(root, 'config/roles.yaml', issues);
  const risks = readYaml<RiskConfig>(root, 'config/risk.yaml', issues);
  const references = readYaml<ReferenceConfig>(root, 'config/references.yaml', issues);
  readYaml(root, 'config/authorities.yaml', issues);

  if (apm) {
    for (const target of requiredTargets) {
      if (!apm.targets?.includes(target)) {
        issues.push({ level: 'error', code: 'apm.missing_target', path: 'apm.yml', message: `APM target ${target} is required for the foundation.` });
      }
    }
    if (!Array.isArray(apm.dependencies?.apm) || !Array.isArray(apm.dependencies?.mcp)) {
      issues.push({ level: 'error', code: 'apm.dependencies_shape', path: 'apm.yml', message: 'APM dependencies must declare both apm and mcp arrays.' });
    }
  }

  if (capabilities) issues.push(...validateCapabilities(capabilities));
  // An empty file parses to null and is reported too; undefined means it did not parse.
  const gates = readYaml<unknown>(root, 'config/gates.yaml', issues);
  if (gates !== undefined) issues.push(...validateGateCatalog(gates));

  if (roles && risks) issues.push(...validatePolicyObjects(roles, risks));

  if (references?.policy?.blocking_findings_require_evidence !== true) {
    issues.push({ level: 'error', code: 'evidence.blocking_requirement', path: 'config/references.yaml', message: 'Blocking findings must require evidence.' });
  }

  return { ok: !issues.some((issue) => issue.level === 'error'), issues };
}

export { loadConfiguration, packagedConfigurationFingerprint } from './defaults.js';
export { ApprovalGate, approvalBlocker, approvalDigest, DEFAULT_APPROVAL_TTL_MS, type ApprovalDecision, type ApprovalGateOptions, type ApprovalOutcome, type Approver } from './approvals.js';
export type { ConfigurationName, ConfigurationSource, ConfigurationOptions } from './defaults.js';
