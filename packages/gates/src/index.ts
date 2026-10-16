import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfiguration } from '@code-conductor/policy';
import type { Evidence, GateResult } from '@code-conductor/schemas';

export interface GateDefinition {
  id: string;
  command: string;
  args?: string[];
  blocking?: boolean;
  timeout_ms?: number;
}

interface GateProfile {
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
}

export type CommandExecutor = (cwd: string, command: string, args: string[], timeoutMs: number) => CommandOutcome;

export interface GateExecution {
  profile: string;
  result: GateResult;
  evidence: Evidence;
  blocking: boolean;
}

function defaultExecutor(cwd: string, command: string, args: string[], timeoutMs: number): CommandOutcome {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: result.error?.name === 'ETIMEDOUT',
  };
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
    if (!detect) continue;
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
  return selected.includes('code-conductor') ? selected.filter((name) => name !== 'node') : selected;
}

export function runGates(root: string, profiles?: string[], executor: CommandExecutor = defaultExecutor): GateExecution[] {
  const config = loadGateConfig(root);
  const selected = profiles?.length ? profiles : detectGateProfiles(root, config);
  const executions: GateExecution[] = [];
  for (const profileName of selected) {
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`Unknown gate profile: ${profileName}`);
    for (const gate of profile.gates) {
      const timeout = gate.timeout_ms ?? config.default_timeout_ms ?? 600000;
      const outcome = executor(root, gate.command, gate.args ?? [], timeout);
      const passed = outcome.status === 0 && !outcome.timedOut;
      const evidenceId = `E-${randomUUID()}`;
      const combined = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n');
      const summary = passed
        ? `${gate.command} ${(gate.args ?? []).join(' ')} passed.`
        : `${gate.command} ${(gate.args ?? []).join(' ')} failed${outcome.timedOut ? ' (timeout)' : ` (exit ${String(outcome.status)})`}.`;
      const evidence: Evidence = {
        id: evidenceId,
        kind: 'test',
        source: `${gate.command} ${(gate.args ?? []).join(' ')}`.trim(),
        summary: combined ? `${summary}\n${combined.slice(0, 8000)}` : summary,
        sha256: createHash('sha256').update(combined).digest('hex'),
      };
      executions.push({
        profile: profileName,
        blocking: gate.blocking !== false,
        evidence,
        result: { gate: gate.id, status: passed ? 'passed' : 'failed', evidenceIds: [evidenceId], summary },
      });
    }
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
