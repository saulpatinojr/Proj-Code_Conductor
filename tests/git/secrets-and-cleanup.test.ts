import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorktreeRemovalProblem, removeCleanAgentWorktree, scanForNewSecrets, scanHistoryForNewSecrets, workingTreeState, WorktreeManager } from '../../packages/git/src/index.js';
import { rewriteKeepingTimes } from '../runtime/fixtures.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string): void => { git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message); };
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

const LEGACY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

function setup(init: (repo: string) => void = (repo) => execFileSync('git', ['init', '-q', repo])) {
  const base = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  temps.push(base);
  const repo = join(base, 'repo');
  init(repo);
  writeFileSync(join(repo, 'config.ts'), `export const region = 'us-east-1';\n// legacy: ${LEGACY}\n`);
  git(repo, 'add', '.');
  commit(repo, 'fixture');
  const root = join(base, 'worktrees');
  const handle = new WorktreeManager(root).create(repo, 'T-1', 'builder-test');
  return { base, repo, root, handle };
}

// Synthetic, well-formed-looking values assembled at runtime so this file holds no literal credential.
const fake = {
  aws: ['AKIA', 'Q3EXAMPLEKEY12345'].join('').slice(0, 20),
  github: ['ghp', '_', 'a'.repeat(36)].join(''),
  anthropic: ['sk-ant', '-api03-', 'b'.repeat(40)].join(''),
  key: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
  pgp: ['-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----'].join(''),
  perplexity: ['pplx', '-', 'c'.repeat(48)].join(''),
  npm: ['npm', '_', 'd'.repeat(36)].join(''),
  gitlab: ['glpat', '-', 'e'.repeat(20)].join(''),
  huggingface: ['hf', '_', 'f'.repeat(34)].join(''),
};
const treeScan = (handle: { path: string; baseSha: string }, maxBytes?: number) => scanForNewSecrets(handle.path, handle.baseSha, workingTreeState(handle.path).tree, maxBytes);

describe('secret scan before commit approval', () => {
  it('reports new credential-looking strings by location and kind only', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'settings.ts'), `const a = '${fake.aws}';\nconst b = '${fake.github}';\nconst c = '${fake.anthropic}';\n`);
    writeFileSync(join(handle.path, 'id'), `${fake.key}\nMII...\n`);
    writeFileSync(join(handle.path, 'tokens.txt'), [fake.pgp, fake.perplexity, fake.npm, fake.gitlab, fake.huggingface].join('\n'));
    const scan = treeScan(handle);
    expect(scan.findings).toEqual(expect.arrayContaining([
      { path: 'settings.ts', line: 1, kind: 'AWS access key id' },
      { path: 'settings.ts', line: 2, kind: 'GitHub token' },
      { path: 'settings.ts', line: 3, kind: 'Anthropic API key' },
      { path: 'id', line: 1, kind: 'private key' },
      { path: 'tokens.txt', line: 1, kind: 'private key' },
      { path: 'tokens.txt', line: 2, kind: 'Perplexity API key' },
      { path: 'tokens.txt', line: 3, kind: 'npm token' },
      { path: 'tokens.txt', line: 4, kind: 'GitLab token' },
      { path: 'tokens.txt', line: 5, kind: 'Hugging Face token' },
    ]));
    expect(scan.unscanned).toEqual([]);
    expect(JSON.stringify(scan)).not.toContain(fake.github);
  });

  it('ignores values already present in the base revision at the same path', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'config.ts'), `export const region = 'eu-west-1';\n// legacy: ${LEGACY}\n`);
    expect(treeScan(handle)).toEqual({ findings: [], unscanned: [] });
    writeFileSync(join(handle.path, 'copy.ts'), `// ${LEGACY}\n`);
    expect(treeScan(handle).findings).toEqual([{ path: 'copy.ts', line: 1, kind: 'AWS access key id' }]);
  });

  it('scans binary, UTF-16, large and oddly named files instead of skipping them', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fake.github), Buffer.from([0])]));
    writeFileSync(join(handle.path, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x = ${fake.npm}\n`, 'utf16le')]));
    writeFileSync(join(handle.path, 'package-lock.json'), `${' '.repeat(2 * 1024 * 1024)}\n"${fake.github}"\n`);
    const odd = Buffer.from([0x6f, 0x64, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]); // "odd\xff.txt", not valid UTF-8
    writeFileSync(Buffer.concat([Buffer.from(`${handle.path}/`), odd]), `${fake.aws}\n`);
    const scan = treeScan(handle);
    const kinds = Object.fromEntries(scan.findings.map((item) => [item.path, item.kind]));
    expect(kinds).toMatchObject({ 'blob.bin': 'GitHub token', 'utf16.txt': 'npm token', 'package-lock.json': 'GitHub token' });
    expect(scan.findings.some((item) => item.path.startsWith('odd') && item.kind === 'AWS access key id')).toBe(true);
    expect(scan.findings.find((item) => item.path === 'package-lock.json')?.line).toBe(2);
  });

  it('lists files past the scan budget instead of passing them', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'small.txt'), 'fine\n');
    writeFileSync(join(handle.path, 'large.txt'), 'x'.repeat(4096));
    expect(treeScan(handle, 1024)).toEqual({ findings: [], unscanned: ['large.txt'] });
  });
});

describe('secret scan of agent-made history', () => {
  it('finds a credential added and removed again, however many commits follow', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'config.ts'), `export const token = '${fake.github}';\n`);
    git(handle.path, 'add', '.'); commit(handle.path, 'add token');
    writeFileSync(join(handle.path, 'config.ts'), 'export const token = process.env.TOKEN;\n');
    git(handle.path, 'add', '.'); commit(handle.path, 'remove token');
    for (let index = 0; index < 25; index += 1) { writeFileSync(join(handle.path, 'notes.txt'), `${index}\n`); git(handle.path, 'add', '.'); commit(handle.path, `note ${index}`); }
    expect(scanHistoryForNewSecrets(handle.path, handle.baseSha)).toEqual({ findings: [{ path: 'config.ts', line: 1, kind: 'GitHub token' }], unscanned: [] });
  });

  it('scans the agent\'s commit messages, which a push publishes too', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'notes.txt'), 'x\n');
    git(handle.path, 'add', '.');
    commit(handle.path, `chore: use ${fake.github} for the deploy`);
    const scan = scanHistoryForNewSecrets(handle.path, handle.baseSha);
    expect(scan.findings).toEqual([{ path: `commit ${git(handle.path, 'rev-parse', 'HEAD').slice(0, 12)}`, line: 6, kind: 'GitHub token' }]);
  });

  it('fails closed past the budget and ignores values the base already had', () => {
    const { handle } = setup();
    writeFileSync(join(handle.path, 'config.ts'), `// still ${LEGACY}\n`);
    git(handle.path, 'add', '.'); commit(handle.path, 'edit');
    expect(scanHistoryForNewSecrets(handle.path, handle.baseSha)).toEqual({ findings: [], unscanned: [] });
    writeFileSync(join(handle.path, 'big.txt'), 'y'.repeat(4096));
    git(handle.path, 'add', '.'); commit(handle.path, 'big');
    expect(scanHistoryForNewSecrets(handle.path, handle.baseSha, 'HEAD', 1024).unscanned).toEqual(['big.txt']);
  });
});

