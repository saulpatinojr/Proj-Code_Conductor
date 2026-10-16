import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeCleanAgentWorktree, scanForNewSecrets, treeChangedFiles, workingTreeState, WorktreeManager } from '../../packages/git/src/index.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

const LEGACY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  temps.push(base);
  const repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'config.ts'), `export const region = 'us-east-1';\n// legacy: ${LEGACY}\n`);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture');
  const root = join(base, 'worktrees');
  const handle = new WorktreeManager(root).create(repo, 'T-1', 'builder-test');
  return { repo, root, handle };
}

// Synthetic, well-formed-looking values assembled at runtime so this file holds no literal credential.
const fake = {
  aws: ['AKIA', 'Q3EXAMPLEKEY12345'].join('').slice(0, 20),
  github: ['ghp', '_', 'a'.repeat(36)].join(''),
  anthropic: ['sk-ant', '-api03-', 'b'.repeat(40)].join(''),
  key: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
};

describe('secret scan before commit approval', () => {
  it('reports new credential-looking strings by location and kind only', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'settings.ts'), `const a = '${fake.aws}';\nconst b = '${fake.github}';\nconst c = '${fake.anthropic}';\n`);
    writeFileSync(join(handle.path, 'id'), `${fake.key}\nMII...\n`);
    const tree = workingTreeState(handle.path).tree;
    const findings = scanForNewSecrets(handle.path, handle.baseSha, tree, treeChangedFiles(handle.path, handle.baseSha, tree));
    expect(findings).toEqual(expect.arrayContaining([
      { path: 'settings.ts', line: 1, kind: 'AWS access key id' },
      { path: 'settings.ts', line: 2, kind: 'GitHub token' },
      { path: 'settings.ts', line: 3, kind: 'Anthropic API key' },
      { path: 'id', line: 1, kind: 'private key' },
    ]));
    expect(JSON.stringify(findings)).not.toContain(fake.github);
  });

  it('ignores values already present in the base revision and binary files', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'config.ts'), `export const region = 'eu-west-1';\n// legacy: ${LEGACY}\n`);
    writeFileSync(join(handle.path, 'blob.bin'), Buffer.concat([Buffer.from(fake.github), Buffer.from([0, 1, 2])]));
    const tree = workingTreeState(handle.path).tree;
    expect(scanForNewSecrets(handle.path, handle.baseSha, tree, treeChangedFiles(handle.path, handle.baseSha, tree))).toEqual([]);
  });
});

describe('explicit worktree cleanup', () => {
  it('removes only clean Code Conductor worktrees and keeps their branches', () => {
    const { repo, root, handle } = setup();
    writeFileSync(join(handle.path, 'wip.txt'), 'not committed\n');
    expect(() => removeCleanAgentWorktree(handle.path, root)).toThrow('uncommitted changes');
    rmSync(join(handle.path, 'wip.txt'));
    expect(() => removeCleanAgentWorktree(handle.path, join(root, 'elsewhere'))).toThrow('not under the Code Conductor worktree root');
    removeCleanAgentWorktree(handle.path, root);
    expect(existsSync(handle.path)).toBe(false);
    expect(git(repo, 'branch', '--list', handle.branch)).toContain(handle.branch);
  });

  it('refuses worktrees that are not on an agent branch', () => {
    const { root, handle } = setup();
    git(handle.path, 'switch', '-q', '-c', 'feature/person');
    expect(() => removeCleanAgentWorktree(handle.path, root)).toThrow('agent branch');
  });
});
