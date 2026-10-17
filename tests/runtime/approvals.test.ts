import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessExecutionOutcome, HarnessExecutionRequest } from '../../packages/adapters/src/index.js';
import { RunStore } from '../../packages/evidence/src/index.js';
import type { Approver } from '../../packages/policy/src/index.js';
import { assertContract, type ApprovalRequest } from '../../packages/schemas/src/index.js';
import { WorktreeManager } from '../../packages/git/src/index.js';
import { createTask, executeTask, GIT_CONTROL_CHANGED } from '../../packages/runtime/src/index.js';
import { FakeAdapter, git, initRepository, rewriteKeepingTimes, SandboxWorktrees, WritingAdapter } from './fixtures.js';

const approveAll: Approver = { decide: async () => ({ approved: true, approver: 'test' }) };

class CountingAdapter extends WritingAdapter {
  calls = 0;
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    this.calls += 1;
    return super.execute(request);
  }
}

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

async function run(approver: Approver | undefined, gateCalls = { count: 0 }, setup: { codex?: CountingAdapter; sandbox?: (repository: string) => void; keepWorktrees?: boolean; gate?: (cwd: string) => void } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'cc-approval-test-'));
  temps.push(temp);
  const codex = setup.codex ?? new CountingAdapter('codex', 'openai');
  const claude = new CountingAdapter('claude', 'anthropic');
  const adapters = new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]);
  const worktrees = new SandboxWorktrees(temp);
  setup.sandbox?.(worktrees.sandboxRepository);
  const store = new RunStore(temp);
  const outcome = await executeTask(resolve('.'), createTask('approval-gated R1 run', 'R1', resolve('.')), {
    execute: true, adapters, store, worktrees,
    gateExecutor: (cwd) => { gateCalls.count += 1; setup.gate?.(cwd); return { status: 0, stdout: 'ok', stderr: '' }; },
    isHarnessTrusted: () => true,
    ...(approver ? { approver } : {}),
    ...(setup.keepWorktrees !== undefined ? { keepWorktrees: setup.keepWorktrees } : {}),
  });
  const events = (): string => { try { return readFileSync(join(store.runDirectory(outcome.plan.runId), 'events.jsonl'), 'utf8'); } catch { return ''; } };
  return { outcome, codex, claude, gateCalls, sandbox: worktrees.sandboxRepository, events };
}

// The builder's first start writes a file and fails without a result; the retry completes.
class FlakyBuilder extends CountingAdapter {
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    if (request.assignment.role === 'builder' && this.calls === 0) {
      this.calls += 1;
      writeFileSync(join(request.cwd, 'attempt1.txt'), 'partial\n');
      return { harness: this.id, surface: this.executionSurface, command: 'fake', args: [], exitCode: 1, signal: null, stdout: '', stderr: 'crashed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), timedOut: false };
    }
    return super.execute(request);
  }
}

function hook(repository: string, name: string, body: string, directory = join(repository, '.git', 'hooks')): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(directory, name), 0o755);
}

const decideWith = (rule: (request: ApprovalRequest) => boolean, seen: ApprovalRequest[] = []): Approver => ({
  decide: async (requests) => { seen.push(...requests); return { approved: requests.every(rule), approver: 'test' }; },
});