describe('explicit worktree cleanup', () => {
  it('removes only clean Code Conductor worktrees and keeps their branches', () => {
    const { repo, root, handle } = setup();
    writeFileSync(join(handle.path, 'wip.txt'), 'not committed\n');
    expect(() => removeCleanAgentWorktree(handle.path, root, handle.branch)).toThrow('uncommitted changes');
    rmSync(join(handle.path, 'wip.txt'));
    mkdirSync(join(root, 'elsewhere'));
    expect(() => removeCleanAgentWorktree(handle.path, join(root, 'elsewhere'), handle.branch)).toThrow('not under the Code Conductor worktree root');
    removeCleanAgentWorktree(handle.path, root, handle.branch);
    expect(existsSync(handle.path)).toBe(false);
    expect(git(repo, 'branch', '--list', handle.branch)).toContain(handle.branch);
  });

  it('keeps a worktree whose edit is hidden from the stat cache', () => {
    const { repo, root, handle } = setup();
    git(repo, 'config', 'core.checkStat', 'minimal');
    git(repo, 'config', 'core.trustctime', 'false');
    const file = join(handle.path, 'config.ts');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(file, past, past);
    git(handle.path, 'update-index', '--refresh');
    rewriteKeepingTimes(file, (text) => text.replace('us-east-1', 'us-east-2'));
    expect(git(handle.path, 'status', '--porcelain')).toBe('');
    expect(agentWorktreeRemovalProblem(handle.path, root, handle.branch)).toBe('it has uncommitted changes');
  });

  it('keeps worktrees on another branch or a detached HEAD, whose commits a removal could orphan', () => {
    const { root, handle } = setup();
    git(handle.path, 'switch', '-q', '--detach');
    writeFileSync(join(handle.path, 'detached.txt'), 'x\n');
    git(handle.path, 'add', '.'); commit(handle.path, 'detached work');
    expect(() => removeCleanAgentWorktree(handle.path, root, handle.branch)).toThrow('a detached HEAD checked out');
    git(handle.path, 'switch', '-q', '-c', 'feature/person');
    expect(() => removeCleanAgentWorktree(handle.path, root, handle.branch)).toThrow('refs/heads/feature/person checked out');
    expect(existsSync(handle.path)).toBe(true);
  });

  it('leaves other worktrees\' registrations alone, even when their directory is missing', () => {
    const { base, repo, root, handle } = setup();
    const person = join(base, 'person-feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', person);
    writeFileSync(join(person, 'staged.txt'), 'staged\n');
    git(person, 'add', 'staged.txt');
    renameSync(person, `${person}.unmounted`);
    removeCleanAgentWorktree(handle.path, root, handle.branch);
    expect(existsSync(join(repo, '.git', 'worktrees', 'person-feature'))).toBe(true);
    renameSync(`${person}.unmounted`, person);
    expect(git(person, 'status', '--porcelain')).toContain('A  staged.txt');
  });

  it('works for a repository whose Git directory is elsewhere', () => {
    const { base, root, handle } = setup((repo) => execFileSync('git', ['init', '-q', `--separate-git-dir=${join(repo, '..', 'repo.git')}`, repo]));
    removeCleanAgentWorktree(handle.path, root, handle.branch);
    expect(existsSync(handle.path)).toBe(false);
    expect(git(join(base, 'repo'), 'branch', '--list', handle.branch)).toContain(handle.branch);
  });
});
