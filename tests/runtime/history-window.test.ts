import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { FakeAdapter, git, SandboxWorktrees } from './fixtures.js';

// Runs once, inside the last Git call of the agent-history check (isAncestor), so a commit
// lands after that history was checked: as a process that outlived its client could.
let afterHistoryCheck: ((path: string) => void) | undefined;
vi.mock('@code-conductor/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('@code-conductor/git')>();
  return {
    ...original,
    isAncestor: (path: string, ancestor: string, descendant?: string): boolean => {
      const hook = afterHistoryCheck;
      afterHistoryCheck = undefined;
      hook?.(path);
      return original.isAncestor(path, ancestor, descendant);
    },
  };
});

const temps: string[] = [];
afterEach(() => { afterHistoryCheck = undefined; for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

describe('the commit after the agent-history check (#104 review)', () => {
  it('refuses to commit on top of a commit made after the history was checked, when nothing needed approval', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-history-window-'));
    temps.push(temp);
    // Assembled at run time, so this file holds no literal credential.
    const token = `gh${'p_'}${'d'.repeat(36)}`;
    afterHistoryCheck = (path) => {
      writeFileSync(join(path, 'late.ts'), `export const token = '${token}';\n`);
      git(path, 'add', 'late.ts');
      git(path, '-c', 'user.name=late', '-c', 'user.email=late@example.invalid', 'commit', '-q', '-m', 'late');
    };
    const adapters = new Map<string, HarnessAdapter>([['codex', new FakeAdapter('codex', 'openai')], ['claude', new FakeAdapter('claude', 'anthropic')]]);
    const outcome = await executeTask(resolve('.'), createTask('history window R1 run', 'R1', resolve('.')), {
      execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
      gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: { decide: async () => ({ approved: true, approver: 'test' }) },
    });
    const builder = outcome.manifest.results[0]!;
    expect(afterHistoryCheck).toBeUndefined();
    expect(builder.status).toBe('blocked');
    expect(builder.blockers.join(' ')).toMatch(/moved from the approved [0-9a-f]{40} to [0-9a-f]{40}/);
    expect(outcome.manifest.mergeDecision?.decision).not.toBe('ready');
    expect(JSON.stringify(outcome.manifest)).not.toContain(token);
  });
});
