import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorktreeRemovalProblem, branchCommit, commitsSince, countRedactions, gitControlState, gitHead, nestedRepositories, pushCommit, redactSecrets, redactUrl, removeCleanAgentWorktree, scanForNewSecrets, scanHistoryForNewSecrets, workingTreeState, WorktreeManager } from '../../packages/git/src/index.js';
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

describe('redaction markers', () => {
  it('counts exactly the markers redactSecrets writes', () => {
    const token = ['ghp', '_', 'a'.repeat(36)].join('');
    const { text, redacted } = redactSecrets(`one ${LEGACY}, two ${token}, again ${LEGACY}`);
    expect(redacted).toBe(3);
    expect(countRedactions(text)).toBe(3);
    // Text that only looks like a marker is not one.
    expect(countRedactions('[redacted something else] [redacted ] [redacted')).toBe(0);
  });

  it('counts in linear time, whatever an agent wrote', () => {
    // An unclosed marker prefix repeated: quadratic for the regular expression this replaces
    // (about 20 s at this size, against milliseconds), so a regression fails by the timeout.
    expect(countRedactions('[redacted '.repeat(50_000))).toBe(0);
    expect(countRedactions('[redacted AWS access key id]'.repeat(20_000))).toBe(20_000);
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

describe('repositories nested in an agent worktree (#35 review)', () => {
  // A repository inside the worktree whose own configuration runs a program whenever Git
  // re-reads its file; `committed` records it as a gitlink, as a submodule would be.
  function nest(worktree: string, committed: boolean, marker: string): void {
    const nested = join(worktree, 'vendor-lib');
    git(worktree, 'init', '-q', 'vendor-lib');
    writeFileSync(join(nested, 'lib.txt'), 'lib\n');
    git(nested, 'add', 'lib.txt'); commit(nested, 'lib');
    git(nested, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
    writeFileSync(join(nested, '.git', 'info', 'attributes'), '* filter=x\n');
    if (committed) { git(worktree, 'add', 'vendor-lib'); commit(worktree, 'gitlink'); }
    const later = new Date(Date.now() + 5000);
    utimesSync(join(nested, 'lib.txt'), later, later);
  }

  it.each([['committed as a gitlink', true], ['untracked', false]])('lists a nested repository (%s) without entering it, and never removes its worktree', (_label, committed) => {
    const { base, root, handle } = setup();
    const marker = join(base, 'nested-filter-ran');
    nest(handle.path, committed, marker);
    expect(nestedRepositories(handle.path)).toEqual(['vendor-lib']);
    expect(agentWorktreeRemovalProblem(handle.path, root, handle.branch)).toContain('a nested Git repository (vendor-lib), which Code Conductor runs no Git in');
    expect(() => removeCleanAgentWorktree(handle.path, root, handle.branch)).toThrow('nested Git repository');
    expect(existsSync(handle.path)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('ignores gitlinks that are not checked out and repositories Git ignores', () => {
    const { handle } = setup();
    git(handle.path, 'update-index', '--add', '--cacheinfo', `160000,${handle.baseSha},empty-submodule`);
    writeFileSync(join(handle.path, '.gitignore'), 'cache/\n');
    mkdirSync(join(handle.path, 'cache'));
    git(join(handle.path, 'cache'), 'init', '-q', 'tool');
    expect(nestedRepositories(handle.path)).toEqual([]);
  });

  it('counts a nested repository and its configuration as control state', () => {
    const { base, handle } = setup();
    const before = gitControlState(handle.path);
    nest(handle.path, true, join(base, 'unused'));
    const nested = gitControlState(handle.path);
    expect(nested?.worktree).not.toBe(before?.worktree);
    expect(nested?.shared).toBe(before?.shared);
    git(join(handle.path, 'vendor-lib'), 'config', 'core.sshCommand', 'planted');
    expect(gitControlState(handle.path)?.worktree).not.toBe(nested?.worktree);
  });
});

describe('Git processes and pushes (#35 review)', () => {
  it.skipIf(process.platform === 'win32')('never runs a git found through a relative or empty PATH entry', () => {
    const { base, handle } = setup();
    const marker = join(base, 'planted-git-ran');
    writeFileSync(join(handle.path, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(handle.path, 'git'), 0o755);
    const saved = process.env.PATH;
    try {
      for (const path of [`.${delimiter}${saved ?? ''}`, `${delimiter}${saved ?? ''}`]) {
        process.env.PATH = path;
        expect(gitHead(handle.path)).toBe(handle.baseSha);
      }
    } finally { process.env.PATH = saved; }
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('gives programs Git starts itself the same absolute-only PATH', () => {
    const { base, repo, handle } = setup();
    const official = join(base, 'bin');
    mkdirSync(official);
    writeFileSync(join(official, 'cc-test-filter'), '#!/bin/sh\ncat\n');
    chmodSync(join(official, 'cc-test-filter'), 0o755);
    const marker = join(base, 'planted-helper-ran');
    writeFileSync(join(handle.path, 'cc-test-filter'), `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(join(handle.path, 'cc-test-filter'), 0o755);
    // The person's own filter, named without a path, as Git configuration commonly does.
    git(repo, 'config', 'filter.t.clean', 'cc-test-filter');
    writeFileSync(join(handle.path, '.gitattributes'), '*.txt filter=t\n');
    writeFileSync(join(handle.path, 'note.txt'), 'note\n');
    const saved = process.env.PATH;
    try {
      process.env.PATH = `.${delimiter}${official}${delimiter}${saved ?? ''}`;
      workingTreeState(handle.path);
    } finally { process.env.PATH = saved; }
    expect(existsSync(marker)).toBe(false);
  });

  it('pushes over HTTPS or SSH only, unless told otherwise', () => {
    const { base, handle } = setup();
    const remote = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', remote);
    expect(() => pushCommit(handle.path, remote, handle.baseSha, handle.branch)).toThrow(/transport 'file' not allowed/);
    expect(git(remote, 'for-each-ref')).toBe('');
    pushCommit(handle.path, remote, handle.baseSha, handle.branch, ['file']);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe(`refs/heads/${handle.branch}`);
  });

  it('shows remote URLs without credentials, even when they cannot be parsed', () => {
    const token = ['ghp', '_', 'z'.repeat(36)].join('');
    expect(redactUrl(`https://user:${token}@github.com/octo/widgets.git`)).toBe('https://github.com/octo/widgets.git');
    expect(redactUrl(`https://github.com/octo/widgets.git?access_token=${token}#frag`)).toBe('https://github.com/octo/widgets.git');
    expect(redactUrl('https://user:pa#ss@github.com/octo/widgets.git')).toBe('https://[redacted]@github.com/octo/widgets.git');
    expect(redactUrl('https://user:secret@github.com:99999/octo/widgets.git')).toBe('https://[redacted]@github.com:99999/octo/widgets.git');
    expect(redactUrl(`${token}@github.com:octo/widgets.git`)).toBe('[redacted]@github.com:octo/widgets.git');
    expect(redactUrl(`/srv/${token}/widgets.git`)).toBe('/srv/[redacted GitHub token]/widgets.git');
    expect(redactUrl('git@github.com:octo/widgets.git')).toBe('[redacted]@github.com:octo/widgets.git');
    // Parses as an opaque URL with scheme `user:`, so it has no user fields to clear.
    expect(redactUrl('user:secret@github.com:octo/widgets.git')).toBe('[redacted]@github.com:octo/widgets.git');
    // One that cannot be parsed and spans lines is not shown: a line break could hide a
    // query, a credential before a later `@`, or text after an `@` inside a query.
    for (const url of ['user:secret@host:path?access_token=abc\nrest', 'x\nuser:secret@host:path', 'git@github.com:octo/widgets.git\n?token=abc@SECRET', 'git@github.com:octo/widgets.git\r#frag@SECRET', 'git@github.com:octo/widgets.git\u2028?token=abc@SECRET', 'git@github.com:octo/widgets.git\u2029?token=abc@SECRET']) {
      expect(redactUrl(url), JSON.stringify(url)).toBe('[redacted]');
    }
    // Quadratic for the query replace without that rule (about 12 s at this size).
    expect(redactUrl(`${'?'.repeat(100_000)}\n`)).toBe('[redacted]');
  });
});

// Rewrites one commit's first parent in a commit-graph file (format 1, SHA-1) as an agent
// could, and fixes the file's checksum so Git trusts it.
function forgeCommitGraph(file: string, child: string, parent: string): void {
  const data = readFileSync(file);
  expect(data.subarray(0, 4).toString('latin1')).toBe('CGPH');
  const offsets = new Map<string, number>();
  for (let index = 0; index <= data[6]!; index += 1) offsets.set(data.subarray(8 + 12 * index, 12 + 12 * index).toString('latin1'), Number(data.readBigUInt64BE(12 + 12 * index)));
  const lookup = offsets.get('OIDL')!;
  const count = data.readUInt32BE(offsets.get('OIDF')! + 255 * 4);
  const ids = Array.from({ length: count }, (_, index) => data.subarray(lookup + 20 * index, lookup + 20 * index + 20).toString('hex'));
  data.writeUInt32BE(ids.indexOf(parent), offsets.get('CDAT')! + 36 * ids.indexOf(child) + 20);
  createHash('sha1').update(data.subarray(0, -20)).digest().copy(data, data.length - 20);
  // Git writes the file read-only; its owner, as an agent would be, can still replace it.
  chmodSync(file, 0o644);
  writeFileSync(file, data);
}

describe('agent history the person would merge (#104 review)', () => {
  const repository = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'cc-history-'));
    temps.push(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.'); commit(repo, 'base');
    return repo;
  };

  it('sees the commits a forged commit-graph hides', () => {
    const repo = repository();
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'secret.txt'), `${fake.github}\n`);
    git(repo, 'add', '.'); commit(repo, 'hidden');
    writeFileSync(join(repo, 'secret.txt'), 'gone\n');
    git(repo, 'add', '.'); commit(repo, 'cover');
    const cover = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'more.txt'), 'more\n');
    git(repo, 'add', '.'); commit(repo, 'tip');
    git(repo, 'commit-graph', 'write', '--reachable');
    forgeCommitGraph(join(repo, '.git', 'objects', 'info', 'commit-graph'), cover, base);
    // Git itself now skips the commit that added the credential...
    expect(git(repo, 'rev-list', `${base}..HEAD`).split('\n')).toHaveLength(2);
    // ...Code Conductor's own Git does not read the graph.
    expect(commitsSince(repo, base).commits).toHaveLength(3);
    expect(scanHistoryForNewSecrets(repo, base).findings.map((finding) => finding.path)).toEqual(['secret.txt']);
  });

  it('looks a branch up by its exact ref, never a tag spelt like it', () => {
    const repo = repository();
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'cc/T-1/builder');
    expect(branchCommit(repo, 'cc/T-1/builder')).toBe(head);
    git(repo, 'tag', 'refs/heads/cc/T-1/gone');
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/cc/T-1/gone^{commit}')).toBe(head);
    expect(branchCommit(repo, 'cc/T-1/gone')).toBeUndefined();
  });
});
