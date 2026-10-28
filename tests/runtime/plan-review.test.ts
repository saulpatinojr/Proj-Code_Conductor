import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { validateContract } from '../../packages/schemas/src/index.js';
import { FakeAdapter } from './fixtures.js';

describe('historical plan-review snapshots', () => {
  it('persists the snapshot without starting a provider or gate and keeps legacy manifests readable', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-plan-review-'));
    try {
      const store = new RunStore(join(temp, 'private'));
      const codex = new FakeAdapter('codex', 'openai');
      const claude = new FakeAdapter('claude', 'anthropic');
      const start = vi.spyOn(codex, 'execute'); const gate = vi.fn();
      const outcome = await executeTask(temp, createTask('Debug failing tests', 'R1', temp), { execute: false, store, adapters: new Map([['codex', codex], ['claude', claude]]), gateExecutor: gate });
      const stored = JSON.parse(readFileSync(outcome.manifestPath, 'utf8'));
      expect(stored.planReview).toEqual(outcome.plan.planReview);
      expect(stored.planReview.specializations.source).toBe('objective_signals');
      expect(stored.planReview.checks).toEqual({ state: 'recorded', selection: 'detected', gates: [] });
      expect(start).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
      expect(readdirSync(temp)).toEqual(['private']);
      expect(validateContract('RunManifest', stored).ok).toBe(true);
      const unavailable = await executeTask(temp, createTask('Test', 'R0', temp), { execute: false, store, adapters: new Map() });
      expect(unavailable.plan.planReview.providers.every((item) => item.inventory === 'absent')).toBe(true);
      // Discovery records an empty set without changing the existing fallback routing.
      expect(unavailable.plan.assignments.length).toBeGreaterThan(0);
      delete stored.planReview;
      expect(validateContract('RunManifest', stored).ok).toBe(true);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('keeps a plan available while refusing an incomplete over-depth gate preview', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-plan-depth-'));
    try {
      mkdirSync(join(temp, ...Array.from({ length: 14 }, (_, index) => `depth-${index}`)), { recursive: true });
      const outcome = await executeTask(temp, createTask('Test', 'R0', temp), { execute: false, store: new RunStore(join(temp, 'private')), adapters: new Map() });
      expect(outcome.plan.assignments.length).toBeGreaterThan(0);
      expect(outcome.manifest.planReview!.checks.state).toBe('unavailable');
      expect(outcome.manifest.planReview!.checks.gates).toEqual([]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it('rejects unknown snapshot versions, invalid inventory states and invalid check metadata', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-plan-schema-'));
    try {
      const outcome = await executeTask(resolve('.'), createTask('Test', 'R0', resolve('.')), { execute: false, store: new RunStore(temp), adapters: new Map([['codex', new FakeAdapter('codex', 'openai')]]) });
      const valid = outcome.manifest;
      expect(validateContract('RunManifest', valid).ok).toBe(true);
      for (const mutate of [
        (snapshot: any) => { snapshot.version = 2; },
        (snapshot: any) => { snapshot.providers[0].inventory = 'trusted'; },
        (snapshot: any) => { snapshot.checks.gates[0].configuredBlocking = 'false'; },
        (snapshot: any) => { snapshot.checks.gates[0].timeoutMs = -1; },
      ]) {
        const invalid = structuredClone(valid); mutate(invalid.planReview);
        expect(validateContract('RunManifest', invalid).ok).toBe(false);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
