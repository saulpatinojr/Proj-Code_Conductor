import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, opendirSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { absolutePathEnvironment, resolveExecutable, runIsolated } from '@code-conductor/core/processes';
import { gateCommandProblem, loadConfiguration } from '@code-conductor/policy';
import type { Evidence, GateResult } from '@code-conductor/schemas';

export { absolutePathEnvironment, resolveExecutable, type ResolvedExecutable } from '@code-conductor/core/processes';

export interface GateDefinition {
  id: string;
  command: string;
  args?: string[];
  blocking?: boolean;
  timeout_ms?: number;
  /** Checked before anything runs. Code Conductor never installs a missing prerequisite. */
  requires?: { commands?: string[]; paths?: string[]; any_paths?: string[] };
  /** Remediation shown when a prerequisite is missing. */
  remediation?: string;
  /** What running this gate can do beyond reading the repository, shown in its approval. */
  disclosure?: string;
}

interface GateProfile {
  /** `explicit` profiles (for example Terraform plan review) are never auto-detected. */
  selection?: 'detected' | 'explicit';
  /** Generic profiles this more specific profile supersedes when both are detected. */
  replaces?: string[];
  detect?: {
    package_name?: string;
    all_files?: string[];
    any_file?: string[];
    any_glob?: string[];
  };
  gates: GateDefinition[];
}

interface GateConfig {
  version: number;
  default_timeout_ms?: number;
  profiles: Record<string, GateProfile>;
}

export interface CommandOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Output beyond the capture limit was discarded. */
  truncated?: boolean;
  /** SHA-256 over the full, untruncated output; computed from the captured text when absent. */
  sha256?: string;
}

/**
 * Runs one gate. `command` is the catalog name (for display); `executable` is the
 * absolute file it resolved to, which is what the default executor runs.
 */
export type CommandExecutor = (cwd: string, command: string, args: string[], timeoutMs: number, executable: string) => CommandOutcome | Promise<CommandOutcome>;

export interface GateExecution {
  profile: string;
  result: GateResult;
  evidence: Evidence;
  blocking: boolean;
}

/** One executed gate's output, offered to the caller before the evidence record is written. */
export interface GateOutputContext {
  evidenceId: string;
  profile: string;
  gate: GateDefinition;
  commandLine: string;
  executable: string;
  outcome: CommandOutcome;
  passed: boolean;
  /** The verdict line the evidence summary starts with; the verdict never comes from the output text. */
  headline: string;
  /** Digest recorded in the evidence: the runner's full-output digest, or one over the combined text. */
  sha256: string;
  /** stdout and stderr, trimmed and joined, as the default evidence shows them (bounded). */
  combined: string;
}

export interface GateExecutionOptions {
  /**
   * Called for each gate that ran. It may store the full output (returning its `uri`)
   * and replace the bounded text shown under the headline (#94). The verdict, the
   * digest and the headline are not its to change. A thrown error fails the gate's
   * evidence closed with the error in its summary; the gate's status is unaffected.
   */
  render?: (context: GateOutputContext) => { text?: string; uri?: string } | undefined;
}

/** Characters of combined output the default evidence record shows under the headline. */
export const BOUNDED_OUTPUT_CHARS = 8000;

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * Gate commands are the target repository's own scripts. They run without a shell, in
 * their own isolated process group shared with provider clients' reaper (no controlling
 * terminal; terminated on timeout, after exit, and when Code Conductor exits or is
 * interrupted), with captured output bounded to 4 MiB per stream and the evidence digest
 * covering all of it. A descendant that leaves the group can outlive the gate; see
 * @code-conductor/core/processes.
 */
async function defaultExecutor(cwd: string, _command: string, args: string[], timeoutMs: number, executable: string): Promise<CommandOutcome> {
  return runIsolated(executable, args, { cwd, env: absolutePathEnvironment(), timeoutMs, maxBytes: MAX_CAPTURE });
}

/** Whether a plain command resolves to an executable on an absolute PATH entry (no `which`, no shell). */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveExecutable(command, env).path);
}

export interface GateDiscoveryLimits { maxEntries: number; maxDepth: number }
/** Optional preview-only bounds; execution's existing discovery remains unchanged. */
function boundedFiles(root: string, limits: GateDiscoveryLimits): string[] {
  const files: string[] = [];
  let entries = 0;
  function walk(folder: string, depth: number): void {
    if (depth > limits.maxDepth) throw new Error('Gate preview discovery depth exceeded.');
    const directory = opendirSync(folder);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++entries > limits.maxEntries) throw new Error('Gate preview discovery entry budget exceeded.');
        if (['.git', 'node_modules', 'dist', '.terraform'].includes(entry.name)) continue;
        const full = join(folder, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else files.push(relative(root, full).replaceAll('\\', '/'));
      }
    } finally { directory.closeSync(); }
  }
  walk(root, 0);
  return files;
}
function listFiles(root: string): string[] {
  const output: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', '.terraform'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else output.push(relative(root, full).replaceAll('\\', '/'));
    }
  }
  walk(root);
  return output;
}