describe('pre-action approval enforcement (#44)', () => {
  it('workstation trust alone executes nothing when no approver is available', async () => {
    const { outcome, codex, claude, gateCalls } = await run(undefined);
    expect(codex.calls + claude.calls).toBe(0);
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.results[0]).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('no interactive approver');
    expect(outcome.manifest.approvals?.map((record) => [record.action, record.status])).toEqual([['local_execution', 'missing'], ['context_disclosure', 'missing']]);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
    // The fresh builder worktree held nothing and is removed with its branch.
    expect(outcome.worktrees).toHaveLength(0);
    assertContract('RunManifest', outcome.manifest);
  });

  it('records every approved action with bound, non-secret evidence', async () => {
    const seen: ApprovalRequest[] = [];
    const { outcome, codex, claude, gateCalls } = await run(decideWith(() => true, seen));
    expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
    expect(codex.calls + claude.calls).toBe(2);
    expect(gateCalls.count).toBeGreaterThan(0);
    expect(outcome.manifest.approvals?.map((record) => record.action)).toEqual(['local_execution', 'context_disclosure', 'commit', 'local_execution', 'context_disclosure', 'local_execution']);
    expect(outcome.manifest.approvals?.every((record) => record.status === 'approved' && /^[a-f0-9]{64}$/.test(record.requestDigest))).toBe(true);
    const disclosure = seen.find((request) => request.action === 'context_disclosure');
    expect(disclosure?.bindings.prompt).toMatch(/^[a-f0-9]{64}$/);
    // The prompt itself is never stored in approval evidence, only its digest and size.
    expect(JSON.stringify(outcome.manifest.approvals)).not.toContain('approval-gated R1 run');
    const commit = seen.find((request) => request.action === 'commit');
    expect(commit?.bindings).toMatchObject({ branch: outcome.worktrees[0]?.branch, baseSha: outcome.worktrees[0]?.baseSha });
    expect(commit?.bindings.tree).toBe(git(outcome.worktrees[0]!.path, 'rev-parse', 'HEAD^{tree}'));
    assertContract('RunManifest', outcome.manifest);
  });

  it('requires a distinct disclosure approval per provider', async () => {
    const { outcome, codex, claude } = await run(decideWith((request) => !request.recipient?.startsWith('anthropic/')));
    const [builder, reviewer] = outcome.manifest.results;
    // Routing is asserted so this test cannot silently become vacuous.
    expect(builder).toMatchObject({ provider: 'openai', harness: 'codex', status: 'completed' });
    expect(reviewer).toMatchObject({ provider: 'anthropic', harness: 'claude', status: 'blocked' });
    expect(codex.calls).toBe(1);
    expect(claude.calls).toBe(0);
    expect(reviewer?.blockers[0]).toContain('denied');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('preserves denied commits uncommitted in the agent worktree for native review', async () => {
    const { outcome, gateCalls } = await run(decideWith((request) => request.action !== 'commit'));
    const builder = outcome.manifest.results[0]!;
    expect(builder).toMatchObject({ status: 'blocked', recommendation: 'human_required', changes: [] });
    expect(builder.blockers.join(' ')).toContain('preserved uncommitted');
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
    expect(git(worktree.path, 'status', '--porcelain')).toContain('agent-output.txt');
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('rejects a commit approval when the diff changes after it was requested', async () => {
    let worktreePath = '';
    const tampering: Approver = {
      decide: async (requests) => {
        const commit = requests.find((request) => request.action === 'commit');
        if (commit) { worktreePath = commit.repository; writeFileSync(join(worktreePath, 'late-edit.txt'), 'changed during review\n'); }
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome } = await run(tampering);
    const commitRecord = outcome.manifest.approvals?.find((record) => record.action === 'commit');
    expect(commitRecord?.status).toBe('changed');
    expect(outcome.manifest.results[0]?.status).toBe('blocked');
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
    expect(git(worktreePath, 'status', '--porcelain')).toContain('late-edit.txt');
  });

  it('does not run repository gate commands without approval', async () => {
    const { outcome, gateCalls } = await run(decideWith((request) => request.recipient !== 'local:deterministic-gates'));
    expect(gateCalls.count).toBe(0);
    const validator = outcome.manifest.results.find((result) => result.role === 'validator');
    expect(validator).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(outcome.manifest.gates).toHaveLength(0);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('treats an approval given after its window as stale', async () => {
    let clock = Date.parse('2026-10-16T00:00:00Z');
    const temp = mkdtempSync(join(tmpdir(), 'cc-approval-expiry-test-'));
    temps.push(temp);
    const codex = new CountingAdapter('codex', 'openai');
    const claude = new CountingAdapter('claude', 'anthropic');
    const outcome = await executeTask(resolve('.'), createTask('expired approval run', 'R1', resolve('.')), {
      execute: true, adapters: new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]), store: new RunStore(temp), worktrees: new SandboxWorktrees(temp),
      gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true,
      approver: { decide: async () => { clock += 120_000; return { approved: true, approver: 'test' }; } },
      approvalTtlMs: 60_000, now: () => clock,
    });
    expect(codex.calls + claude.calls).toBe(0);
    expect(outcome.manifest.approvals?.[0]?.status).toBe('expired');
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('expired');
  });

  it('asks again before a retry and binds the retry to the changed working tree', async () => {
    const seen: ApprovalRequest[] = [];
    const codex = new FlakyBuilder('codex', 'openai');
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex });
    expect(codex.calls).toBe(2);
    const starts = seen.filter((request) => request.action === 'local_execution' && request.recipient === 'openai/codex@cli');
    expect(starts.map((request) => request.bindings.attempt)).toEqual(['1', '2']);
    expect(starts[1]?.bindings.tree).not.toBe(starts[0]?.bindings.tree);
    expect(starts[1]?.summary).toContain('Retry attempt 2');
    expect(outcome.manifest.results[0]?.status).toBe('completed');
  });

  it('does not retry when the retry is not approved', async () => {
    const codex = new FlakyBuilder('codex', 'openai');
    const { outcome } = await run(decideWith((request) => request.bindings.attempt !== '2'), { count: 0 }, { codex });
    expect(codex.calls).toBe(1);
    expect(outcome.manifest.results[0]?.status).toBe('failed');
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('automatic retry was not started');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('never runs repository hooks, so a hook cannot restage an approved commit or execute unapproved scripts', async () => {
    const seen: ApprovalRequest[] = [];
    const { outcome, sandbox } = await run(decideWith(() => true, seen), { count: 0 }, {
      sandbox: (repository) => {
        hook(repository, 'pre-commit', `echo injected > injected.txt && git add injected.txt; touch "${repository}/pre-commit-ran"`);
        hook(repository, 'post-checkout', `touch "${repository}/post-checkout-ran"`);
        hook(repository, 'post-commit', `touch "${repository}/post-commit-ran"`);
      },
    });
    const builder = outcome.manifest.results[0]!;
    expect(builder.status).toBe('completed');
    expect(builder.changes).toEqual(['agent-output.txt']);
    const worktree = outcome.worktrees[0]!;
    const approvedTree = seen.find((request) => request.action === 'commit')?.bindings.tree;
    expect(git(worktree.path, 'rev-parse', 'HEAD^{tree}')).toBe(approvedTree);
    for (const marker of ['pre-commit-ran', 'post-checkout-ran', 'post-commit-ran']) expect(existsSync(join(sandbox, marker))).toBe(false);
  });

  it('ignores a husky-style relative hooks path that the agent could edit', async () => {
    const { outcome, sandbox } = await run(approveAll, { count: 0 }, {
      sandbox: (repository) => {
        // Committed, so the agent's own worktree checks out (and could edit) the hook.
        hook(repository, 'pre-commit', `touch "${repository}/husky-ran"`, join(repository, '.husky'));
        git(repository, 'add', '.husky');
        git(repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'husky');
        git(repository, 'config', 'core.hooksPath', '.husky');
      },
    });
    expect(outcome.manifest.results[0]?.status).toBe('completed');
    expect(existsSync(join(sandbox, 'husky-ran'))).toBe(false);
  });

  it('rejects a provider start whose working tree changes while approval is pending', async () => {
    const tampering: Approver = {
      decide: async (requests) => {
        const start = requests.find((request) => request.action === 'local_execution' && request.recipient?.startsWith('openai/'));
        if (start) writeFileSync(join(start.repository, 'sneaked-in.txt'), 'x\n');
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome, codex } = await run(tampering);
    expect(codex.calls).toBe(0);
    expect(outcome.manifest.approvals?.slice(0, 2).map((record) => record.status)).toEqual(['changed', 'changed']);
    expect(outcome.manifest.results[0]?.blockers[0]).toContain('changed after approval was requested');
  });

  it('rejects gate commands when the validation tree changes while approval is pending', async () => {
    const gateCalls = { count: 0 };
    const tampering: Approver = {
      decide: async (requests) => {
        const gates = requests.find((request) => request.recipient === 'local:deterministic-gates');
        if (gates) writeFileSync(join(gates.repository, 'late.txt'), 'x\n');
        return { approved: true, approver: 'test' };
      },
    };
    const { outcome } = await run(tampering, gateCalls);
    expect(gateCalls.count).toBe(0);
    expect(outcome.manifest.approvals?.at(-1)).toMatchObject({ recipient: 'local:deterministic-gates', status: 'changed' });
    expect(outcome.manifest.results.at(-1)).toMatchObject({ role: 'validator', status: 'blocked' });
  });

  it('records each agent worktree in the manifest for native review (C03)', async () => {
    const { outcome } = await run(approveAll);
    expect(outcome.manifest.worktrees).toEqual([expect.objectContaining({ assignmentId: expect.any(String), path: outcome.worktrees[0]!.path, branch: outcome.worktrees[0]!.branch, baseSha: outcome.worktrees[0]!.baseSha })]);
    expect(() => assertContract('RunManifest', outcome.manifest)).not.toThrow();
  });

  it('removes the unused worktree and its branch when a start is refused', async () => {
    const { outcome, sandbox } = await run(undefined);
    expect(outcome.worktrees).toHaveLength(0);
    expect(outcome.manifest.worktrees ?? []).toEqual([]);
    expect(git(sandbox, 'branch', '--list', 'cc/*')).toBe('');
    expect(git(sandbox, 'worktree', 'list', '--porcelain')).not.toContain('sandbox-worktrees');
  });

  it('fails closed without crashing when the approver throws', async () => {
    const { outcome, codex, claude } = await run({ decide: async () => { throw new Error('approver unavailable'); } });
    expect(codex.calls + claude.calls).toBe(0);
    expect(outcome.manifest.approvals?.[0]?.status).toBe('missing');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('commits an agent edit hidden from the stat cache, with approval', async () => {
    // An agent can make an edit that keeps size and mtime; with core.checkStat=minimal
    // and core.trustctime=false, git status would report a clean tree.
    class StealthBuilder extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          this.calls += 1;
          const file = join(request.cwd, 'README.md');
          const past = new Date(Date.now() - 3_600_000);
          utimesSync(file, past, past);
          execFileSync('git', ['update-index', '--refresh'], { cwd: request.cwd, stdio: 'ignore' });
          rewriteKeepingTimes(file, (text) => text.replace('fixture', 'FIXTURE'));
          const payload = { status: 'completed', changes: ['README.md'], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: 'review' };
          const message = `CC_RESULT_JSON:${JSON.stringify(payload)}\n`;
          return { harness: this.id, surface: this.executionSurface, command: 'fake', args: [], exitCode: 0, signal: null, stdout: message, message, stderr: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), timedOut: false };
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, {
      codex: new StealthBuilder('codex', 'openai'),
      sandbox: (repository) => { git(repository, 'config', 'core.checkStat', 'minimal'); git(repository, 'config', 'core.trustctime', 'false'); },
    });
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'status', '--porcelain')).toBe('');
    expect(seen.some((request) => request.action === 'commit')).toBe(true);
    expect(outcome.manifest.results[0]?.changes).toEqual(['README.md']);
    expect(git(worktree.path, 'show', 'HEAD:README.md')).toContain('FIXTURE');
  });

  it.each([
    ['force-adding an ignored file', (cwd: string) => { writeFileSync(join(cwd, 'ignored.txt'), 'x\n'); execFileSync('git', ['add', '-f', 'ignored.txt'], { cwd }); }],
    ['untracking an ignored tracked file', (cwd: string) => { execFileSync('git', ['rm', '-q', '--cached', 'tracked-ignored.txt'], { cwd }); }],
  ])('never commits index-only changes without approval (%s)', async (_label, mutate) => {
    class IndexMutator extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') mutate(request.cwd);
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, {
      codex: new IndexMutator('codex', 'openai'),
      sandbox: (repository) => {
        writeFileSync(join(repository, '.gitignore'), 'ignored.txt\ntracked-ignored.txt\n');
        writeFileSync(join(repository, 'tracked-ignored.txt'), 'kept\n');
        git(repository, 'add', '-f', '.gitignore', 'tracked-ignored.txt');
        git(repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'ignore rules');
      },
    });
    // The WritingAdapter base still writes agent-output.txt, which is committed with approval;
    // the index-only change must not ride along.
    const worktree = outcome.worktrees[0]!;
    const committed = git(worktree.path, 'show', '--name-status', '--format=', 'HEAD');
    expect(seen.filter((request) => request.action === 'commit')).toHaveLength(1);
    expect(committed).toBe('A\tagent-output.txt');
  });

  it('refuses a sensitive file inside a new folder before asking for commit approval', async () => {
    class KeyWriter extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') { mkdirSync(join(request.cwd, 'keys'), { recursive: true }); writeFileSync(join(request.cwd, 'keys', 'id_rsa'), 'PRIVATE\n'); }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new KeyWriter('codex', 'openai'), sandbox: (repository) => git(repository, 'config', 'status.showUntrackedFiles', 'no') });
    const worktree = outcome.worktrees[0]!;
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
    expect(outcome.manifest.results[0]?.status).toBe('blocked');
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('keys/id_rsa');
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
  });

  it('lists untracked files for commit approval even with status.showUntrackedFiles=no', async () => {
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { sandbox: (repository) => git(repository, 'config', 'status.showUntrackedFiles', 'no') });
    expect(seen.find((request) => request.action === 'commit')?.summary).toContain('agent-output.txt');
    expect(outcome.manifest.results[0]?.changes).toEqual(['agent-output.txt']);
  });

  it('names commits the agent made itself and leaves the merge decision to a person', async () => {
    class SelfCommitter extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          writeFileSync(join(request.cwd, 'self.txt'), 'agent commit\n');
          git(request.cwd, 'add', 'self.txt');
          git(request.cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', 'agent commit');
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new SelfCommitter('codex', 'openai') });
    const builder = outcome.manifest.results[0]!;
    expect(seen.find((request) => request.action === 'commit')?.summary).toContain('1 commit(s) the agent made itself');
    expect(builder).toMatchObject({ status: 'completed', recommendation: 'human_required' });
    expect(builder.risks.join(' ')).toContain('Code Conductor did not approve');
    expect(builder.evidence.some((item) => item.summary.startsWith('Agent-authored commits'))).toBe(true);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('blocks when the agent\'s own history touched a sensitive path, even one it removed again', async () => {
    class SecretHistory extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          const commit = (message: string): void => { git(request.cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', message); };
          writeFileSync(join(request.cwd, '.env'), 'TOKEN=secret\n');
          git(request.cwd, 'add', '-f', '.env'); commit('add');
          git(request.cwd, 'rm', '-q', '.env'); commit('remove');
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new SecretHistory('codex', 'openai') });
    const builder = outcome.manifest.results[0]!;
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
    expect(builder.status).toBe('blocked');
    expect(builder.blockers.join(' ')).toContain('touch sensitive repository paths: .env');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it('blocks when an agent commit added a credential, even one a later commit removed', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    class CredentialHistory extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          const commit = (message: string): void => { git(request.cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', message); };
          writeFileSync(join(request.cwd, 'config.ts'), `export const token = '${token}';\n`);
          git(request.cwd, 'add', 'config.ts'); commit('add token');
          writeFileSync(join(request.cwd, 'config.ts'), 'export const token = process.env.TOKEN;\n');
          git(request.cwd, 'add', 'config.ts'); commit('remove token');
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new CredentialHistory('codex', 'openai') });
    const builder = outcome.manifest.results[0]!;
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
    expect(builder.status).toBe('blocked');
    expect(builder.blockers.join(' ')).toContain('add credential-looking strings (config.ts:1 GitHub token)');
    expect(builder.blockers.join(' ')).not.toContain(token);
  });

  it('flags an agent branch that no longer descends from its base', async () => {
    class Resetter extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') git(request.cwd, 'reset', '-q', '--soft', 'HEAD~1');
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, {
      codex: new Resetter('codex', 'openai'),
      sandbox: (repository) => { writeFileSync(join(repository, 'second.txt'), 'second\n'); git(repository, 'add', 'second.txt'); git(repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'second'); },
    });
    expect(seen.find((request) => request.action === 'commit')?.summary).toContain('no longer descends from its base');
    expect(outcome.manifest.results[0]?.recommendation).toBe('human_required');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it.each([['kept', true], ['cleanup requested', false]])('stops before running Git under configuration a provider changed, so its filter never runs (worktrees %s)', async (_label, keepWorktrees) => {
    const marker = join(mkdtempSync(join(tmpdir(), 'cc-filter-marker-')), 'ran');
    temps.push(join(marker, '..'));
    class ConfigWriter extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          git(request.cwd, 'config', 'filter.agent.clean', `touch '${marker}'; cat`);
          writeFileSync(join(request.cwd, '.gitattributes'), '* filter=agent\n');
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const gateCalls = { count: 0 };
    const { outcome, claude, events } = await run(decideWith(() => true, seen), gateCalls, { codex: new ConfigWriter('codex', 'openai'), keepWorktrees });
    const [builder, ...rest] = outcome.manifest.results;
    expect(existsSync(marker)).toBe(false);
    // Cleanup would run Git in the worktree; it is kept, and so is its record for `ccon next`.
    expect(existsSync(outcome.worktrees[0]!.path)).toBe(true);
    expect(outcome.manifest.worktrees).toHaveLength(1);
    if (!keepWorktrees) expect(events()).toContain('worktree.retained');
    expect(builder).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(builder?.blockers.join(' ')).toContain('Git configuration or history files');
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((result) => result.status === 'blocked')).toBe(true);
    expect(claude.calls + gateCalls.count).toBe(0);
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
  });

  it.each([['kept', true], ['cleanup requested', false]])('stops before running Git in a repository a provider nested in its worktree, so its filter never runs (worktrees %s)', async (_label, keepWorktrees) => {
    const marker = join(mkdtempSync(join(tmpdir(), 'cc-nested-marker-')), 'ran');
    temps.push(join(marker, '..'));
    class Nester extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          // A committed gitlink to a repository whose own configuration runs a program
          // whenever Git re-reads its file (status and add enter checked-out submodules).
          const nested = join(request.cwd, 'vendor-lib');
          git(request.cwd, 'init', '-q', 'vendor-lib');
          writeFileSync(join(nested, 'lib.txt'), 'lib\n');
          git(nested, 'add', 'lib.txt');
          git(nested, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'lib');
          git(nested, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
          writeFileSync(join(nested, '.git', 'info', 'attributes'), '* filter=x\n');
          git(request.cwd, 'add', 'vendor-lib');
          git(request.cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'gitlink');
          const later = new Date(Date.now() + 5000);
          utimesSync(join(nested, 'lib.txt'), later, later);
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new Nester('codex', 'openai'), keepWorktrees });
    const builder = outcome.manifest.results[0];
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(outcome.worktrees[0]!.path)).toBe(true);
    expect(builder).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(builder?.blockers.join(' ')).toContain('repositories nested in the work tree');
    expect(builder?.blockers.join(' ')).toContain(': nested repository vendor-lib appeared. Code Conductor ran no further');
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
  });

  it('never commits a nested repository Git did not report, for example one under paths the agent staged', async () => {
    class Concealer extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          const nested = join(request.cwd, 'sub');
          git(request.cwd, 'init', '-q', 'sub');
          writeFileSync(join(nested, 'lib.txt'), 'lib\n');
          git(nested, 'add', 'lib.txt');
          git(nested, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'lib');
          // An outer index entry under its directory hides it from `ls-files --others`.
          const blob = git(request.cwd, 'hash-object', '-w', join(request.cwd, 'README.md'));
          git(request.cwd, 'update-index', '--add', '--cacheinfo', `100644,${blob},sub/hidden.txt`);
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new Concealer('codex', 'openai') });
    const builder = outcome.manifest.results[0];
    expect(builder?.status).toBe('blocked');
    expect(builder?.blockers.join(' ')).toContain('adds nested Git repositories (sub)');
    expect(git(outcome.worktrees[0]!.path, 'rev-list', '--count', `${outcome.worktrees[0]!.baseSha}..HEAD`)).toBe('0');
  });

  it('leads commit summaries with how many files can change what later runs', async () => {
    class ConfigFiles extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          for (let index = 0; index < 25; index += 1) writeFileSync(join(request.cwd, `note-${String(index).padStart(2, '0')}.md`), 'n\n');
          mkdirSync(join(request.cwd, '.claude'), { recursive: true });
          writeFileSync(join(request.cwd, '.claude', 'settings.json'), '{}\n');
        }
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    await run(decideWith(() => true, seen), { count: 0 }, { codex: new ConfigFiles('codex', 'openai') });
    const summary = seen.find((request) => request.action === 'commit')?.summary ?? '';
    expect(summary).toContain('27 changed file(s), 1 of them able to change what later runs (CI, hooks, scripts, dependencies, agent or editor configuration): .claude/settings.json.');
    expect(summary).toContain('(6 more)');
  });

  it('redacts the prompt wherever an adapter embeds it in its argv', async () => {
    class EmbeddingAdapter extends CountingAdapter {
      invocation(request: HarnessExecutionRequest): { command: string; args: string[] } { return { command: 'fake-embed', args: ['run', `--prompt=${request.prompt}`] }; }
    }
    const seen: ApprovalRequest[] = [];
    await run(decideWith(() => true, seen), { count: 0 }, { codex: new EmbeddingAdapter('codex', 'openai') });
    const start = seen.find((request) => request.action === 'local_execution' && request.recipient === 'openai/codex@cli');
    expect(start?.summary).toContain('--prompt=<prompt>');
    expect(start?.summary).not.toContain('approval-gated R1 run');
  });

  it('never reaches ready from an advisory profile alone, and shows the resolved executable', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-gate-advisory-test-'));
    temps.push(temp);
    const adapters = new Map<string, HarnessAdapter>([['codex', new CountingAdapter('codex', 'openai')], ['claude', new CountingAdapter('claude', 'anthropic')]]);
    const seen: ApprovalRequest[] = [];
    const advisory = await executeTask(resolve('.'), createTask('advisory-only gate run', 'R1', resolve('.')), {
      execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp), isHarnessTrusted: () => true, approver: decideWith(() => true, seen),
      gateProfiles: ['terraform-plan'], gateExecutor: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    // Whether terraform is installed or not, the advisory profile alone must leave a blocking failure.
    expect(advisory.manifest.gates.some((gate) => gate.status === 'failed')).toBe(true);
    expect(advisory.manifest.mergeDecision?.decision).not.toBe('ready');
    const detected = await executeTask(resolve('.'), createTask('detected gate run', 'R1', resolve('.')), {
      execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(join(temp, 'second')), isHarnessTrusted: () => true, approver: decideWith(() => true, seen),
      gateExecutor: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(detected.manifest.mergeDecision?.decision).toBe('ready');
    const gateRequest = seen.find((request) => request.recipient === 'local:deterministic-gates');
    expect(gateRequest?.summary).toMatch(/ \[[^\]]*[\\/][^\]]+\]/);
    expect(gateRequest?.summary).toContain('not bound by this approval');
  });

  it('runs the gate profiles a person chose and fails closed on an unknown one', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'cc-gate-selection-test-'));
    temps.push(temp);
    const adapters = new Map<string, HarnessAdapter>([['codex', new CountingAdapter('codex', 'openai')], ['claude', new CountingAdapter('claude', 'anthropic')]]);
    const gateCalls: string[] = [];
    const outcome = await executeTask(resolve('.'), createTask('unknown gate profile run', 'R1', resolve('.')), {
      execute: true, adapters, store: new RunStore(temp), worktrees: new SandboxWorktrees(temp), isHarnessTrusted: () => true, approver: approveAll,
      gateProfiles: ['no-such-profile'], gateExecutor: (_cwd, command) => { gateCalls.push(command); return { status: 0, stdout: '', stderr: '' }; },
    });
    expect(gateCalls).toEqual([]);
    expect(outcome.manifest.results.at(-1)).toMatchObject({ role: 'validator', status: 'failed' });
    expect(outcome.manifest.results.at(-1)?.blockers[0]).toContain('Unknown gate profile: no-such-profile');
    expect(outcome.manifest.mergeDecision?.decision).toBe('changes_required');
  });

  it('refuses to commit new credential-looking content and preserves it uncommitted', async () => {
    class LeakyBuilder extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') writeFileSync(join(request.cwd, 'deploy.ts'), `export const key = '${['AKIA', 'Q3EXAMPLEKEY12345'].join('').slice(0, 20)}';\n`);
        return super.execute(request);
      }
    }
    const seen: ApprovalRequest[] = [];
    const { outcome, events } = await run(decideWith(() => true, seen), { count: 0 }, { codex: new LeakyBuilder('codex', 'openai') });
    const worktree = outcome.worktrees[0]!;
    expect(seen.some((request) => request.action === 'commit')).toBe(false);
    expect(outcome.manifest.results[0]?.status).toBe('blocked');
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain('deploy.ts:1 AWS access key id');
    const value = ['AKIA', 'Q3EXAMPLEKEY12345'].join('').slice(0, 20);
    expect(JSON.stringify(outcome.manifest)).not.toContain(value);
    expect(events()).not.toContain(value);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(worktree.baseSha);
    expect(git(worktree.path, 'status', '--porcelain')).toContain('deploy.ts');
  });

  it('cleans up only clean worktrees on request and still returns the run outcome', async () => {
    // Refuse the commit so the builder worktree stays dirty and must be retained.
    const { outcome } = await run(decideWith((request) => request.action !== 'commit'), { count: 0 }, { keepWorktrees: false });
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
    expect(outcome.worktrees).toHaveLength(1);
    expect(git(outcome.worktrees[0]!.path, 'status', '--porcelain')).toContain('agent-output.txt');
  });

  it('removes a clean worktree on request and keeps its branch and commit', async () => {
    const { outcome, sandbox, events } = await run(approveAll, { count: 0 }, { keepWorktrees: false });
    const committed = outcome.manifest.results[0]!;
    expect(committed.changes).toEqual(['agent-output.txt']);
    expect(outcome.worktrees).toHaveLength(0);
    expect(outcome.manifest.worktrees ?? []).toEqual([]);
    expect(events()).toContain('worktree.removed');
    const branch = git(sandbox, 'branch', '--list', 'cc/*', '--format=%(refname:short)');
    expect(git(sandbox, 'show', `${branch}:agent-output.txt`)).toBe('agent change');
  });

  it('keeps a worktree whose edit only content comparison sees, when its commit is refused', async () => {
    class StealthBuilder extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          const file = join(request.cwd, 'README.md');
          const past = new Date(Date.now() - 3_600_000);
          utimesSync(file, past, past);
          execFileSync('git', ['update-index', '--refresh'], { cwd: request.cwd, stdio: 'ignore' });
          rewriteKeepingTimes(file, (text) => text.replace('fixture', 'FIXTURE'));
          // Only the hidden edit: git status must see nothing to keep.
          return FakeAdapter.prototype.execute.call(this, request);
        }
        return super.execute(request);
      }
    }
    const { outcome } = await run(decideWith((request) => request.action !== 'commit'), { count: 0 }, {
      codex: new StealthBuilder('codex', 'openai'), keepWorktrees: false,
      sandbox: (repository) => { git(repository, 'config', 'core.checkStat', 'minimal'); git(repository, 'config', 'core.trustctime', 'false'); },
    });
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'status', '--porcelain')).toBe('');
    expect(existsSync(worktree.path)).toBe(true);
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toContain('FIXTURE');
  });

  it('keeps a worktree whose agent detached HEAD, so its commits are not orphaned', async () => {
    class Detacher extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') {
          git(request.cwd, 'switch', '-q', '--detach');
          writeFileSync(join(request.cwd, 'detached.txt'), 'x\n');
          git(request.cwd, 'add', 'detached.txt');
          git(request.cwd, '-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', 'commit', '-q', '-m', 'detached');
          // Nothing uncommitted: only the detached HEAD keeps the worktree.
          return FakeAdapter.prototype.execute.call(this, request);
        }
        return super.execute(request);
      }
    }
    const { outcome } = await run(approveAll, { count: 0 }, { codex: new Detacher('codex', 'openai'), keepWorktrees: false });
    const worktree = outcome.worktrees[0]!;
    expect(git(worktree.path, 'status', '--porcelain')).toBe('');
    expect(existsSync(worktree.path)).toBe(true);
    expect(git(worktree.path, 'log', '-1', '--format=%s')).toBe('detached');
  });

  it('stops when a gate command changes Git configuration, and keeps the worktree', async () => {
    const { outcome } = await run(approveAll, { count: 0 }, { keepWorktrees: false, gate: (cwd) => git(cwd, 'config', 'filter.gate.clean', 'cat') });
    const validator = outcome.manifest.results.find((result) => result.harness === 'internal-validator');
    expect(validator).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(validator?.blockers.join(' ')).toContain('Git configuration or history files');
    expect(outcome.manifest.mergeDecision?.decision).toBe('human_required');
    expect(outcome.worktrees).toHaveLength(1);
  });
});

