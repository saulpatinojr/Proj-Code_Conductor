# GitHub repository governance

This document defines the desired GitHub repository settings for Code Conductor. Repository settings are enforcement configuration; committed workflows and `AGENTS.md` remain the auditable policy source.

## `main` baseline

`main` is the only long-lived integration branch. Normal development uses short-lived `feature/`, `fix/`, `docs/`, or `chore/` branches and deletes them after merge.

Desired protection/ruleset behavior:

- require changes to enter `main` through a pull request;
- block force pushes and branch deletion for `main`;
- require unresolved review conversations to be resolved;
- require the status checks listed below;
- keep human approval for R3/R4 or destructive/external operations even when automated review is green;
- do not count an implementing agent's self-review as independent approval;
- allow an emergency administrator bypass only when documented after the fact with evidence and remediation.

## Pull-request lifecycle

1. Branch from current `main`.
2. Open a PR early when collaboration/review benefits from it; draft status is acceptable during active implementation.
3. Run deterministic checks and APM integrity validation as applicable.
4. Move to ready-for-review when the intended change set is complete.
5. Use GitHub Copilot as the GitHub-native Gatekeeper and independent reviewers according to risk.
6. Address blocking findings and rerun/re-request review when material changes invalidate prior evidence.
7. Prefer squash merge for large/bootstrap or noisy implementation histories unless preserving individual commits has material value.
8. Delete the merged short-lived branch.

## Repository settings to enable

When supported by the repository/plan and admin tooling:

- automatically delete head branches after merge;
- allow maintainers to update PR branches when needed;
- optionally enable auto-merge only after required checks/reviews are correctly enforced;
- enable private vulnerability reporting;
- keep GitHub Actions default token permissions read-only and grant write permissions only to individual workflows that require them;
- disable unused repository surfaces such as wiki/projects only if the team is not using them.

## Current automation boundary

Repository rulesets/branch protection and repository-level settings require GitHub administration capabilities. Code Conductor must not simulate those controls in prompts. If automation cannot configure them through an authorized GitHub administration channel, track the setting as an explicit repository-governance task rather than claiming it is enforced.

## Required checks

Every check below reports on every pull request into `main`, so each can be required
without leaving pull requests pending. A path-filtered workflow never reports for other
changes, so a required check must not use path filters. CodeQL keeps reporting and skips
the analysis inside the job instead.

| Check name (as GitHub shows it) | Workflow |
|---|---|
| `quality` | Code Conductor CI: audit, typecheck, tests, repository validation |
| `audit` | APM audit: package, lockfile, policy, projections, drift |
| `lockfile` | npm lockfile validation |
| `VSIX packaging preflight` | Release preflight: package and installed-package smoke test |
| `dependency-review` | Dependency review |
| `Analyze javascript-typescript`, `Analyze actions` | CodeQL |

## Owner setup (requires repository administration)

Code Conductor cannot apply these settings itself. The owner applies them, then reads them
back so this document can be checked against the live state (#3).

1. **Settings → Rules → New branch ruleset** for the default branch, set to *Active*:
   - restrict deletions and block force pushes;
   - require a pull request before merging. With a single maintainer, require **0**
     approvals: GitHub does not let you approve your own pull request, and
     independent review comes from the agents and Copilot under `AGENTS.md`;
   - require conversation resolution;
   - require the status checks above, and require branches to be up to date;
   - optionally, request Copilot code review automatically.
2. **Settings → Rules → New tag ruleset** for `v*`: restrict creation, updates and
   deletion to maintainers ([`RELEASE.md`](RELEASE.md)).
3. **Settings → General:**
   - turn on automatic deletion of head branches;
   - turn on the suggestion to update pull request branches;
   - choose the merge methods to allow.
4. **Settings → Code security:** enable private vulnerability reporting, secret scanning
   and push protection.
5. **Settings → Actions → General → Workflow permissions:** read repository contents only,
   and do not allow GitHub Actions to create or approve pull requests.
6. **Read the settings back** and attach the output to #3:

   ```sh
   gh api repos/saulpatinojr/Proj-Code_Conductor/rulesets
   gh api repos/saulpatinojr/Proj-Code_Conductor/rules/branches/main
   ```

## Branch cleanup

After every merged PR, verify that only `main` and intentionally active branches remain. Closed-unmerged branches should be deleted once their work is either superseded or intentionally abandoned.
