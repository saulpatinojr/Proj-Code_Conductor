import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifestToolOutput, RunStore } from '../../packages/evidence/src/index.js';
import { evidenceText } from '../../apps/vscode/src/evidence.js';
import type { RunManifest } from '../../packages/schemas/src/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const streams = (stdout: string, stderr = '') => createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update(stderr).digest()).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc-manifest-output-')); roots.push(root);
  const repository = join(root, 'repo'); mkdirSync(repository);
  const store = new RunStore(join(root, 'runs'));
  const runId = 'CC-capture'; const id = 'E-aaaaaaaa-1111'; const stdout = 'Original output\n\u001b[2J\u202ecommand:evil\n';
  const source = 'node test.js (/usr/bin/node)';
  const record = { evidenceId: id, source, status: 1, timedOut: false, truncated: false, stdout, stderr: '', sha256: streams(stdout), digestMethod: 'streams' as const };
  const stored = store.saveToolOutput(runId, record);
  const evidence = { id, kind: 'test' as const, source, summary: 'Failed deterministic check', sha256: record.sha256, uri: 'https://foreign.example/never-followed' };
  const manifest: RunManifest = { runId, task: { id: 'T', objective: 'Evidence', repository, acceptanceCriteria: [], constraints: [], risk: 'R1', createdAt: new Date().toISOString() }, assignments: [], results: [{ taskId: 'T', assignmentId: 'A', agentId: 'validator', role: 'validator', stance: 'neutral', provider: 'local', harness: 'internal', billingChannel: 'local', status: 'completed', changes: [], tests: [], evidence: [evidence], findings: [], risks: [], blockers: [], recommendation: 'changes_required' }], gates: [{ gate: 'test', status: 'failed', evidenceIds: [id] }] };
  store.saveManifest(manifest);
  const read = () => readManifestToolOutput(store.root, manifest, id);
  const header = () => JSON.parse(readFileSync(stored.path, 'utf8'));
  const editHeader = (changes: Record<string, unknown>) => writeFileSync(stored.path, JSON.stringify({ ...header(), ...changes }));
  return { root, repository, store, manifest, id, record, evidence, read, stored, editHeader };
}
describe('manifest-bound tool output', () => {
  it('returns exact captured bytes only when manifest provenance matches, ignoring evidence URIs', () => {
    const { read, record, repository, store, manifest, id } = fixture();
    expect(read().record.stdout).toBe(record.stdout);
    const shown = evidenceText(repository, store.root, manifest, id);
    expect(shown).toContain('matches the digest recorded in this run manifest');
    expect(shown).toContain('Manifest gate verdict: test: failed');
    expect(shown).not.toContain('\u001b'); expect(shown).not.toContain('\u202e'); expect(shown).not.toContain('foreign.example');
  });
  it('refuses a rewritten capture even when its own header hashes were updated consistently', () => {
    const { store, manifest, id, stored, editHeader, read } = fixture();
    const replacement = 'Fictional passed output';
    writeFileSync(join(store.root, manifest.runId, 'tool-output', `${id}.stdout`), replacement);
    editHeader({ sha256: sha(replacement), stdoutSha256: sha(replacement) });
    expect(() => store.readToolOutput(manifest.runId, id)).not.toThrow();
    expect(read).toThrow(/differs from the run manifest/);
    expect(existsSync(stored.path)).toBe(true);
  });
  it('refuses changed source, digest, missing or duplicate evidence identities', () => {
    const { manifest, editHeader, read, evidence } = fixture(); editHeader({ source: 'another command' }); expect(read).toThrow(/metadata/);
    editHeader({ source: evidence.source }); evidence.sha256 = 'f'.repeat(64); expect(read).toThrow(/metadata/);
    evidence.sha256 = ''; expect(read).toThrow(/digest-bound/);
    manifest.results[0]!.evidence.push(evidence); expect(read).toThrow(/unique/);
    manifest.results[0]!.evidence = []; expect(read).toThrow(/unique/);
  });
  it('refuses a forged truncation flag and actual truncated captures without claiming verified prefix output', () => {
    const { editHeader, read } = fixture(); editHeader({ truncated: true }); expect(read).toThrow(/truncated/);
  });
  it('uses manifest verdicts rather than unbound header exit/timeout metadata', () => {
    const { repository, store, manifest, id, editHeader } = fixture(); editHeader({ status: 0, timedOut: false });
    const shown = evidenceText(repository, store.root, manifest, id);
    expect(shown).toContain('Manifest gate verdict: test: failed'); expect(shown).not.toContain('exit: 0');
  });
  it('refuses canonical-only legacy digests that cannot bind exact bytes or stream identity', () => {
    const { record, evidence, editHeader, store, manifest, id, stored, read } = fixture();
    const original = record.stdout.trim(); evidence.sha256 = sha(original);
    editHeader({ digestMethod: 'combined', sha256: evidence.sha256, stdoutSha256: sha(record.stdout) });
    const altered = '\n  ' + original + '  \n';
    writeFileSync(stored.path.replace('.json', '.stdout'), altered); editHeader({ stdoutSha256: sha(altered) });
    expect(store.readToolOutput(manifest.runId, id).verification.matchesEvidence).toBe(true);
    expect(read).toThrow(/Legacy combined/);
  });
  it('does not echo malformed capture data or write missing run storage', () => {
    const { stored, read, store, manifest, id, root } = fixture();
    writeFileSync(stored.path, 'private-value-that-must-not-appear');
    expect(read).toThrow(/Capture unavailable/);
    try { read(); } catch (error) { expect(String(error)).not.toContain('private-value'); }
    const absent = join(root, 'absent'); expect(() => readManifestToolOutput(absent, manifest, id)).toThrow(); expect(existsSync(absent)).toBe(false);
    expect(existsSync(store.root)).toBe(true);
  });
  it('refuses foreign repository display and changed output when a virtual document refreshes', () => {
    const { root, repository, store, manifest, id, stored } = fixture(); const other = join(root, 'other'); mkdirSync(other);
    expect(evidenceText(other, store.root, manifest, id)).not.toContain('Original output');
    writeFileSync(stored.path.replace('.json', '.stdout'), 'new content');
    expect(evidenceText(repository, store.root, manifest, id)).toContain('cannot be verified');
  });
  it.skipIf(process.platform === 'win32')('refuses symlinked capture folders/files and hard-linked streams', () => {
    const { root, store, manifest, id, stored, read } = fixture();
    const stdout = stored.path.replace('.json', '.stdout'); const outside = join(root, 'outside'); writeFileSync(outside, 'outside');
    rmSync(stdout); symlinkSync(outside, stdout); expect(read).toThrow(/Unsafe/);
    rmSync(stdout); linkSync(outside, stdout); expect(read).toThrow(/Unsafe/);
    rmSync(stdout); writeFileSync(stdout, 'Original output');
    const dir = join(store.root, manifest.runId, 'tool-output');
    rmSync(dir, { recursive: true }); symlinkSync(root, dir); expect(read).toThrow(/Unsafe/);
    expect(existsSync(outside)).toBe(true);
    expect(() => readManifestToolOutput(store.root, manifest, '../manifest')).toThrow(/Invalid/);
  });
});
