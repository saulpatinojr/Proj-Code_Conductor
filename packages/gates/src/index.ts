import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfiguration } from '@code-conductor/policy';
import type { Evidence, GateResult } from '@code-conductor/schemas';

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
  /** Output beyond the capture limit was discarded (the evidence hash covers what was captured). */
  truncated?: boolean;
}

export type CommandExecutor = (cwd: string, command: string, args: string[], timeoutMs: number) => CommandOutcome | Promise<CommandOutcome>;

export interface GateExecution {
  profile: string;
  result: GateResult;
  evidence: Evidence;
  blocking: boolean;
}

const MAX_CAPTURE = 4 * 1024 * 1024;
const ISOLATE = process.platform !== 'win32';

/**
 * Gate commands are the target repository's own scripts. They run without a shell,
 * in their own session/process group on POSIX (no controlling terminal, so they
 * cannot draw over an approval prompt), with captured output bounded, and the
 * whole group is terminated on timeout and after exit so nothing outlives the gate.
 */
function defaultExecutor(cwd: string, command: string, args: string[], timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, detached: ISOLATE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CAPTURE) { truncated = true; return current; }
      const text = chunk.toString('utf8');
      if (current.length + text.length > MAX_CAPTURE) truncated = true;
      return current + text.slice(0, MAX_CAPTURE - current.length);
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (ISOLATE && child.pid) { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } }
      else child.kill(signal);
    };
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalGroup('SIGKILL');
      resolve(outcome);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (error) => finish({ status: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`, timedOut, truncated }));
    child.on('close', (status) => finish({ status, stdout, stderr, timedOut, truncated }));
  });
}

/** PATH lookup without running anything (no `which`, no shell). */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return false;
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
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

export function detectGateProfiles(root: string, config = loadGateConfig(root)): string[] {
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
      ? detect.any_glob.some((pattern) => (files ??= listFiles(root)).some((file) => globMatch(file, pattern)))
      : false;
    if (allFiles || anyFile || anyGlob) selected.push(name);
  }
  const replaced = new Set(selected.flatMap((name) => config.profiles[name]?.replaces ?? []));
  return selected.filter((name) => !replaced.has(name));
}

// Terraform subcommands that change real infrastructure or state. Validation and plan
// review are deterministic gates; applying changes is a production action that belongs
// to a native pipeline with its own approval, never to a gate profile.
const TERRAFORM_FORBIDDEN = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'state', 'force-unlock', 'workspace', 'login', 'logout']);
export function forbiddenGateReason(gate: GateDefinition): string | undefined {
  const args = gate.args ?? [];
  if (['terraform', 'tofu'].includes(gate.command)) {
    const subcommand = args.find((arg) => !arg.startsWith('-'));
    if (subcommand && TERRAFORM_FORBIDDEN.has(subcommand)) return `${gate.command} ${subcommand} changes infrastructure or state and can never be a gate.`;
  }
  if (args.some((arg) => /^-?-auto-approve(=|$)/.test(arg))) return 'Auto-approval flags can never be part of a gate.';
  return undefined;
}

export interface PlannedGate {
  profile: string;
  gate: GateDefinition;
  timeoutMs: number;
  /** Unmet prerequisites; a gate with any is reported as failed and never executed. */
  missing: string[];
  /** The profile was chosen explicitly rather than detected. */
  explicit: boolean;
}

function missingPrerequisites(root: string, gate: GateDefinition): string[] {
  const missing: string[] = [];
  for (const command of new Set([gate.command, ...(gate.requires?.commands ?? [])])) if (!commandOnPath(command)) missing.push(`command \`${command}\` not found on PATH`);
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
export function planGates(root: string, profiles?: string[], config = loadGateConfig(root)): PlannedGate[] {
  const explicit = Boolean(profiles?.length);
  const selected = explicit ? [...new Set(profiles)] : detectGateProfiles(root, config);
  return selected.flatMap((profileName) => {
    const profile = Object.hasOwn(config.profiles, profileName) ? config.profiles[profileName] : undefined;
    if (!profile) throw new Error(`Unknown gate profile: ${profileName}. Available: ${Object.keys(config.profiles).join(', ')}.`);
    return profile.gates.map((gate) => {
      const forbidden = forbiddenGateReason(gate);
      if (forbidden) throw new Error(`Gate ${profileName}/${gate.id} is not allowed: ${forbidden}`);
      return { profile: profileName, gate, timeoutMs: gate.timeout_ms ?? config.default_timeout_ms ?? 600000, missing: missingPrerequisites(root, gate), explicit };
    });
  });
}

export async function runGates(root: string, profiles?: string[], executor: CommandExecutor = defaultExecutor): Promise<GateExecution[]> {
  return executeGatePlan(root, planGates(root, profiles), executor);
}

/** Execute exactly the planned commands, so an approval bound to a plan covers what runs. */
export async function executeGatePlan(root: string, plan: readonly PlannedGate[], executor: CommandExecutor = defaultExecutor): Promise<GateExecution[]> {
  const executions: GateExecution[] = [];
  for (const { profile, gate, timeoutMs, missing } of plan) {
    const commandLine = `${gate.command} ${(gate.args ?? []).join(' ')}`.trim();
    if (missing.length) {
      const evidenceId = `E-${randomUUID()}`;
      const summary = `${commandLine} was not run: prerequisite missing (${missing.join('; ')}).${gate.remediation ? ` ${gate.remediation}` : ''} Code Conductor does not install prerequisites.`;
      executions.push({ profile, blocking: gate.blocking !== false, result: { gate: gate.id, status: 'failed', evidenceIds: [evidenceId], summary }, evidence: { id: evidenceId, kind: 'test', source: commandLine, summary, sha256: createHash('sha256').update('').digest('hex') } });
      continue;
    }
    const outcome = await executor(root, gate.command, gate.args ?? [], timeoutMs);
    const passed = outcome.status === 0 && !outcome.timedOut;
    const evidenceId = `E-${randomUUID()}`;
    const combined = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n');
    const summary = `${passed
      ? `${commandLine} passed.`
      : `${commandLine} failed${outcome.timedOut ? ' (timeout)' : ` (exit ${String(outcome.status)})`}.`}${outcome.truncated ? ' Output exceeded the capture limit and was truncated.' : ''}`;
    const evidence: Evidence = {
      id: evidenceId,
      kind: 'test',
      source: commandLine,
      summary: combined ? `${summary}\n${combined.slice(0, 8000)}` : summary,
      sha256: createHash('sha256').update(combined).digest('hex'),
    };
    executions.push({
      profile,
      blocking: gate.blocking !== false,
      evidence,
      result: { gate: gate.id, status: passed ? 'passed' : 'failed', evidenceIds: [evidenceId], summary },
    });
  }
  if (!executions.length) {
    const id = `E-${randomUUID()}`;
    const summary = 'No applicable deterministic validation gates; readiness is blocked.';
    executions.push({ profile: 'unmatched', blocking: true, result: { gate: 'no-applicable-gates', status: 'failed', evidenceIds: [id], summary }, evidence: { id, kind: 'test', source: 'gate-selection', summary, sha256: createHash('sha256').update('').digest('hex') } });
  }
  return executions;
}

export function blockingGateFailure(executions: GateExecution[]): boolean {
  return executions.some((item) => item.blocking && item.result.status === 'failed');
}
