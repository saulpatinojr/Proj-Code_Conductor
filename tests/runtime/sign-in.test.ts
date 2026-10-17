import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientAuthStatus, HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { createTask, executeTask } from '../../packages/runtime/src/index.js';
import { FakeAdapter, git, SandboxWorktrees } from './fixtures.js';

// A fake official client: its sign-in status is whatever the test says.
class SignedInAdapter extends FakeAdapter {
  starts = 0;
  constructor(id: string, provider: string, private readonly status: () => Promise<ClientAuthStatus>) { super(id, provider); }
  authStatus(): Promise<ClientAuthStatus> { return this.status(); }
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> { this.starts += 1; return super.execute(request); }
}

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

async function run(status: () => Promise<ClientAuthStatus>, trusted: (version?: string) => boolean = () => true) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-sign-in-test-'));
  temps.push(temp);
  const codex = new SignedInAdapter('codex', 'openai', status);
  const claude = new SignedInAdapter('claude', 'anthropic', status);
  const asked: string[] = [];
  const approver: Approver = { decide: async (requests) => { asked.push(...requests.map((request) => request.action)); return { approved: true, approver: 'test' }; } };
  const worktrees = new SandboxWorktrees(temp);
  const outcome = await executeTask(resolve('.'), createTask('sign-in gated run', 'R1', resolve('.')), {
    execute: true, adapters: new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]), store: new RunStore(temp), worktrees,
    gateExecutor: () => ({ status: 0, stdout: '', stderr: '' }), isHarnessTrusted: (_harness, _mode, _surface, version) => trusted(version), approver,
  });
  return { outcome, starts: codex.starts + claude.starts, asked, sandbox: worktrees.sandboxRepository };
}

const status = (value: Omit<ClientAuthStatus, 'command'>) => async (): Promise<ClientAuthStatus> => ({ ...value, command: ['codex', 'login', 'status'] });

describe('sign-in before a provider starts (#34)', () => {
  it.each([
    ['not signed in', status({ state: 'unauthenticated', billing: 'unknown' }), 'is not signed in through its official client'],
    ['an unrecognised state', status({ state: 'unknown', billing: 'unknown' }), 'did not report a sign-in state Code Conductor recognises'],
    ['a status probe that throws', async (): Promise<ClientAuthStatus> => { throw new Error('probe crashed'); }, 'is not signed in through its official client'],
    ['an API key', status({ state: 'authenticated', billing: 'separately_billed', method: 'API key' }), 'would use a separately billed sign-in (API key'],
    ['billing it cannot confirm', status({ state: 'authenticated', billing: 'unknown', method: 'personal access token' }), 'may use a separately billed sign-in'],
  ])('starts nothing, asks nothing and creates no worktree for %s', async (_label, probe, message) => {
    const { outcome, starts, asked, sandbox } = await run(probe);
    expect(starts).toBe(0);
    expect(asked).toEqual([]);
    expect(outcome.manifest.results[0]).toMatchObject({ status: 'blocked', recommendation: 'changes_required' });
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain(message);
    expect(outcome.manifest.worktrees ?? []).toEqual([]);
    expect(git(sandbox, 'branch', '--list', 'cc/*')).toBe('');
    expect(outcome.manifest.mergeDecision?.decision).not.toBe('ready');
  });

  it('starts nothing when the client would read its user configuration from the repository', async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    const savedCodex = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = join(resolve('.'), '.claude-config');
    process.env.CODEX_HOME = join(resolve('.'), 'codex-home');
    try {
      const { outcome, starts, asked } = await run(status({ state: 'authenticated', billing: 'subscription', method: 'ChatGPT' }));
      expect(starts).toBe(0);
      expect(asked).toEqual([]);
      expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('would read its user configuration from inside the repository');
      expect(outcome.manifest.worktrees ?? []).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
      if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex;
    }
  });

  it('runs normally with a subscription sign-in', async () => {
    const { outcome, starts } = await run(status({ state: 'authenticated', billing: 'subscription', method: 'ChatGPT' }));
    expect(starts).toBeGreaterThan(0);
    expect(outcome.manifest.results[0]?.status).toBe('completed');
    expect(existsSync(outcome.worktrees[0]!.path)).toBe(true);
  });

  it('asks the trust check about the installed client version', async () => {
    const versions: Array<string | undefined> = [];
    const { starts, outcome } = await run(status({ state: 'authenticated', billing: 'subscription', method: 'ChatGPT' }), (version) => { versions.push(version); return false; });
    expect(versions[0]).toBe('fake-1.0.0');
    expect(starts).toBe(0);
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('for its installed version (fake-1.0.0)');
  });
});
