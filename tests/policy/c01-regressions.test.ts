import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGates, blockingGateFailure } from '../../packages/gates/src/index.js';
import { workspaceFingerprint, startupSnapshot } from '../../apps/vscode/src/startup.js';

it('blocks readiness when no configured gate applies without executing anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-no-gates-'));
  try {
    let calls = 0;
    const results = await runGates(root, undefined, () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; });
    expect(calls).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]?.result.gate).toBe('no-applicable-gates');
    expect(blockingGateFailure(results)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('invalidates warm startup after user-level preferences change or disappear', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-workspace-fingerprint-'));
  const user = mkdtempSync(join(tmpdir(), 'cc-user-fingerprint-'));
  try {
    const before = workspaceFingerprint(root, user);
    mkdirSync(join(user, '.code-conductor'));
    const file = join(user, '.code-conductor', 'config.json');
    writeFileSync(file, '{"version":1,"disabledHarnesses":["codex"]}');
    const changed = workspaceFingerprint(root, user);
    expect(changed).not.toBe(before);
    expect(startupSnapshot(root, before, user).mode).toBe('config_changed');
    expect(startupSnapshot(root, changed, user).mode).toBe('warm');
    rmSync(file);
    expect(workspaceFingerprint(root, user)).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(user, { recursive: true, force: true }); }
});