export function globMatch(path: string, pattern: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      expression += '(?:.*/)?';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      expression += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      expression += '[^/]*';
      continue;
    }
    if (char === '?') {
      expression += '[^/]';
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/.test(char ?? '') ? `\\${char}` : char;
  }
  expression += '$';
  return new RegExp(expression).test(path);
}

export function loadGateConfig(root: string): GateConfig {
  return loadConfiguration<GateConfig>(root, 'gates').document;
}

export function detectGateProfiles(root: string, config = loadGateConfig(root), discoveryLimits?: GateDiscoveryLimits): string[] {
  let files: string[] | undefined;
  const selected: string[] = [];
  for (const [name, profile] of Object.entries(config.profiles)) {
    const detect = profile.detect;
    if (!detect || profile.selection === 'explicit') continue;
    if (detect.package_name) {
      try {
        const path = join(root, 'package.json');
        const content = readBoundedFile(path, 1048576);
        if (JSON.parse(content.toString('utf8')).name !== detect.package_name) continue;
      } catch { continue; }
    }
    const allFiles = detect.all_files?.every((file) => existsSync(join(root, file))) ?? false;
    const anyFile = detect.any_file?.some((file) => existsSync(join(root, file))) ?? false;
    const anyGlob = detect.any_glob?.length
      ? detect.any_glob.some((pattern) => (files ??= discoveryLimits ? boundedFiles(root, discoveryLimits) : listFiles(root)).some((file) => globMatch(file, pattern)))
      : false;
    if (allFiles || anyFile || anyGlob) selected.push(name);
  }
  const replaced = new Set(selected.flatMap((name) => config.profiles[name]?.replaces ?? []));
  return selected.filter((name) => !replaced.has(name));
}

/** Why a gate may never run (shared with `ccon validate`), or undefined. */
export function forbiddenGateReason(gate: GateDefinition): string | undefined {
  return gateCommandProblem(gate.command, gate.args ?? [])?.message;
}

export interface PlannedGate {
  profile: string;
  gate: GateDefinition;
  timeoutMs: number;
  /** Unmet prerequisites; a gate with any is reported as a blocking failure and never executed. */
  missing: string[];
  /** The profile was chosen explicitly rather than detected. */
  explicit: boolean;
  /** Absolute file the command resolved to; this exact file is what runs and what approval binds. */
  executable?: string;
  /** Arguments placed before the gate's own when `executable` is an interpreter running the command's script (Windows npm and npx, D-074); bound by the approval too. */
  prefixArgs?: string[];
}

function missingPrerequisites(root: string, gate: GateDefinition): string[] {
  const missing: string[] = [];
  for (const command of new Set([gate.command, ...(gate.requires?.commands ?? [])])) {
    const resolved = resolveExecutable(command);
    if (!resolved.path) missing.push(resolved.problem ?? `command \`${command}\` not found on PATH`);
  }
  for (const path of gate.requires?.paths ?? []) if (!existsSync(join(root, path))) missing.push(`${path} not present`);
  const any = gate.requires?.any_paths ?? [];
  if (any.length && !any.some((path) => existsSync(join(root, path)))) missing.push(`none of ${any.join(', ')} present`);
  return missing;
}

/**
 * The exact commands executeGatePlan would execute, without executing anything (used
 * to bind pre-action approval). Explicitly selected profiles are used as given;
 * otherwise profiles are detected. Forbidden infrastructure-changing commands throw.
 */
export function planGates(root: string, profiles?: string[], config = loadGateConfig(root), discoveryLimits?: GateDiscoveryLimits): PlannedGate[] {
  const explicit = Boolean(profiles?.length);
  const selected = explicit ? [...new Set(profiles)] : detectGateProfiles(root, config, discoveryLimits);
  return selected.flatMap((profileName) => {
    const profile = Object.hasOwn(config.profiles, profileName) ? config.profiles[profileName] : undefined;
    if (!profile) throw new Error(`Unknown gate profile: ${profileName}. Available: ${Object.keys(config.profiles).join(', ')}.`);
    return profile.gates.map((gate) => {
      const forbidden = forbiddenGateReason(gate);
      if (forbidden) throw new Error(`Gate ${profileName}/${gate.id} is not allowed: ${forbidden}`);
      const resolved = resolveExecutable(gate.command);
      return { profile: profileName, gate, timeoutMs: gate.timeout_ms ?? config.default_timeout_ms ?? 600000, missing: missingPrerequisites(root, gate), explicit, ...(resolved.path ? { executable: resolved.path } : {}), ...(resolved.prefixArgs?.length ? { prefixArgs: [...resolved.prefixArgs] } : {}) };
    });
  });
}

