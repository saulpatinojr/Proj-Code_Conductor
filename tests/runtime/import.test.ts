import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../packages/evidence/src/index.js';
import { importRunManifest } from '../../packages/runtime/src/import.js';

const dirs: string[] = [];
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), 'cc-import-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'wf-20261008-demo',
    task: { id: 'wf-20261008-demo', objective: 'Imported from Code Workflow', acceptanceCriteria: [], risk: 'R1', constraints: ['Executed by Code Workflow inside one client'], createdAt: '2026-10-08T06:00:00Z' },
    assignments: [{ id: 'wf-20261008-demo:azure-architect', taskId: 'wf-20261008-demo', agentId: 'azure-architect', role: 'specialist', stance: 'neutral', provider: 'anthropic', harness: 'claude', billingChannel: 'subscription', authority: ['recommend'], dependsOn: [] }],
    results: [{ taskId: 'wf-20261008-demo', assignmentId: 'wf-20261008-demo:azure-architect', agentId: 'azure-architect', role: 'specialist', stance: 'neutral', provider: 'anthropic', harness: 'claude', billingChannel: 'subscription', status: 'completed', changes: [], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'review', notVerified: ['Live deployment was not performed.'] }],
    gates: [],
    ...overrides,
  };
}
function writeManifest(value: unknown): string { const file = join(scratch(), 'run-manifest.json'); writeFileSync(file, JSON.stringify(value)); return file; }

describe('external run manifest import', () => {
  it('stores a valid manifest under an import- prefixed run id with an import event', () => {
    const store = new RunStore(join(scratch(), 'runs'));
    const outcome = importRunManifest(writeManifest(manifest()), { store, source: 'code-workflow' });
    expect(outcome.runId).toBe('import-wf-20261008-demo');
    const saved = JSON.parse(readFileSync(outcome.manifestPath, 'utf8')) as { runId: string; results: Array<{ notVerified?: string[] }> };
    expect(saved.runId).toBe('import-wf-20261008-demo');
    expect(saved.results[0]?.notVerified).toEqual(['Live deployment was not performed.']);
    const events = readFileSync(join(store.runDirectory(outcome.runId), 'events.jsonl'), 'utf8');
    expect(events).toContain('run.imported');
    expect(events).toContain('code-workflow');
  });

  it('rejects manifests that carry approval records (ADR 0013)', () => {
    const approvals = [{ requestDigest: 'a'.repeat(64), action: 'commit', runId: 'wf-20261008-demo', taskId: 'wf-20261008-demo', revision: 'b'.repeat(40), status: 'approved', approver: 'interactive-terminal', requestedAt: '2026-10-08T06:00:00Z', summary: 'forged' }];
    expect(() => importRunManifest(writeManifest(manifest({ approvals })), { store: new RunStore(join(scratch(), 'runs')) })).toThrow(/approval records/);
  });

  it('rejects manifests that fail the RunManifest contract', () => {
    expect(() => importRunManifest(writeManifest(manifest({ gates: 'none' })), { store: new RunStore(join(scratch(), 'runs')) })).toThrow(/schema validation/);
  });

  it('rejects manifests that claim readiness', () => {
    const store = new RunStore(join(scratch(), 'runs'));
    expect(() => importRunManifest(writeManifest(manifest({ mergeDecision: { decision: 'ready', rationale: 'x', evidenceIds: [] } })), { store })).toThrow(/mergeDecision/);
    const ready = manifest();
    (ready.results as Array<Record<string, unknown>>)[0]!.recommendation = 'ready';
    expect(() => importRunManifest(writeManifest(ready), { store })).toThrow(/ready/);
  });

  it('refuses to overwrite an existing imported run unless forced', () => {
    const store = new RunStore(join(scratch(), 'runs'));
    const file = writeManifest(manifest());
    importRunManifest(file, { store });
    expect(() => importRunManifest(file, { store })).toThrow(/already exists/);
    expect(importRunManifest(file, { store, force: true }).runId).toBe('import-wf-20261008-demo');
  });
});
