import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// scripts/owner holds the PowerShell scripts the repository owner runs (#3, #4, #14). They
// run here against tests/scripts/fake-gh.mjs, a model of one repository, never GitHub.
const OWNER = resolve('scripts/owner');
const REPOSITORY = 'octo/repo';
const SHA = (digit: string): string => digit.repeat(40);
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

// GitHub's Ubuntu runners include PowerShell; without it, only the static checks run.
// Each PowerShell start takes a second or two there, and a test may start several.
const PWSH_TIMEOUT = 60_000;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

type Call = { argv?: string[]; method?: string; endpoint?: string; body?: unknown };
type State = Record<string, unknown> & { calls: Call[] };

function harness(initial: Record<string, unknown>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-owner-')));
  temps.push(base);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('tests/scripts/fake-gh.mjs'))} "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const statePath = join(base, 'state.json');
  writeFileSync(statePath, JSON.stringify({ repository: REPOSITORY, calls: [], nextId: 1, variables: {}, policies: [], ...initial }));
  const run = (script: string, args = '', cwd = base) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `& ${quote(join(OWNER, script))} ${args}`], {
    encoding: 'utf8', cwd, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: statePath, HOME: base, NO_COLOR: '1' },
  });
  const read = (): State => JSON.parse(readFileSync(statePath, 'utf8')) as State;
  const writes = (): string[] => read().calls.filter((call) => call.method && call.method !== 'GET').map((call) => `${call.method} ${call.endpoint}`);
  return { base, run, read, writes };
}

