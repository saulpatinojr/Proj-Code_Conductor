import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// /proc/self/fd cannot be read (no procfs, or one from another PID namespace): the
// opened file's location is unknown, so nothing may be returned.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readlinkSync = () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
  return { ...actual, readlinkSync, default: { ...actual, readlinkSync } };
});

const { DESCRIPTOR_LOCATION_SUPPORTED, readCheckedFile } = await import('../../packages/context-optimizer/src/checked-read.js');

describe.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('readCheckedFile without a readable /proc', () => {
  it('refuses rather than reading a file whose location it cannot verify', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-checked-read-proc-')));
    try {
      writeFileSync(join(base, 'notes.md'), 'inside\n');
      expect(() => readCheckedFile(join(base, 'notes.md'), 'notes.md', 1024)).toThrow(/changed while it was being opened/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
