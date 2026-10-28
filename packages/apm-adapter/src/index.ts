import { absolutePathEnvironment, resolveExecutable } from '@code-conductor/core/processes';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ApmCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  errorCode?: string;
}

export interface ApmRunOptions {
  /** Finite wall-clock bound; defaults to two minutes (ten for install). */
  timeoutMs?: number;
  /** Maximum bytes per captured stream. Defaults to 4 MiB. */
  maxBufferBytes?: number;
}

function bounded(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function run(root: string, args: string[], options: ApmRunOptions = {}): ApmCommandResult {
  const timeout = bounded(options.timeoutMs ?? 120000, 900000, 'APM timeoutMs');
  const maxBuffer = bounded(options.maxBufferBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024, 'APM maxBufferBytes');
  const executable = resolveExecutable('apm');
  if (!executable.path) return { ok: false, status: null, stdout: '', stderr: executable.problem ?? 'APM not found on an absolute PATH entry.', timedOut: false, outputLimitExceeded: false, errorCode: 'ENOENT' };
  const result = spawnSync(executable.path, args, {
    cwd: root, env: absolutePathEnvironment(), encoding: 'utf8', shell: false, windowsHide: true,
    timeout, maxBuffer, killSignal: 'SIGKILL',
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errorCode === 'ETIMEDOUT';
  const outputLimitExceeded = errorCode === 'ENOBUFS';
  const reason = timedOut
    ? 'APM exceeded its time limit. Partial changes may remain; inspect the diff before retrying.'
    : outputLimitExceeded
      ? 'APM exceeded its output limit. Partial changes and incomplete output may remain; inspect the diff before retrying. This operation did not succeed.'
      : result.error?.message;
  const stderr = [result.stderr || '', reason || ''].filter(Boolean).join('\n');
  return {
    ok: result.status === 0 && !result.error && !result.signal,
    status: result.status,
    stdout: result.stdout || '',
    stderr,
    timedOut,
    outputLimitExceeded,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function apmVersion(root: string): ApmCommandResult {
  return run(root, ['--version'], { timeoutMs: 5000, maxBufferBytes: 4096 });
}

export function apmTargets(root: string, options?: ApmRunOptions): ApmCommandResult {
  return run(root, ['targets'], options);
}

export function apmInstall(root: string, options: ApmRunOptions = {}): ApmCommandResult {
  // No retries: install is side-effecting and may have partially changed files.
  // Callers must obtain action-specific approval before invoking this boundary.
  return run(root, ['install'], { ...options, timeoutMs: options.timeoutMs ?? 600000 });
}

export function apmAudit(root: string, options?: ApmRunOptions): ApmCommandResult {
  return run(root, ['audit', '--ci', '--policy', './apm-policy.yml', '--no-fail-fast'], options);
}

export function apmLockPresent(root: string): boolean {
  return existsSync(join(root, 'apm.lock.yaml'));
}

export {
  apmLockDeployedFiles,
  inventoryNativeCustomizations,
  type NativeEcosystem,
  type NativeInventory,
  type NativeInventoryEntry,
  type NativeKind,
  type NativeScope,
} from './inventory.js';

export { PREVIEW_PACKS, previewPacks, comparePackProjections, type PreviewPack, type ProjectionPreview, type ProjectionChange } from './projection-preview.js';
