import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkstationStore } from '../../packages/workstation/src/index.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('workstation trust store', () => {
  it('persists surface-specific trust with owner-only permissions on POSIX systems', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-workstation-test-'));
    const stateDir = join(root, 'state');
    const statePath = join(stateDir, 'workstation.json');
    try {
      const store = new WorkstationStore(statePath);
      store.record('codex', 'modify', 'test-version', 'isolated smoke passed', 'cli');

      expect(store.isTrusted('codex', 'read', 'cli')).toBe(true);
      expect(store.isTrusted('codex', 'modify', 'cli')).toBe(true);
      expect(store.isTrusted('codex', 'read', 'acp')).toBe(false);
      expect(store.load().harnesses['codex@cli']?.clientVersion).toBe('test-version');

      if (process.platform !== 'win32') {
        expect(mode(stateDir)).toBe(0o700);
        expect(mode(statePath)).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds trust to the client version the smoke test ran against', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-workstation-version-'));
    try {
      const store = new WorkstationStore(join(root, 'workstation.json'));
      store.record('claude', 'modify', '2.1.300', 'modify smoke passed', 'cli');
      expect(store.isTrusted('claude', 'modify', 'cli', '2.1.300')).toBe(true);
      // An upgrade is not trusted until its own smoke test passes.
      expect(store.isTrusted('claude', 'read', 'cli', '2.1.301')).toBe(false);
      // A version Code Conductor could not read never matches a recorded one.
      expect(store.isTrusted('claude', 'read', 'cli', '')).toBe(false);
      // A read smoke on the new version does not carry the old modify validation over.
      store.record('claude', 'read', '2.1.301', 'read smoke passed', 'cli');
      expect(store.isTrusted('claude', 'read', 'cli', '2.1.301')).toBe(true);
      expect(store.isTrusted('claude', 'modify', 'cli', '2.1.301')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy v1 trust to CLI only and never authorizes a new ACP surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-workstation-migrate-'));
    const statePath = join(root, 'workstation.json');
    try {
      writeFileSync(statePath, `${JSON.stringify({ version: 1, harnesses: { kiro: { readValidatedAt: '2026-09-01T00:00:00.000Z', clientVersion: 'legacy' } } })}\n`);
      const store = new WorkstationStore(statePath);

      expect(store.isTrusted('kiro', 'read', 'cli')).toBe(true);
      expect(store.isTrusted('kiro', 'read', 'acp')).toBe(false);
      expect(store.load().version).toBe(2);
      expect(store.load().harnesses['kiro@cli']?.clientVersion).toBe('legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
