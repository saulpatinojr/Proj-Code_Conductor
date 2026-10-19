import { describe, expect, it } from 'vitest';
import { createBuiltinAdapters, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';

describe('builtin harness execution surfaces', () => {
  it('keeps Claude and Codex on CLI execution while Kiro is ACP-first', () => {
    const adapters = createBuiltinAdapters();
    expect(adapters.get('claude')?.executionSurface).toBe('cli');
    expect(adapters.get('codex')?.executionSurface).toBe('cli');
    expect(adapters.get('kiro')?.executionSurface).toBe('acp');
    expect(adapters.get('kiro')?.command).toBe('kiro-cli');
  });

  // `codex exec` is headless (approval policy Never) and has no --ask-for-approval flag;
  // an unknown flag is a usage error, exit 2, before the prompt runs (D-073).
  it.each([
    ['read', ['review'], 'read-only'],
    ['modify', ['modify_worktree'], 'workspace-write'],
  ])('starts Codex %s assignments as codex exec with only the flags the client accepts', (_, authority, sandbox) => {
    const request = { task: {}, assignment: { authority }, cwd: '/work/tree', timeoutMs: 1000, prompt: 'Review the change.' } as unknown as HarnessExecutionRequest;
    const invocation = createBuiltinAdapters().get('codex')!.invocation!(request);
    expect(invocation).toEqual({ command: 'codex', args: ['exec', '--json', '--sandbox', sandbox, '--cd', '/work/tree', 'Review the change.'] });
    expect(invocation.args).not.toContain('--ask-for-approval');
  });

  it('models platform/manual/interactive lanes without pretending they are generic subprocess workers', () => {
    const adapters = createBuiltinAdapters();
    expect(adapters.get('copilot-github')?.executionSurface).toBe('platform');
    expect(adapters.get('perplexity')?.executionSurface).toBe('manual');
    expect(adapters.get('antigravity')?.executionSurface).toBe('ide');
  });
});
