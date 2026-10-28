# Code Conductor working status

Validated **2026-10-28 (UTC)** against GitHub, release metadata, repository records,
and a fresh npm lockfile audit. Baseline: `main` at
[`a25be5c`](https://github.com/saulpatinojr/Proj-Code_Conductor/commit/a25be5c50adc0b1652ab772dafa369471b0371d8).
Use this document for current status and next actions; Git history retains earlier checkpoints.

## Current position

**0.1.2 beta is published. Dependency remediation and ACP 2.0.1 are locally
validated on `fix/dependency-audit-and-acp-2026-10-28`, pending GitHub review/CI.**

| Area | Validated status |
| --- | --- |
| Release | [v0.1.2](https://github.com/saulpatinojr/Proj-Code_Conductor/releases/tag/v0.1.2), published October 22 UTC from `130c155`; VSIX, CycloneDX SBOM and checksums available. Release notes record checksum/provenance verification. |
| Main CI | [CI](https://github.com/saulpatinojr/Proj-Code_Conductor/actions/runs/39704829119), release preflight and APM audit passed October 22; [CodeQL](https://github.com/saulpatinojr/Proj-Code_Conductor/actions/runs/40271051788) passed October 26. These historical results do not establish a current clean dependency audit. |
| Fresh audit | October 28, `npm audit --package-lock-only --ignore-scripts --json` on the unchanged baseline: **4 findings: 2 high, 2 moderate**. High: `@azure/identity`, `@azure/msal-node`; moderate: `fast-uri`, `qs`. npm reports fixes available; fixes are not yet validated. |
| Open work | **2 issues**: [#14 Marketplace/release engineering](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/14), [#18 Antigravity safety](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/18). **1 PR**: [#135 ACP SDK 1.9.0 → 2.0.1](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/135). |
| PR #135 | No merge conflict, but blocked. [Lockfile validation](https://github.com/saulpatinojr/Proj-Code_Conductor/actions/runs/40322418281) detects drift; [quality](https://github.com/saulpatinojr/Proj-Code_Conductor/actions/runs/40322417910) stops at dependency audit. That job's build/typecheck and unit tests were skipped. ACP 2 has breaking API changes; compatibility needs validation. |

## Prepared change (not merged or released)

- ACP SDK **2.0.1**, patched `fast-uri`/`qs`, Azure Identity **4.14.0**, and a scoped
  MSAL Node **7.1.2** override. See [Unreleased](../CHANGELOG.md#unreleased) for rationale.
- **Passed locally, Node 24.19.0:** clean install, typecheck, full build, standalone
  bundle smoke, repository policy validation, VSIX packaging, and **62 test files:
  576 passed / 32 skipped** (PowerShell-dependent tests; `pwsh` is absent).
- **Zero audit findings** on this branch. Lockfile regeneration is unchanged using
  CI's npm **11.19.0**. ACP streaming, permission cancellation and timeout tests pass.
- Offline smoke of vsce's actual Azure CLI credential chain passed with a fake CLI;
  this does not establish live Entra/Marketplace authorization. Independent read-only
  dependency review found no compatibility blocker. GitHub CI is still pending.

## Completed

- **Windows beta readiness:** [#4 closed October 22](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/4#issuecomment-6330561368).
  Its [final evidence](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/4#issuecomment-6286118810)
  covers **0.1.1** installation, artifact verification, Claude/Codex read and modify
  smoke tests, Kiro read, 9 ms activation, R1 reaching `ready`, R2 with an independent
  challenger, and GitHub review. These workstation results were not rerun here.
- **Corpus disposition:** [#13 closed October 22](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/13).
  The [disposition record](ledger/dispositions-2026-10-19.md) excludes every remaining
  collection by owner decision; no new pack is required. The full external ledger
  was not independently re-audited here.
- Bundled runtime, orchestration, worktrees, handoffs, deterministic gates and APM
  integration are on `main`. [CHANGELOG](../CHANGELOG.md) retains implementation history;
  [implementation plan](IMPLEMENTATION-PLAN.md) retains acceptance criteria.

## Next actions, in order

1. **Review and integrate the prepared dependency/ACP change.** Require GitHub CI
   and independent review before integration. The implementing agent must not approve
   or merge its own change (AGENTS.md). Main retains its findings until integration.
2. **Reconcile #135 after integration.** The prepared change includes its SDK update
   plus the security and lockfile fixes. Close the superseded PR only after the
   replacement lands; do not treat its old failing checks as fixed on GitHub yet.
3. **Validate the published 0.1.2 VSIX on a clean Windows profile.** Follow
   [workstation validation](WORKSTATION-VALIDATION.md); record installation, Doctor,
   startup, storage under `~/.code-conductor`, and representative run evidence.
   Track this and beta defects in new issues; #4 is complete.
4. **Finish Marketplace publication under #14.** Follow the
   [publishing runbook](MARKETPLACE-PUBLISHING.md) and [release verification](RELEASE.md).
   Inspect current publisher/OIDC/environment setup first; it was not inspected here.
   The `v0.1.2` GitHub tag already exists: select the supported workflow or next
   version rather than treating the tag as uncreated.
5. **Broaden validation:** Linux/WSL context reads, macOS/Linux/remote installation,
   then permission-model work for Kiro modify and Antigravity (#18).

## Limits to retain

- **0.1.2 has no recorded clean-machine install validation.** The 0.1.1 Windows
  evidence does not establish this for 0.1.2 or other platforms.
- Kiro modify remains fail-closed; Antigravity unattended execution remains blocked.
- Context file reads require Linux/WSL (ADR 0007 / D-070); Windows and macOS refuse
  them. The context optimizer MCP adapter remains experimental.
- Marketplace listing, representative live MCP use and the real-run tool-output
  summary comparison remain unverified in the reviewed records.
- Full product tests were run on the prepared branch; provider authentication,
  clean-profile workstation tests and published artifact attestations were not rerun.
