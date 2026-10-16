import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESCRIPTOR_LOCATION_SUPPORTED, readCheckedFile } from '../../packages/context-optimizer/src/checked-read.js';
import { ContextOptimizer } from '../../packages/context-optimizer/src/index.js';

const BUILT_READER = resolve('packages/context-optimizer/dist/checked-read.js');
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A workspace and an outside folder, each holding notes.md with distinct content. */
function layout(): { workspace: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-checked-read-')));
  cleanup.push(base);
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, 'docs', 'notes.md'), 'inside\n');
  writeFileSync(join(outside, 'notes.md'), 'outside\n');
  return { workspace, outside };
}

describe.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('readCheckedFile (descriptor-bound location)', () => {
  it('reads a regular file at its checked path', () => {
    const { workspace } = layout();
    expect(readCheckedFile(join(workspace, 'docs', 'notes.md'), 'docs/notes.md', 1024)).toBe('inside\n');
  });

  it('refuses a file reached through a directory that became a symlink after the check', () => {
    const { workspace, outside } = layout();
    // The state an attacker produces between the check and the open: the checked path's
    // parent directory now points outside the workspace.
    rmSync(join(workspace, 'docs'), { recursive: true });
    symlinkSync(outside, join(workspace, 'docs'));
    expect(() => readCheckedFile(join(workspace, 'docs', 'notes.md'), 'docs/notes.md', 1024)).toThrow(/changed while it was being opened/);
  });

  it('refuses a swap that stays inside the workspace, since the new location was never checked', () => {
    const { workspace } = layout();
    // A directory the sensitive-path policy blocks (.terraform/), under a sibling whose name
    // starts with the checked directory's name, holding a file of the same name. Being
    // inside the root, or under a matching prefix, is not enough: the location must be
    // exactly the checked one.
    const terraform = join(workspace, 'docs-cache', '.terraform');
    mkdirSync(terraform, { recursive: true });
    writeFileSync(join(terraform, 'notes.md'), 'state\n');
    rmSync(join(workspace, 'docs'), { recursive: true });
    symlinkSync(terraform, join(workspace, 'docs'));
    expect(() => readCheckedFile(join(workspace, 'docs', 'notes.md'), 'docs/notes.md', 1024)).toThrow(/changed while it was being opened/);
  });

  it('refuses to open a final symlink at all', () => {
    const { workspace, outside } = layout();
    symlinkSync(join(outside, 'notes.md'), join(workspace, 'link.md'));
    expect(() => readCheckedFile(join(workspace, 'link.md'), 'link.md', 1024)).toThrow(/cannot be opened: link\.md \(ELOOP\)/);
  });

  it('refuses a file over the limit on the descriptor itself', () => {
    const { workspace } = layout();
    writeFileSync(join(workspace, 'large.md'), 'x'.repeat(32));
    expect(() => readCheckedFile(join(workspace, 'large.md'), 'large.md', 16)).toThrow(/exceeds the 16 byte limit/);
  });

  it('refuses a file that returns more than its reported size', () => {
    // procfs files report size 0 but return data, as a file growing mid-read would.
    const status = `/proc/${process.pid}/status`;
    expect(() => readCheckedFile(status, 'status', 1024)).toThrow(/changed while it was being read/);
  });

  it('refuses a FIFO without blocking on it', () => {
    const { workspace } = layout();
    const fifo = join(workspace, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    // In a child process, so that an open that blocks (no writer ever comes) fails the
    // test by timeout instead of hanging the test runner.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { readCheckedFile } = await import(${JSON.stringify(BUILT_READER)});
      try { readCheckedFile(${JSON.stringify(fifo)}, 'pipe.md', 1024); console.log('READ'); }
      catch (error) { console.log(error.message); }
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.stdout).toMatch(/not a regular file: pipe\.md/);
  });

  it('never returns content from outside the workspace while a parent directory is being swapped', async () => {
    const { workspace, outside } = layout();
    const docs = join(workspace, 'docs');
    // Alternate docs/ between the real directory and a symlink to the outside folder.
    symlinkSync(outside, join(workspace, 'docs.link'));
    const swapper = spawn(process.execPath, ['-e', `
      const { renameSync } = require('node:fs');
      const [docs, real, link] = process.argv.slice(1);
      for (;;) {
        try { renameSync(docs, real); renameSync(link, docs); renameSync(docs, link); renameSync(real, docs); } catch {}
      }
    `, docs, join(workspace, 'docs.real'), join(workspace, 'docs.link')], { stdio: 'ignore' });
    const counts = { inside: 0, outside: 0, refused: 0 };
    try {
      const optimizer = new ContextOptimizer({ statsFile: join(workspace, '..', 'stats.json'), allowedRoots: [workspace] });
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        try {
          const { content } = optimizer.readCompressedFile(join(docs, 'notes.md'));
          if (content.includes('outside')) counts.outside += 1; else counts.inside += 1;
        } catch { counts.refused += 1; }
      }
    } finally {
      swapper.kill('SIGKILL');
      await new Promise((done) => swapper.once('exit', done));
    }
    expect(counts.outside).toBe(0);
    expect(counts.inside + counts.refused).toBeGreaterThan(100);
  }, 15_000);
});

describe.runIf(!DESCRIPTOR_LOCATION_SUPPORTED)('readCheckedFile (no descriptor location)', () => {
  it('refuses before opening anything', () => {
    const { workspace } = layout();
    expect(() => readCheckedFile(join(workspace, 'docs', 'notes.md'), 'docs/notes.md', 1024)).toThrow(/can be read only where the opened file's location can be verified/);
  });

  it('refuses every context file read, whatever the path, before checking it', () => {
    const { workspace } = layout();
    const optimizer = new ContextOptimizer({ statsFile: join(workspace, '..', 'stats.json'), allowedRoots: [workspace] });
    for (const path of [join(workspace, 'docs', 'notes.md'), join(workspace, 'missing.md'), join(workspace, '..', 'outside', 'notes.md')]) {
      expect(() => optimizer.readCompressedFile(path)).toThrow(/can be read only where the opened file's location can be verified/);
    }
  });
});
