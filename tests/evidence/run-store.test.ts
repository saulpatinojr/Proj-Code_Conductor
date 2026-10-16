import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore, safeRunDirectoryName } from '../../packages/evidence/src/index.js';
import type { RunManifest } from '../../packages/schemas/src/index.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('run evidence store', () => {
  it('persists manifests and events with private permissions on POSIX systems', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-evidence-test-'));
    try {
      const storeRoot = join(root, 'runs');
      const store = new RunStore(storeRoot);
      const manifest: RunManifest = {
        runId: 'RUN-1',
        task: {
          id: 'TASK-1',
          objective: 'test private persistence',
          acceptanceCriteria: [],
          risk: 'R0',
          constraints: [],
          createdAt: new Date().toISOString(),
        },
        assignments: [],
        results: [],
        gates: [],
      };

      const manifestPath = store.saveManifest(manifest);
      const eventPath = store.appendEvent({
        at: new Date().toISOString(),
        runId: manifest.runId,
        type: 'test.event',
        message: 'sensitive operational context',
      });

      expect(JSON.parse(readFileSync(manifestPath, 'utf8')).runId).toBe('RUN-1');
      expect(readFileSync(eventPath, 'utf8')).toContain('test.event');

      if (process.platform !== 'win32') {
        expect(mode(storeRoot)).toBe(0o700);
        expect(mode(store.runDirectory(manifest.runId))).toBe(0o700);
        expect(mode(manifestPath)).toBe(0o600);
        expect(mode(eventPath)).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps relative and dotted run IDs inside the evidence store root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-evidence-path-'));
    try {
      const storeRoot = join(root, 'runs');
      const store = new RunStore(storeRoot);
      for (const runId of ['..', '../outside', '.', 'a/../../outside']) {
        const target = resolve(store.runDirectory(runId));
        const rel = relative(resolve(storeRoot), target);
        expect(rel).not.toBe('');
        expect(isAbsolute(rel)).toBe(false);
        expect(rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)).toBe(false);
        expect(safeRunDirectoryName(runId)).not.toMatch(/^\.{1,2}$/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds a digest when unsafe run IDs normalize to similar names', () => {
    expect(safeRunDirectoryName('../run')).not.toBe(safeRunDirectoryName('..\\run'));
  });

  it('reads stored manifests through one descriptor and refuses links, non-files and oversize files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-evidence-read-'));
    try {
      const store = new RunStore(join(root, 'runs'));
      const directory = (runId: string): string => { const path = join(store.root, safeRunDirectoryName(runId)); mkdirSync(path, { recursive: true }); return path; };
      writeFileSync(join(directory('RUN-OK'), 'manifest.json'), '{"runId":"RUN-OK"}');
      expect(store.readManifest('RUN-OK')).toEqual({ runId: 'RUN-OK' });
      expect(store.latestRunId()).toBe('RUN-OK');
      expect(() => store.readManifest('RUN-MISSING')).toThrow('No stored run manifest for RUN-MISSING.');
      writeFileSync(join(directory('RUN-BIG'), 'manifest.json'), '{"x":"' + 'a'.repeat(64) + '"}');
      expect(() => store.readManifest('RUN-BIG', 16)).toThrow('exceeds 16 bytes');
      if (process.platform !== 'win32') {
        writeFileSync(join(root, 'elsewhere.json'), '{"runId":"ELSEWHERE"}');
        symlinkSync(join(root, 'elsewhere.json'), join(directory('RUN-LINK'), 'manifest.json'));
        expect(() => store.readManifest('RUN-LINK')).toThrow('cannot be opened');
        execFileSync('mkfifo', [join(directory('RUN-FIFO'), 'manifest.json')]);
        expect(() => store.readManifest('RUN-FIFO')).toThrow('not a regular file');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('normalizes long separator runs in run IDs quickly and keeps them inside the store', () => {
    // Quadratic backtracking would make this input take minutes and time the test out.
    const name = safeRunDirectoryName(`${'-'.repeat(200_000)}x${'-'.repeat(200_000)}!`);
    expect(name).toMatch(/^x-[a-f0-9]{12}$/);
    expect(safeRunDirectoryName('__../..__')).toMatch(/^run-[a-f0-9]{12}$/);
  });
});
