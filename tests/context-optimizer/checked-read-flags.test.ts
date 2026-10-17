import { constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Every failed open gets the same answer, so the open flags are checked where they are
// passed: the final component is never followed, a FIFO never blocks, and a terminal never
// becomes the process's controlling terminal.
const opened: number[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = ((path: Parameters<typeof actual.openSync>[0], flags?: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
    if (typeof flags === 'number') opened.push(flags);
    return actual.openSync(path, flags, mode);
  }) as typeof actual.openSync;
  return { ...actual, openSync, default: { ...actual, openSync } };
});

const { DESCRIPTOR_LOCATION_SUPPORTED, readCheckedFile } = await import('../../packages/context-optimizer/src/checked-read.js');

describe.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('readCheckedFile open flags', () => {
  it('opens read-only, without following, blocking or taking a terminal', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-checked-read-flags-')));
    try {
      writeFileSync(join(base, 'notes.md'), 'inside\n');
      expect(readCheckedFile(join(base, 'notes.md'), 'notes.md', 1024)).toBe('inside\n');
      expect(opened).toHaveLength(1);
      const [flags] = opened as [number];
      expect(flags & (constants.O_RDONLY | constants.O_WRONLY | constants.O_RDWR)).toBe(constants.O_RDONLY);
      for (const flag of [constants.O_NOFOLLOW, constants.O_NONBLOCK, constants.O_NOCTTY]) expect(flags & flag).toBe(flag);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