describe('Git control checks with agent worktrees of the repository under work (#4)', () => {
  // As on a workstation: the run's root is the repository and agent worktrees are its own.
  // Its configuration includes a file only from the primary checkout (on its branch, at its
  // gitdir), so the agent worktree legitimately sees different configuration.
  async function workstationRun(builderDoes?: (cwd: string, repository: string) => void, setup?: (repository: string) => void) {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'cc-control-run-')));
    temps.push(temp);
    const repository = initRepository(join(temp, 'repo'));
    git(repository, 'config', `includeIf.onbranch:${git(repository, 'branch', '--show-current')}.path`, 'branch.inc');
    writeFileSync(join(repository, '.git', 'branch.inc'), '[user]\n\temail = branch@example.invalid\n');
    git(repository, 'config', `includeIf.gitdir:${join(repository, '.git')}.path`, 'gitdir.inc');
    writeFileSync(join(repository, '.git', 'gitdir.inc'), '[user]\n\tname = primary\n');
    setup?.(repository);
    const codex = new (class extends CountingAdapter {
      override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
        if (request.assignment.role === 'builder') builderDoes?.(request.cwd, repository);
        return super.execute(request);
      }
    })('codex', 'openai');
    const claude = new CountingAdapter('claude', 'anthropic');
    const outcome = await executeTask(repository, createTask('workstation-layout R1 run', 'R1', repository), {
      execute: true, adapters: new Map<string, HarnessAdapter>([['codex', codex], ['claude', claude]]), store: new RunStore(temp), worktrees: new WorktreeManager(join(temp, 'worktrees')),
      gateExecutor: () => ({ status: 0, stdout: 'ok', stderr: '' }), isHarnessTrusted: () => true, approver: approveAll,
    });
    return { outcome, repository, calls: codex.calls + claude.calls };
  }

  it('starts every provider when the agent worktree sees different configuration from the primary checkout', async () => {
    const { outcome, calls } = await workstationRun();
    expect(outcome.manifest.results.flatMap((result) => result.blockers).join(' ')).not.toContain(GIT_CONTROL_CHANGED);
    expect(calls).toBe(2);
    expect(outcome.manifest.mergeDecision?.decision).toBe('ready');
  });

  it('names a change only the primary checkout sees, read there again after the provider in the agent worktree ran', async () => {
    const { outcome, repository, calls } = await workstationRun((_cwd, repository) => writeFileSync(join(repository, '.git', 'branch.inc'), '[filter "agent"]\n\tclean = cat\n'));
    const [builder, ...rest] = outcome.manifest.results;
    expect(builder).toMatchObject({ status: 'blocked', recommendation: 'human_required' });
    expect(builder?.blockers.join(' ')).toContain(`local config file:${join(repository, '.git', 'branch.inc')} changed (read in ${repository})`);
    expect(rest.every((result) => result.status === 'blocked')).toBe(true);
    expect(calls).toBe(1);
  });

  it('names a shared change the agent worktree itself sees once, without its key or value', async () => {
    const { outcome, repository } = await workstationRun((cwd) => git(cwd, 'config', 'filter.agent.clean', 'planted-clean-command'));
    const blockers = outcome.manifest.results[0]?.blockers.join(' ') ?? '';
    expect(blockers).toContain(`(checked after openai/codex@cli was started): local config file:${join(repository, '.git', 'config')} changed. Code Conductor ran no further`);
    expect(blockers).not.toMatch(/planted-clean-command|filter\.agent/);
  });

  it('names a change only the agent worktree reads, made after its first reading', async () => {
    const { outcome, repository } = await workstationRun((cwd) => git(cwd, 'config', '--worktree', 'core.sshCommand', 'planted'), (repository) => git(repository, 'config', 'extensions.worktreeConfig', 'true'));
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain(`: worktree config file:${join(repository, '.git', 'worktrees', 'builder-codex', 'config.worktree')} appeared. Code Conductor ran no further`);
  });

  it.each([
    ['its .git file is removed', (cwd: string) => rmSync(join(cwd, '.git'))],
    ['its work tree is moved by core.worktree', (cwd: string) => {
      git(cwd, 'config', 'extensions.worktreeConfig', 'true');
      mkdirSync(join(cwd, '..', 'elsewhere'), { recursive: true });
      git(cwd, 'config', '--worktree', 'core.worktree', join(cwd, '..', 'elsewhere'));
    }],
  ])('stops, naming what it can, when the agent worktree stops being a Git work tree: %s', async (_label, hide) => {
    const { outcome, repository, calls } = await workstationRun((cwd) => { git(cwd, 'config', 'filter.agent.clean', 'planted'); hide(cwd); });
    const blockers = outcome.manifest.results[0]?.blockers.join(' ') ?? '';
    expect(blockers).toContain(`(checked after openai/codex@cli was started): ${outcome.worktrees[0]!.path} is no longer a Git work tree; local config file:${join(repository, '.git', 'config')} changed (read in ${repository})`);
    expect(calls).toBe(1);
  });

  it('redacts a credential-shaped name the agent chose', async () => {
    // Assembled at run time, so this file holds no literal credential.
    const token = `gh${'p_'}${'A1b2C3d4E5'.repeat(4)}`;
    const { outcome } = await workstationRun((cwd) => { git(cwd, 'init', '-q', token); });
    const blockers = outcome.manifest.results[0]?.blockers.join(' ') ?? '';
    expect(blockers).toContain(': nested repository [redacted GitHub token] appeared.');
    expect(blockers).not.toContain(token);
  });

  it('lists at most five changes, then how many more', async () => {
    const { outcome } = await workstationRun((cwd, repository) => {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        writeFileSync(join(repository, '..', `extra-${n}.inc`), '[core]\n\tabbrev = 12\n');
        git(cwd, 'config', '--add', 'include.path', join(repository, '..', `extra-${n}.inc`));
      }
    });
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toMatch(/: (local config [^;]+ (appeared|changed); ){4}local config [^;]+ (appeared|changed); and 2 more\. Code Conductor ran no further/);
  });

  it('is not stopped by the person creating a repository in the primary checkout meanwhile', async () => {
    const { outcome, calls } = await workstationRun((_cwd, repository) => { git(repository, 'init', '-q', 'scratch'); });
    expect(outcome.manifest.results.flatMap((result) => result.blockers).join(' ')).not.toContain(GIT_CONTROL_CHANGED);
    expect(calls).toBe(2);
  });

  it('links agent worktrees by absolute path, so Git never enables relativeWorktrees in the repository', async () => {
    const { outcome, repository } = await workstationRun(undefined, (repository) => git(repository, 'config', 'worktree.useRelativePaths', 'true'));
    expect(outcome.manifest.results.flatMap((result) => result.blockers).join(' ')).not.toContain(GIT_CONTROL_CHANGED);
    expect(git(repository, 'config', '--list', '--local')).not.toContain('relativeworktrees');
  });

  it('stops when the state cannot be read, for example repositories nested deeper than it reads', async () => {
    const { outcome, calls } = await workstationRun((cwd) => {
      let directory = cwd;
      for (const name of ['a', 'b', 'c', 'd']) { git(directory, 'init', '-q', name); directory = join(directory, name); }
    });
    expect(outcome.manifest.results[0]?.blockers.join(' ')).toContain(`${GIT_CONTROL_CHANGED} (config of any scope, info/attributes, info/grafts, shallow, objects/info/alternates, repositories nested in the work tree) for ${outcome.worktrees[0]!.path} could not be read (checked after openai/codex@cli was started).`);
    expect(calls).toBe(1);
  });
});
