import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, fstatSync, ftruncateSync, futimesSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HarnessAdapter, HarnessExecutionRequest, HarnessExecutionOutcome, HarnessExecutionSurface } from '../../packages/adapters/src/index.js';
import { WorktreeManager, type WorktreeHandle } from '../../packages/git/src/index.js';

// Shared doubles for runtime execution suites. Adapters are fakes; worktrees are
// real linked worktrees of a throwaway repository, never the checkout under test.
export class FakeAdapter implements HarnessAdapter {
  constructor(
    public id: string,
    public provider: string,
    public command: string | null = `fake-${id}`,
    public executionSurface: HarnessExecutionSurface = 'cli',
  ) {}
  available(): boolean { return true; }
  version(): string { return 'fake-1.0.0'; }
  async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const payload = { status: 'completed', changes: request.assignment.role === 'builder' ? ['fake.txt'] : [], tests: [], evidence: [], findings: [], risks: [], blockers: [], recommendation: request.assignment.role === 'reviewer' ? 'ready' : 'review' };
    // The final message, as a real adapter extracts it from the client's machine-readable output.
    const message = `CC_RESULT_JSON:${JSON.stringify(payload)}\n`;
    return { harness: this.id, surface: this.executionSurface, command: this.command ?? 'fake', args: [], exitCode: 0, signal: null, stdout: message, message, stderr: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), timedOut: false };
  }
}

// The builder writes a file into its assigned worktree, so completed runs exercise
// the real commit path rather than an empty worktree.
export class WritingAdapter extends FakeAdapter {
  override async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    if (request.assignment.role === 'builder') writeFileSync(join(request.cwd, 'agent-output.txt'), 'agent change\n');
    return super.execute(request);
  }
}

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * Rewrite a file in place and restore its access and modification times, as an agent
 * hiding an edit from Git's stat cache would. One file descriptor is used throughout,
 * so the times restored are those of the file that was rewritten.
 */
export function rewriteKeepingTimes(file: string, transform: (text: string) => string): void {
  const descriptor = openSync(file, 'r+');
  try {
    const { atime, mtime } = fstatSync(descriptor);
    const next = Buffer.from(transform(readFileSync(descriptor, 'utf8')));
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, next, 0, next.length, 0);
    futimesSync(descriptor, atime, mtime);
  } finally { closeSync(descriptor); }
}

export function initRepository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  writeFileSync(join(path, 'README.md'), '# fixture\n');
  // The validator detects gate profiles in the builder's worktree, which in real runs
  // is a checkout of the repository under work. Carry over the gate config and the
  // files the code-conductor profile detects on, so the validator still runs gates.
  cpSync(resolve('config'), join(path, 'config'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) cpSync(resolve(file), join(path, file));
  // The code-conductor gate profile requires installed dependencies and a built CLI;
  // gate commands are faked in these suites, so placeholders satisfy the prerequisites.
  mkdirSync(join(path, 'node_modules'), { recursive: true });
  writeFileSync(join(path, 'node_modules', '.placeholder'), '');
  mkdirSync(join(path, 'packages', 'cli', 'dist'), { recursive: true });
  writeFileSync(join(path, 'packages', 'cli', 'dist', 'index.js'), '');
  git(path, 'add', '.');
  git(path, '-c', 'user.name=Code Conductor Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  return path;
}

// Real linked worktrees from WorktreeManager, but of a throwaway repository rather
// than the checkout running the suite. The planner still reads config from the real
// repository root. An earlier double returned the repository root itself as the
// worktree, so a completed builder run committed the contributor's uncommitted work
// onto their branch (issue #48).
export class SandboxWorktrees extends WorktreeManager {
  readonly sandboxRepository: string;
  constructor(base: string) {
    super(join(base, 'sandbox-worktrees'));
    this.sandboxRepository = initRepository(join(base, 'sandbox-repo'));
  }
  override create(_repositoryRoot: string, taskId: string, agentId: string, baseRef = 'HEAD'): WorktreeHandle {
    return super.create(this.sandboxRepository, taskId, agentId, baseRef);
  }
}
