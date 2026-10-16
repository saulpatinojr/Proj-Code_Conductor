import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubAuthStatus, pullRequestStatus, summarizePullRequest, type GhRunner } from '../../packages/github-gate/src/index.js';

const head = 'a'.repeat(40);
const green = {
  number: 7, url: 'https://github.com/octo/widgets/pull/7', state: 'OPEN', isDraft: false, headRefName: 'cc/T-1/builder', headRefOid: head, baseRefName: 'main',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/octo/widgets/actions/runs/1' },
    { __typename: 'StatusContext', context: 'legacy/ci', state: 'SUCCESS' },
  ],
  reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: head } }],
};

describe('GitHub gate helpers', () => {
  it('preserves spawn diagnostics when the GitHub CLI cannot be found', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = githubAuthStatus(resolve('.'));
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.stderr).toMatch(/ENOENT|spawnSync gh/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('asks gh for the fields the summary needs, for an explicit pull request', () => {
    const calls: string[][] = [];
    const run: GhRunner = (_cwd, args) => { calls.push(args); return { ok: true, status: 0, stdout: '{}', stderr: '' }; };
    pullRequestStatus('.', '7', run);
    expect(calls[0]?.slice(0, 3)).toEqual(['pr', 'view', '7']);
    expect(calls[0]?.at(-1)).toContain('statusCheckRollup');
  });

  it('is ready only when every native signal is green', () => {
    const summary = summarizePullRequest(green);
    expect(summary).toMatchObject({ ready: true, blockers: [], checks: { passed: 2, total: 2 } });
  });

  it('reports failed and pending checks, drafts, stale approvals and blocked merge state', () => {
    const summary = summarizePullRequest({
      ...green, isDraft: true, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [
        { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.invalid/1' },
        { name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
        { context: 'legacy/ci', state: 'PENDING' },
      ],
      reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: 'b'.repeat(40) } }],
    });
    expect(summary.ready).toBe(false);
    expect(summary.checks.failed).toEqual([{ name: 'CI / test', state: 'failed', url: 'https://example.invalid/1' }]);
    expect(summary.checks.pending.map((item) => item.name)).toEqual(['lint', 'legacy/ci']);
    expect(summary.reviews[0]?.stale).toBe(true);
    expect(summary.blockers.join(' ')).toMatch(/draft.*1 check\(s\) failed.*2 check\(s\) pending.*REVIEW_REQUIRED.*earlier commit.*BLOCKED/);
  });

  it.skipIf(process.platform === 'win32')('prints names that anyone can choose on GitHub without letting them drive the terminal', () => {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-gh-'));
    try {
      const hostile = { ...green, headRefName: 'cc/x\u001b]0;PWNED\u0007', statusCheckRollup: [{ __typename: 'CheckRun', name: 'evil\u001b[2J\u202e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/x' }] };
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(hostile)}\nJSON\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
      for (const args of [['github-gate', '--pr', '7'], ['github-gate', '--pr', '7', '--json']]) {
        const result = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), ...args], { encoding: 'utf8', env });
        expect(result.stdout).toContain('evil');
        expect(result.stdout).not.toMatch(/[\u001b\u0007\u202e]/u);
      }
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });

  it('never treats missing data as passing', () => {
    const summary = summarizePullRequest({});
    expect(summary.ready).toBe(false);
    expect(summary.blockers).toEqual(expect.arrayContaining(['No checks reported for the head commit.']));
    expect(summarizePullRequest(null).ready).toBe(false);
  });
});