describe('scripts/owner, statically', () => {
  it.runIf(Boolean(process.env.CI))('has PowerShell in CI, so the PowerShell tests run there', () => {
    expect(hasPwsh).toBe(true);
  });

  it('requires exactly the checks the governance document lists, each a job that reports on every pull request', () => {
    const script = readFileSync(join(OWNER, 'Set-RepositoryGovernance.ps1'), 'utf8');
    const listed = [...(/\$RequiredChecks = @\(([^)]*)\)/.exec(script)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const doc = readFileSync('docs/REPOSITORY-GOVERNANCE.md', 'utf8');
    const table = doc.slice(doc.indexOf('## Required checks'), doc.indexOf('\n## ', doc.indexOf('## Required checks') + 1));
    const documented = table.split('\n').filter((line) => line.startsWith('| `')).flatMap((line) => [...line.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    expect(listed).toEqual(documented);
    type Trigger = { branches?: string[]; paths?: string[]; 'paths-ignore'?: string[] } | null;
    const jobs = new Map(readdirSync('.github/workflows').flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as { on: Record<string, Trigger>; jobs: Record<string, { name?: string; strategy?: { matrix?: { language?: string[] } } }> };
      return Object.entries(workflow.jobs).flatMap(([key, job]) => {
        const name = job.name ?? key;
        const names = name.includes('${{ matrix.language }}') ? (job.strategy?.matrix?.language ?? []).map((language) => name.replace('${{ matrix.language }}', language)) : [name];
        return names.map((each) => [each, workflow.on] as const);
      });
    }));
    expect(listed.length).toBeGreaterThan(0);
    for (const check of listed) {
      const on = jobs.get(check!);
      // A required check that does not report leaves pull requests pending (REPOSITORY-GOVERNANCE.md).
      expect(on && 'pull_request' in on, check).toBe(true);
      const trigger = on!.pull_request;
      expect(trigger?.paths ?? trigger?.['paths-ignore'], check).toBeUndefined();
      if (trigger?.branches) expect(trigger.branches, check).toContain('main');
    }
  });

  it('are ASCII only, which Windows PowerShell 5.1 reads the same without a byte-order mark', () => {
    for (const file of readdirSync(OWNER).filter((name) => /\.ps(m?1)$/.test(name))) {
      expect(/[^\x00-\x7f]/.test(readFileSync(join(OWNER, file), 'utf8')), file).toBe(false);
    }
  });
});

describe.skipIf(!hasPwsh)('scripts/owner, with PowerShell', { timeout: PWSH_TIMEOUT }, () => {
  it('parse without errors', () => {
    const files = readdirSync(OWNER).filter((name) => /\.ps(m?1)$/.test(name)).map((name) => quote(join(OWNER, name))).join(',');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `foreach ($f in @(${files})) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in @($e)) { "$f $x" } }`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('keep their help where Get-Help finds it', () => {
    for (const file of readdirSync(OWNER).filter((name) => name.endsWith('.ps1'))) {
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Help ${quote(join(OWNER, file))}).Synopsis`], { encoding: 'utf8' });
      // Without comment-based help, Get-Help prints the generated syntax, which starts with the file name.
      expect(result.stdout.trim(), file).not.toMatch(new RegExp(`^${file.replace('.', '\\.')}`));
      expect(result.stdout.trim().length, file).toBeGreaterThan(20);
    }
  });

  describe('Set-RepositoryGovernance.ps1', () => {
    const fresh = () => ({
      repo: {
        default_branch: 'main', permissions: { admin: true, push: true }, delete_branch_on_merge: false, allow_update_branch: false,
        allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true,
        security_and_analysis: { secret_scanning: { status: 'disabled' }, secret_scanning_push_protection: { status: 'disabled' } },
      },
      rulesets: [], reporting: false, workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true },
    });
    const checks = ['quality', 'audit', 'lockfile', 'VSIX packaging preflight', 'dependency-review', 'Analyze javascript-typescript', 'Analyze actions'];

    it('creates the two rulesets and the settings, reads them back, and updates in place when run again', () => {
      const { base, run, read, writes } = harness(fresh());
      const evidence = join(base, 'evidence.md');
      const first = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY} -EvidencePath ${quote(evidence)}`);
      expect(first.status, first.stderr + first.stdout).toBe(0);
      expect(writes()).toEqual([
        'POST repos/octo/repo/rulesets', 'POST repos/octo/repo/rulesets', 'PATCH repos/octo/repo', 'PATCH repos/octo/repo',
        'PUT repos/octo/repo/private-vulnerability-reporting', 'PUT repos/octo/repo/actions/permissions/workflow',
      ]);
      const state = read() as State & { rulesets: unknown[]; repo: Record<string, unknown>; workflow: unknown };
      expect(state.rulesets).toEqual([
        {
          id: 1, name: 'Protect main', target: 'branch', enforcement: 'active', bypass_actors: [],
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          rules: [
            { type: 'deletion' },
            { type: 'non_fast_forward' },
            { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true } },
            { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: checks.map((context) => ({ context, integration_id: 15368 })) } },
          ],
        },
        {
          id: 2, name: 'Protect tags', target: 'tag', enforcement: 'active',
          bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
          conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
          rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
        },
      ]);
      expect(state.repo).toMatchObject({
        delete_branch_on_merge: true, allow_update_branch: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true,
        security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
      });
      expect(state.workflow).toEqual({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
      const report = readFileSync(evidence, 'utf8');
      expect(report.match(/\| pass \|/g)).toHaveLength(9);
      expect(report).not.toContain('FAIL');
      expect(report).toContain('"context": "Analyze actions"');

      const second = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY} -EvidencePath ${quote(evidence)}`);
      expect(second.status, second.stderr + second.stdout).toBe(0);
      expect(writes().slice(6)).toEqual(['PUT repos/octo/repo/rulesets/1', 'PUT repos/octo/repo/rulesets/2']);
      expect(second.stdout).toContain('Already in place: Turn on private vulnerability reporting');
      expect(read().rulesets).toHaveLength(2);
    });

    it('changes nothing with -WhatIf, and prints each request instead', () => {
      const { base, run, writes } = harness(fresh());
      const result = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY} -WhatIf -EvidencePath ${quote(join(base, 'evidence.md'))}`);
      expect(result.status, result.stderr).toBe(0);
      expect(writes()).toEqual([]);
      expect(result.stdout).toContain('What if');
      expect(result.stdout).toContain('"name": "Protect main"');
      expect(readdirSync(base)).not.toContain('evidence.md');
    });

    it('updates a ruleset made another way for the same refs in place, keeping its name', () => {
      const existing = { id: 9, name: 'Protect main branch', target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'deletion' }] };
      const { run, read, writes } = harness({ ...fresh(), rulesets: [existing], nextId: 10 });
      const result = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(writes().slice(0, 2)).toEqual(['PUT repos/octo/repo/rulesets/9', 'POST repos/octo/repo/rulesets']);
      const state = read() as State & { rulesets: Array<{ id: number; name: string; target: string; rules: unknown[] }> };
      expect(state.rulesets.map((ruleset) => [ruleset.id, ruleset.name, ruleset.target])).toEqual([[9, 'Protect main branch', 'branch'], [10, 'Protect tags', 'tag']]);
      expect(state.rulesets[0]!.rules).toHaveLength(4);
    });

    it('adds the Copilot review rule, checks it in the read-back, and sets only the merge methods it is given', () => {
      const { base, run, read } = harness(fresh());
      const evidence = join(base, 'evidence.md');
      const result = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY} -CopilotReview -MergeMethods squash -EvidencePath ${quote(evidence)}`);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(evidence, 'utf8')).toContain('| main: Copilot reviews each pull request | pass |');
      const state = read() as State & { rulesets: Array<{ rules: unknown[] }>; repo: Record<string, unknown> };
      expect(state.rulesets[0]!.rules).toContainEqual({ type: 'copilot_code_review', parameters: { review_on_push: false, review_draft_pull_requests: false } });
      expect(state.repo).toMatchObject({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false });
    });

    it.each([
      ['private vulnerability reporting stays off', { stuckReporting: true }, '| Private vulnerability reporting | FAIL |'],
      ['a required check is not enforced', { dropCheck: 'Analyze actions' }, '| main: every required check, from GitHub Actions, on an up-to-date branch | FAIL |'],
      ['a required check is accepted from any app', { unpinCheck: 'quality' }, '| main: every required check, from GitHub Actions, on an up-to-date branch | FAIL |'],
      ['someone may bypass the main ruleset', { forceMainBypass: true }, '| main: nobody may bypass | FAIL |'],
    ])('fails, after posting the read-back to #3, when %s', (_, fault, row) => {
      const { run, read } = harness({ ...fresh(), ...fault });
      const result = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY} -PostEvidence`);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('1 setting(s) did not read back as expected');
      const post = read().calls.find((call) => call.argv?.[0] === 'issue');
      expect(post?.argv?.slice(0, 5)).toEqual(['issue', 'comment', '3', '--repo', REPOSITORY]);
      expect(String(post?.body)).toContain(row);
    });

    it('refuses without admin access, before changing anything', () => {
      const { run, writes } = harness({ ...fresh(), repo: { ...fresh().repo, permissions: { admin: false, push: true } } });
      const result = run('Set-RepositoryGovernance.ps1', `-Repository ${REPOSITORY}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('lacks admin access');
      expect(writes()).toEqual([]);
    });
  });

  describe('Remove-StaleBranches.ps1', () => {
    const branches = () => ({
      repo: { default_branch: 'main', permissions: { admin: false, push: true } },
      branches: [
        { name: 'main', protected: true, commit: { sha: SHA('a') } },
        { name: 'feat/open', protected: false, commit: { sha: SHA('b') }, ahead: 2 },
        { name: 'feat/merged', protected: false, commit: { sha: SHA('c') }, ahead: 1 },
        { name: 'feat/stale', protected: false, commit: { sha: SHA('d') }, ahead: 46 },
        { name: 'feat/contained', protected: false, commit: { sha: SHA('e') }, ahead: 0 },
        { name: 'release/keep', protected: false, commit: { sha: SHA('f') }, ahead: 3 },
        { name: 'locked', protected: true, commit: { sha: SHA('1') }, ahead: 1 },
        { name: 'feat/base', protected: false, commit: { sha: SHA('2') }, ahead: 3 },
        { name: 'feat/child', protected: false, commit: { sha: SHA('3') }, ahead: 4 },
        { name: 'feat/remerged', protected: false, commit: { sha: SHA('4') }, ahead: 2 },
      ],
      pulls: [
        { number: 1, state: 'open', merged_at: null, head: { ref: 'feat/open', sha: SHA('b') } },
        { number: 2, state: 'closed', merged_at: '2026-10-01T00:00:00Z', head: { ref: 'feat/merged', sha: SHA('c') } },
        { number: 3, state: 'closed', merged_at: null, head: { ref: 'feat/stale', sha: SHA('9') } },
        // A stacked pull request: deleting its base branch would close it.
        { number: 5, state: 'open', merged_at: null, head: { ref: 'feat/child', sha: SHA('3') }, base: { ref: 'feat/base' } },
        { number: 6, state: 'closed', merged_at: '2026-10-02T00:00:00Z', head: { ref: 'feat/remerged', sha: SHA('8') } },
      ],
    });

    it('keeps the default, protected and -Keep branches and the head or base of an open PR, and deletes the rest with a reason and a restore command', () => {
      const { run, read, writes } = harness(branches());
      const result = run('Remove-StaleBranches.ps1', `-Repository ${REPOSITORY} -Keep release/keep -Confirm:$false`);
      expect(result.status, result.stderr).toBe(0);
      expect(writes()).toEqual(['feat/merged', 'feat/stale', 'feat/contained', 'feat/remerged'].map((name) => `DELETE repos/octo/repo/git/refs/heads/${name}`));
      expect((read() as State & { branches: Array<{ name: string }> }).branches.map((branch) => branch.name)).toEqual(['main', 'feat/open', 'release/keep', 'locked', 'feat/base', 'feat/child']);
      expect(result.stdout).toContain('Keep feat/open (bbbbbbb): open pull request #1');
      expect(result.stdout).toContain('Keep feat/base (2222222): base of open pull request #5');
      expect(result.stdout).toContain('2 commit(s) not on main; commits added after merging #6');
      expect(result.stdout).toContain('Keep locked (1111111): protected');
      expect(result.stdout).toContain('merged in #2');
      expect(result.stdout).toContain('46 commit(s) not on main; closed unmerged: #3');
      expect(result.stdout).toContain('no commit that main lacks');
      expect(result.stdout).toContain(`To restore it: gh api repos/${REPOSITORY}/git/refs -f ref=refs/heads/feat/stale -f sha=${SHA('d')}`);
    });

    it('deletes nothing with -WhatIf', () => {
      const { run, writes } = harness(branches());
      const result = run('Remove-StaleBranches.ps1', `-Repository ${REPOSITORY} -WhatIf`);
      expect(result.status, result.stderr).toBe(0);
      expect(writes()).toEqual([]);
      expect(result.stdout).toContain('What if');
    });

    it('with -IncludeLocal, deletes a local branch only when the commit deleted on GitHub contains it', () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cc-owner-clone-')));
      temps.push(scratch);
      const clone = join(scratch, 'clone');
      const git = (...args: string[]) => spawnSync('git', ['-C', clone, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
      mkdirSync(clone);
      git('init', '-b', 'feat/current');
      git('commit', '--allow-empty', '-m', 'base');
      const first = git('rev-parse', 'HEAD').stdout.trim();
      git('remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`);
      git('branch', 'feat/behind');
      git('checkout', '-q', '-b', 'feat/unpushed');
      git('commit', '--allow-empty', '-m', 'never pushed');
      const second = git('rev-parse', 'HEAD').stdout.trim();
      git('checkout', '-q', 'feat/current');
      git('update-ref', 'refs/remotes/origin/feat/unpushed', first);
      const { run } = harness({
        repo: { default_branch: 'main', permissions: { admin: false, push: true } }, pulls: [],
        branches: [
          { name: 'main', protected: true, commit: { sha: SHA('a') } },
          // GitHub's feat/behind is ahead of the local one; the local feat/unpushed is ahead of GitHub's.
          { name: 'feat/behind', protected: false, commit: { sha: second }, ahead: 2 },
          { name: 'feat/unpushed', protected: false, commit: { sha: first }, ahead: 1 },
          { name: 'feat/current', protected: false, commit: { sha: first }, ahead: 1 },
        ],
      });
      const result = run('Remove-StaleBranches.ps1', `-Repository ${REPOSITORY} -IncludeLocal -Confirm:$false`, clone);
      expect(result.status, result.stderr).toBe(0);
      expect(git('for-each-ref', '--format=%(refname)').stdout.trim().split('\n')).toEqual(['refs/heads/feat/current', 'refs/heads/feat/unpushed']);
      expect(result.stdout).toContain(`Deleted the local feat/behind. To restore it: git branch feat/behind ${first}`);
      expect(result.stdout).toContain(`Kept the local feat/unpushed (${second.slice(0, 7)}): it may hold commits that were not on GitHub.`);
      expect(result.stdout).toContain('Kept the local feat/current: it is checked out here.');
    });

    it('with -IncludeLocal, refuses a clone of another repository before deleting anything', () => {
      const { base, run, writes } = harness(branches());
      spawnSync('git', ['init', base]);
      spawnSync('git', ['-C', base, 'remote', 'add', 'origin', 'https://github.com/octo/repo-fork.git']);
      const result = run('Remove-StaleBranches.ps1', `-Repository ${REPOSITORY} -IncludeLocal -Confirm:$false`);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('needs a clone of octo/repo');
      expect(writes()).toEqual([]);
    });
  });

  describe('Set-MarketplaceEnvironment.ps1', () => {
    const owner = () => ({ repo: { default_branch: 'main', permissions: { admin: true, push: true } }, user: { login: 'owner', id: 42 } });

    it('sets the publisher variable and a reviewed, v*-tag-only environment, once', () => {
      const { run, read } = harness(owner());
      for (let i = 0; i < 2; i += 1) {
        const result = run('Set-MarketplaceEnvironment.ps1', `-Repository ${REPOSITORY} -Publisher my-publisher`);
        expect(result.status, result.stderr).toBe(0);
      }
      const state = read() as State & { variables: unknown; environment: unknown; policies: unknown[] };
      expect(state.variables).toEqual({ VSCE_PUBLISHER: 'my-publisher' });
      expect(state.environment).toEqual({
        wait_timer: 0, prevent_self_review: false, reviewers: [{ type: 'User', id: 42 }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      });
      expect(state.policies).toEqual([{ id: 1, name: 'v*', type: 'tag' }]);
    });

    it('warns about any other ref allowed to deploy, and rejects a publisher ID packaging would reject', () => {
      const { run } = harness({ ...owner(), policies: [{ id: 7, name: 'main', type: 'branch' }] });
      const warned = run('Set-MarketplaceEnvironment.ps1', `-Repository ${REPOSITORY} -Publisher my-publisher`);
      expect(warned.status, warned.stderr).toBe(0);
      expect(warned.stdout + warned.stderr).toContain("also lets 'main' deploy");
      expect(run('Set-MarketplaceEnvironment.ps1', `-Repository ${REPOSITORY} -Publisher 'my publisher'`).status).not.toBe(0);
    });
  });

  describe('Invoke-WorkstationValidation.ps1', () => {
    // passing names a client (both modes) or client:mode.
    function workstation(state: Record<string, unknown> = {}, { passing = ['codex'], doctorExit = 0, compressExit = 0 } = {}) {
      const context = harness(state);
      const runtime = join(context.base, 'ext', 'publisher.code-conductor-vscode-0.1.0', 'dist', 'ccon.js');
      mkdirSync(join(runtime, '..'), { recursive: true });
      // A stand-in for the bundled runtime: Doctor leaks a home path, an address and secrets
      // (built here, so no secret scanner mistakes this file for a leak); smoke passes only
      // for the clients in passing; compress returns content that must not be kept.
      writeFileSync(runtime, `const [command, client, , mode] = process.argv.slice(2);
const passing = ${JSON.stringify(passing)};
const jwt = ['{"alg":"none"}', '{"sub":"1234567890"}', 'signature-bytes'].map((part) => Buffer.from(part).toString('base64url')).join('.');
if (command === 'doctor') {
  console.log('OK harness claude: version=1.0 config=' + process.env.HOME + '/.claude user=someone@example.com');
  console.log('INFO keys ' + 'AIza' + 'Q'.repeat(35) + ' AccountKey=' + 'k'.repeat(24) + ';EndpointSuffix=core.windows.net ' + jwt);
  process.exit(${doctorExit});
}
if (command === 'harness-smoke') { const ok = passing.includes(client) || passing.includes(client + ':' + mode); (ok ? console.log : console.error)('SMOKE ' + (ok ? 'PASS' : 'FAIL') + ' ' + client + ' cli ' + mode); process.exit(ok ? 0 : 1); }
if (command === 'compress' && ${compressExit}) { console.error('ERROR compress.read_failed: refused'); process.exit(${compressExit}); }
if (command === 'compress') { console.log('Mode: lossless\\nEstimated tokens saved: 3 (5%)\\n\\n--- Prepared Content ---\\nREPOSITORY_CONTENT'); process.exit(0); }
process.exit(2);
`);
      const repository = join(context.base, 'repo');
      mkdirSync(repository);
      writeFileSync(join(repository, 'README.md'), '# Example\n');
      return { ...context, runtime, repository, report: join(context.base, 'report.md') };
    }

    it('writes the section 13 checklist with what it can collect, redacted, and leaves the rest to you', () => {
      const { run, runtime, repository, report } = workstation();
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -Smoke claude,codex,kiro -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const text = readFileSync(report, 'utf8');
      expect(text).toContain('- [x] `ccon doctor`: exit 0');
      expect(text).toContain('- [ ] `ccon harness-smoke` read and modify: claude read FAIL; codex read pass; codex modify pass; kiro read not run');
      expect(text).toContain("pass -AckKiroPolicy after reading Kiro's current subscription and automation terms");
      expect(text).toContain('Process check: none named the extension folder');
      expect(text).toContain('- [ ] Package, checksums and attestation: *fill in*');
      expect(text).toContain('- [ ] Final readiness decision, and who made it: *fill in*');
      expect(text).toContain('config=~/.claude user=[email]');
      expect(text).toContain('README.md exit 0, as documented for this OS: Estimated tokens saved: 3 (5%)');
      expect(text).not.toContain('REPOSITORY_CONTENT');
      expect(text).not.toContain('someone@example.com');
      expect(text).toContain('INFO keys [redacted] AccountKey=[redacted];EndpointSuffix=core.windows.net [redacted]');
      expect(result.stdout).toContain(`gh issue comment 4 --repo saulpatinojr/Proj-Code_Conductor --body-file "${report}"`);
    });

    it('checks each release file against SHA256SUMS and an attestation pinned to the Release workflow, tag and commit', () => {
      const { base, run, read, runtime, repository, report } = workstation({ attestationOk: true, commitOnMain: true });
      const files = join(base, 'release');
      mkdirSync(files);
      writeFileSync(join(files, 'code-conductor-0.2.0.vsix'), 'package');
      writeFileSync(join(files, 'code-conductor-0.2.0.cdx.json'), '{}');
      const sum = (text: string) => createHash('sha256').update(text).digest('hex');
      writeFileSync(join(files, 'SHA256SUMS'), `${sum('package')}  code-conductor-0.2.0.vsix\n${sum('tampered')}  code-conductor-0.2.0.cdx.json\n`);
      const commit = SHA('7');
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -PackageDirectory ${quote(files)} -SourceCommit ${commit} -GitHubRepository ${REPOSITORY} -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const text = readFileSync(report, 'utf8');
      expect(text).toContain('sha256 code-conductor-0.2.0.vsix : OK');
      expect(text).toContain('sha256 code-conductor-0.2.0.cdx.json : FAILED');
      expect(text).toContain(`commit ${commit} on main: yes`);
      expect(text).toContain('- [ ] Package, checksums and attestation: FAILED, see below');
      const verify = read().calls.find((call) => call.argv?.[0] === 'attestation');
      expect(verify?.argv).toEqual(['attestation', 'verify', join(files, 'code-conductor-0.2.0.vsix'), '--repo', REPOSITORY,
        '--cert-identity', `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/tags/v0.2.0`,
        '--source-ref', 'refs/tags/v0.2.0', '--source-digest', commit, '--deny-self-hosted-runners']);
    });

    it.each([
      [['claude', 'codex', 'kiro'], '[x]', 'kiro modify pass'],
      [['claude', 'codex', 'kiro:read'], '[ ]', 'kiro modify FAIL'],
    ])('ticks the smoke tests only when read and modify passed for all three clients (%j)', (passing, mark, last) => {
      const { run, runtime, repository, report } = workstation({}, { passing });
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -Smoke claude,codex,kiro -AckKiroPolicy -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(readFileSync(report, 'utf8')).toContain(`- ${mark} \`ccon harness-smoke\` read and modify: claude read pass; claude modify pass; codex read pass; codex modify pass; kiro read pass; ${last}`);
    });

    it('leaves Doctor and the compress boundary unticked when they did not pass', () => {
      const { run, runtime, repository, report } = workstation({}, { doctorExit: 1, compressExit: 1 });
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const text = readFileSync(report, 'utf8');
      expect(text).toContain('- [ ] `ccon doctor`: exit 1');
      // On Linux, compress reads the file; a refusal here is not what ADR 0007 documents.
      expect(text).toContain('- [ ] Compress boundary: README.md exit 1, NOT as documented for this OS: ERROR compress.read_failed: refused');
    });

    it.each([
      ['lists nothing', () => '', ['sha256 code-conductor-0.2.0.vsix : FAILED, not listed in SHA256SUMS', '*.vsix : FAILED, none verified', '*.cdx.json : FAILED, none verified']],
      ['lists only the SBOM', (sum: (text: string) => string) => `${sum('{}')}  code-conductor-0.2.0.cdx.json\n`, ['sha256 code-conductor-0.2.0.vsix : FAILED, not listed in SHA256SUMS', '*.vsix : FAILED, none verified']],
    ])('fails the package when SHA256SUMS %s', (_, sums, lines) => {
      const { base, run, runtime, repository, report } = workstation({ attestationOk: true, commitOnMain: true });
      const files = join(base, 'release');
      mkdirSync(files);
      writeFileSync(join(files, 'code-conductor-0.2.0.vsix'), 'package');
      writeFileSync(join(files, 'code-conductor-0.2.0.cdx.json'), '{}');
      writeFileSync(join(files, 'SHA256SUMS'), sums((text) => createHash('sha256').update(text).digest('hex')));
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -PackageDirectory ${quote(files)} -SourceCommit ${SHA('7')} -GitHubRepository ${REPOSITORY} -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const text = readFileSync(report, 'utf8');
      expect(text).toContain('- [ ] Package, checksums and attestation: FAILED, see below');
      for (const line of lines) expect(text).toContain(line);
    });

    it('passes the package when both files are listed, match and are attested', () => {
      const { base, run, runtime, repository, report } = workstation({ attestationOk: true, commitOnMain: true });
      const files = join(base, 'release');
      mkdirSync(files);
      const sum = (text: string) => createHash('sha256').update(text).digest('hex');
      writeFileSync(join(files, 'code-conductor-0.2.0.vsix'), 'package');
      writeFileSync(join(files, 'code-conductor-0.2.0.cdx.json'), '{}');
      writeFileSync(join(files, 'SHA256SUMS'), `${sum('package')}  code-conductor-0.2.0.vsix\n${sum('{}')}  code-conductor-0.2.0.cdx.json\n`);
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -PackageDirectory ${quote(files)} -SourceCommit ${SHA('7')} -GitHubRepository ${REPOSITORY} -OutFile ${quote(report)}`);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(readFileSync(report, 'utf8')).toContain('- [x] Package, checksums and attestation: verified');
    });

    it('names a process running from the extension folder by its ID and name, never its arguments', () => {
      const { run, runtime, repository, report } = workstation();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', runtime, '--token=ARGUMENT_TO_KEEP_OUT'], { stdio: 'ignore' });
      try {
        const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -Repository ${quote(repository)} -OutFile ${quote(report)}`);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        const text = readFileSync(report, 'utf8');
        expect(text).toContain('Process check: 1 process(es) named the extension folder, below');
        expect(text).toMatch(new RegExp(`\\n${child.pid} \\S+, runs ccon\\.js\\n`));
        expect(text).not.toContain('ARGUMENT_TO_KEEP_OUT');
      } finally {
        child.kill();
      }
    });

    it('needs -SourceCommit with -PackageDirectory', () => {
      const { base, run, runtime } = workstation();
      const result = run('Invoke-WorkstationValidation.ps1', `-CconPath ${quote(runtime)} -PackageDirectory ${quote(base)}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('-PackageDirectory needs -SourceCommit');
    });
  });
});