export async function runGates(root: string, profiles?: string[], executor: CommandExecutor = defaultExecutor, options: GateExecutionOptions = {}): Promise<GateExecution[]> {
  return executeGatePlan(root, planGates(root, profiles), executor, options);
}

/** Execute exactly the planned commands, so an approval bound to a plan covers what runs. */
export async function executeGatePlan(root: string, plan: readonly PlannedGate[], executor: CommandExecutor = defaultExecutor, options: GateExecutionOptions = {}): Promise<GateExecution[]> {
  const executions: GateExecution[] = [];
  for (const item of plan) {
    const { profile, gate, timeoutMs } = item;
    const commandLine = `${gate.command} ${(gate.args ?? []).join(' ')}`.trim();
    // A hand-built plan may carry an absolute command; anything else is resolved now.
    const executable = item.executable ?? (isAbsolute(gate.command) ? gate.command : resolveExecutable(gate.command).path);
    const missing = executable ? item.missing : [...new Set([...item.missing, `command \`${gate.command}\` not found on PATH`])];
    if (missing.length) {
      // Always blocking, advisory gates included: a gate that could not run validated nothing.
      const evidenceId = `E-${randomUUID()}`;
      const summary = `${commandLine} was not run: prerequisite missing (${missing.join('; ')}).${gate.remediation ? ` ${gate.remediation}` : ''} Code Conductor does not install prerequisites.`;
      executions.push({ profile, blocking: true, result: { blocking: true, gate: gate.id, status: 'failed', evidenceIds: [evidenceId], summary }, evidence: { id: evidenceId, kind: 'test', source: commandLine, summary, sha256: createHash('sha256').update('').digest('hex') } });
      continue;
    }
    // What actually starts: the resolved file, then any interpreter arguments the resolution
    // added (Windows npm and npx), then the gate's own arguments.
    const prefixArgs = item.prefixArgs ?? [];
    const launched = [executable!, ...prefixArgs].join(' ');
    const outcome = await executor(root, gate.command, [...prefixArgs, ...(gate.args ?? [])], timeoutMs, executable!);
    const passed = outcome.status === 0 && !outcome.timedOut;
    const evidenceId = `E-${randomUUID()}`;
    const combined = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n');
    const summary = `${passed
      ? `${commandLine} passed.`
      : `${commandLine} failed${outcome.timedOut ? ' (timeout)' : ` (exit ${String(outcome.status)})`}.`}${outcome.truncated ? ' Output exceeded the capture limit and was truncated.' : ''}`;
    const digest = outcome.sha256 ?? createHash('sha256').update(combined).digest('hex');
    let text = combined.slice(0, BOUNDED_OUTPUT_CHARS);
    let uri: string | undefined;
    if (options.render) {
      try {
        const rendered = options.render({ evidenceId, profile, gate, commandLine, executable: launched, outcome, passed, headline: summary, sha256: digest, combined });
        if (rendered?.text !== undefined) text = rendered.text;
        if (rendered?.uri) uri = rendered.uri;
      } catch (error) {
        text = `${combined.slice(0, BOUNDED_OUTPUT_CHARS)}\n[The full output could not be stored or summarised: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    const evidence: Evidence = {
      id: evidenceId,
      kind: 'test',
      source: `${commandLine} (${launched})`,
      summary: text ? `${summary}\n${text}` : summary,
      ...(uri ? { uri } : {}),
      sha256: digest,
    };
    executions.push({
      profile,
      blocking: gate.blocking !== false,
      evidence,
      result: { blocking: gate.blocking !== false, gate: gate.id, status: passed ? 'passed' : 'failed', evidenceIds: [evidenceId], summary },
    });
  }
  const id = `E-${randomUUID()}`;
  const empty = createHash('sha256').update('').digest('hex');
  if (!executions.length) {
    const summary = 'No applicable deterministic validation gates; readiness is blocked.';
    executions.push({ profile: 'unmatched', blocking: true, result: { blocking: true, gate: 'no-applicable-gates', status: 'failed', evidenceIds: [id], summary }, evidence: { id, kind: 'test', source: 'gate-selection', summary, sha256: empty } });
  } else if (!executions.some((execution) => execution.blocking)) {
    // Advisory gates alone (for example an explicitly chosen plan review) never establish readiness.
    const summary = 'No blocking deterministic gate ran and passed; advisory gates alone never establish readiness. Choose a blocking profile too, for example `--gate-profiles terraform,terraform-plan`.';
    executions.push({ profile: 'unmatched', blocking: true, result: { blocking: true, gate: 'no-blocking-gate-passed', status: 'failed', evidenceIds: [id], summary }, evidence: { id, kind: 'test', source: 'gate-selection', summary, sha256: empty } });
  }
  return executions;
}

export function blockingGateFailure(executions: readonly GateExecution[]): boolean {
  return executions.some((item) => item.blocking && item.result.status === 'failed');
}
