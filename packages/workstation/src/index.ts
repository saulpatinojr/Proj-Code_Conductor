import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type HarnessTrustMode = 'read' | 'modify';

export interface HarnessValidationRecord {
  readValidatedAt?: string;
  modifyValidatedAt?: string;
  clientVersion?: string;
  notes?: string[];
}

export interface WorkstationState {
  version: 2;
  harnesses: Record<string, HarnessValidationRecord>;
}

type LegacyWorkstationState = {
  version: 1;
  harnesses?: Record<string, HarnessValidationRecord>;
};

export function workstationStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODE_CONDUCTOR_WORKSTATION_STATE || join(env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'workstation.json');
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function trustKey(harness: string, surface: string): string {
  return `${harness}@${surface}`;
}

export class WorkstationStore {
  constructor(public readonly path = workstationStatePath()) {}

  load(): WorkstationState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as WorkstationState | LegacyWorkstationState;
      if (parsed.version === 2 && parsed.harnesses) return parsed;
      if (parsed.version === 1 && parsed.harnesses) {
        // v1 trust was recorded only for the original generic CLI adapters. Do
        // not allow it to authorize a new ACP/native surface accidentally.
        return {
          version: 2,
          harnesses: Object.fromEntries(Object.entries(parsed.harnesses).map(([harness, record]) => [trustKey(harness, 'cli'), record])),
        };
      }
      return { version: 2, harnesses: {} };
    } catch {
      return { version: 2, harnesses: {} };
    }
  }

  save(state: WorkstationState): void {
    ensurePrivateDirectory(dirname(this.path));
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }

  /**
   * Whether the harness passed the smoke test for this mode on this surface. With the
   * installed client's version, also that the smoke test ran against that version: an
   * upgrade can change the client's sandbox and permission behaviour, so trust does not
   * carry over to it.
   */
  isTrusted(harness: string, mode: HarnessTrustMode, surface = 'cli', clientVersion?: string): boolean {
    const record = this.load().harnesses[trustKey(harness, surface)];
    const validated = mode === 'read' ? Boolean(record?.readValidatedAt || record?.modifyValidatedAt) : Boolean(record?.modifyValidatedAt);
    return validated && (clientVersion === undefined || record?.clientVersion === clientVersion);
  }

  record(harness: string, mode: HarnessTrustMode, clientVersion?: string, note?: string, surface = 'cli'): void {
    const state = this.load();
    const key = trustKey(harness, surface);
    const existing = state.harnesses[key] ?? {};
    const now = new Date().toISOString();
    // A smoke test on another client version invalidates what was validated before it.
    if (existing.clientVersion !== undefined && existing.clientVersion !== clientVersion) {
      delete existing.readValidatedAt;
      delete existing.modifyValidatedAt;
    }
    if (mode === 'read') existing.readValidatedAt = now;
    else {
      existing.readValidatedAt ??= now;
      existing.modifyValidatedAt = now;
    }
    if (clientVersion) existing.clientVersion = clientVersion;
    else delete existing.clientVersion;
    if (note) existing.notes = [...(existing.notes ?? []), note].slice(-10);
    state.harnesses[key] = existing;
    this.save(state);
  }
}
