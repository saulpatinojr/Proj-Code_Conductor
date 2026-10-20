# Code Conductor status

**Checkpoint:** 2026-10-19  
**Target:** v0.1 workstation/VS Code release

## Current state

The approved architecture and implementation work from the roadmap/chat consolidation is now incorporated into `main`. ADR 0008/0009 and decisions D-048 through D-056 are canonical, and the corresponding runtime/product foundations have landed rather than remaining only in feature branches.

Merged implementation includes surface-aware provider/harness capabilities and specialization routing, a guarded Kiro ACP client path using the official ACP SDK boundary, a self-contained bundled VS Code runtime with lazy startup/fingerprinting, the immutable Agent Catalog intake/lineage mechanism, and the VSIX packaging foundation with a pinned official `@vscode/vsce` toolchain. The earlier context-optimizer retrofit remains part of the baseline under ADR 0007.

The repository is therefore past the architecture-delta stage. The active v0.1 critical path is live workstation validation and dogfood under issue #4. On 2026-10-19 the owner's Windows workstation passed sign-in and read/modify smoke for Claude Code and Codex and read smoke for Kiro (modify stays fail-closed by design), and the first R1 dogfood ran and ended `changes_required` for stated reasons; its defects are fixed on `main` (#108). What remains is an R1 that reaches `ready` on the fixed build, R2 with a different-provider challenger and GitHub Gatekeeper evidence, representative MCP/tool profiles, and the packaged-install and startup measurements.

Parallel work continues under #13 for the actual legacy corpus migration and #14 for Marketplace publication. The intake tooling, VSIX packaging and tag-driven release automation (SBOM, provenance attestation, draft release and a gated Marketplace publish job) are implemented; the real corpus migration, the owner's Marketplace setup and the first tagged release are not yet done.

## Verified in repository/CI

- TypeScript workspace builds successfully on Node 24.
- The unit suite passes on Linux: **57 test files, 557 passed and 32 skipped** (owner-script tests where `pwsh` was absent) in PR #108's validation, and every workflow on `main` at `d6ee232` is green (2026-10-19). It has not yet run natively on the owner's Windows workstation. The only Windows run, inside the Codex sandbox during the 2026-10-19 dogfood, reported at least 59 failing tests across 13 files before it was interrupted (Git "dubious ownership" under the sandbox identity, POSIX path and permission assumptions, owner-script tests); they are not triaged, and the partial log exists only in that run's builder worktree (ignored `.code-conductor/foundation-tests.log`).
- `ccon validate` passes repository policy/configuration validation.
- `npm ci --ignore-scripts` and `npm audit --audit-level=high` report **0 vulnerabilities**.
- `package-lock.json` is committed and normal dependency CI remains read-only/reproducible.
- APM is pinned to 0.33.0, the version Agent Packs pins (D-077, 2026-10-19); `apm.lock.yaml` and generated skill projections are committed and APM audit passes 31 checks.
- Code Conductor ships no agent files (ADR 0015, D-076, 2026-10-19): the eleven role agents and their projections were removed, `.apm/` holds only Code Conductor's own skills, and specialists come from the Agent Packs repository (`saulpatinojr/Proj-Agent_Packs`) through APM for Code Conductor and Code Workflow alike. The roles in `config/roles.yaml` now carry `instructions`, rendered into every assignment prompt as `Role rules:`; before this, the runtime sent only `Role: reviewer. Stance: critical.` and never read the agent files. The next R1 run is the live check. Agent Packs released all 20 packs on 2026-10-19 (`<pack>-vX.Y.Z` tags with archives and `SHA256SUMS.txt`), and this repository now depends on `typescript-distinguished-engineer-pack` 1.4.0 and `github-expert-engineer-pack` 1.2.0, pinned to the tagged commit, installed from the mirror `hybridcloudworks/AgentPacks` (the install address for every pack; the source repository stays `saulpatinojr/Proj-Agent_Packs`), with their projections materialized and audited (31 of 31).
- The unit suite run natively on the owner's Windows workstation on 2026-10-19 (`d6ee232` plus this change, Node 26.5.0, outside any agent sandbox): 424 passed, 83 failed, 82 skipped in 352 s at the 5 s default timeout; 471 passed, 39 failed at 60 s. Every failure was a test fixture's Windows assumption, not a product defect: 44 Git-heavy tests only needed time (the config now allows 60 s on Windows only); `working-tree-state` split a path on `/`; `provider-environment`, `gates/profiles`, `doctor-extensions`, `secrets-and-cleanup` and `policy/defaults` asserted POSIX paths, extension-less executables or the pre-D-074 npm command; and the 22 owner-script tests drive the scripts with a fake `gh` that is a shell script, which the scripts (applications only) cannot run on Windows and which a `.cmd` shim cannot carry because cmd.exe splits API URLs on `&`, so they are skipped on Windows and run on Linux CI as before. Fixed on this branch; the rerun is recorded in the pull request.
- Task planning, structured result contracts, risk/policy checks, deterministic gates, run persistence, bounded retries, and modifying worktree support remain implemented and covered by the existing regression suite.
- Planner assignments project configured authority labels, select explicit execution surfaces/specializations, and enforce the configured R2+ different-provider challenger requirement fail-closed when it cannot be satisfied.
- CLI commands cover repository validation, surface-aware doctor/planning/execution, harness smoke tests, MCP selection, APM audit, GitHub gate inspection, context statistics, and bounded file-based context preparation.
- The context optimizer preserves comments/instructions by default, permits aggressive removal only explicitly, compacts valid JSON semantically, and does not inject provider-specific cache-control markup into core output.
- Context file reads are restricted to approved workspace roots after canonical/symlink resolution and reject sensitive/state paths, non-regular files, and oversized inputs.
- Context telemetry is owner-private on POSIX systems and token counts are explicitly estimates rather than provider billing/quota data.
- The context optimizer's experimental MCP adapter is not in the packaged catalog until W-006 validates it (I08, #40); catalog policy still requires explicit approval for Code Conductor first-party servers.
- The repository-specific GitHub Copilot review skill is retained and aligned with Code Conductor's context/MCP boundaries.
- Repository-scoped Copilot CLI MCP configuration is minimal under `.github/mcp.json`; the duplicate `.github/copilot-mcp.json`, transplanted Copilot setup workflow, and unused GitHub App token minter were removed because they duplicated platform-native paths and referenced infrastructure not owned by this repository.
- GitHub Actions used by maintained workflows remain pinned to reviewed immutable commit SHAs; executable Ansible/Azure MCP package references remain pinned rather than floating.
- Local run/evidence directories/files, workstation trust state, modifying-agent worktree directories, and context-optimizer telemetry use owner-only permissions on POSIX systems where applicable.
- Evidence run-directory traversal, Git rename/copy sensitive-path handling, ref sanitization, recursive gate matching, lazy profile scanning, advisory-gate semantics, non-git GitHub MCP selection, fail-closed workstation trust, and schema-validated `AgentResult` parsing remain covered by regression tests.
- CodeQL reports no new alerts in the retrofit after the Markdown comment-removal implementation was changed from a problematic regex to a bounded linear parser.
- Dependency review passes and GitGuardian reports no secrets in the current retrofit PR head.
- GitHub Copilot review findings on empty context payload handling, explicit first-party MCP approval, profile-name consistency, provider-surface configuration, Kiro ACP process/timeout behavior, startup fingerprinting, bundle verification, and immutable catalog intake were fixed with regression coverage.
- Surface-aware capability/routing behavior is implemented for Kiro/AWS/specification, Claude/refactor, Codex/debug/test, GitHub Gatekeeper, Perplexity research, and Antigravity/GCP lanes.
- The Kiro adapter uses an ACP client path with fail-closed permission handling, bounded cancellation/teardown, surface-specific workstation trust, and deterministic fake-ACP tests; live Kiro subscription/policy authority still requires workstation validation.
- The VS Code extension bundles its compiled Code Conductor runtime and uses workspace-scoped fingerprints/lazy discovery rather than requiring a repository-local runtime build for normal packaged use.
- The Agent Catalog intake tool hashes and inventories source files, records duplicate/classification/lineage candidates, never follows symlinks, refuses output inside the immutable source corpus, and does not auto-discard unique content.
- VSIX release packaging now uses a pinned official `@vscode/vsce` 4.0.0 toolchain, staged Marketplace metadata, publisher validation, and ignored generated release artifacts; Marketplace publication/provenance automation remains open.

- C01 packaged defaults (#43, PR #61, integrated 2026-10-16): the seven canonical config documents ship with the runtime under a SHA-256 manifest; bounded user/workspace preferences can only narrow/reorder eligible harnesses; `ccon workspace-validate` works in an unrelated empty folder; gate selection fails closed with `no-applicable-gates`; the standalone bundle smoke runs on every build. Clean-machine VSIX install remains owner validation (#33).
- C03 native interfaces (#45, D-060, 2026-10-16): next actions from stored runs (`ccon next`, `ccon run` output, Runs view) hand off to native Source Control, official sign-in, GitHub and manual handoff (`ccon handoff`) without executing outward-facing steps. Runs-view/SCM behavior on the owner workstation remains validation (#4).
- I05 handoffs (#37, D-063, 2026-10-16): versioned, expiring, digest-verified handoff packets between assignments; local evidence retention via `ccon runs`; no central session store.
- I04 worktrees (#36, D-062, 2026-10-16): isolated agent worktrees with explicit retention/cleanup (`ccon worktrees`), commit-time sensitive-path and credential refusal, and provider environments without separately billed API keys; native diff review via C03.
- I03 GitHub integration (#35, D-064, 2026-10-16): read-only `ccon github-gate` over `gh pr view`, and approval-gated draft pull requests (`ccon pr --create`) that push the exact approved commit and never merge or approve. Fork workflows and GitHub Enterprise Server remain owner validation (#4).
- First live R1 attempts (2026-10-17, #4; task "Add a unit test for an untested function", Claude builder): run CC-20261017102155-ed85e579 was blocked because Claude Code 2.1.292 had not passed the modify smoke; run CC-20261017104238-3d66ac2f stopped before the provider started on a false "Git configuration changed" report that every agent worktree on Windows produced (fixed in #102 by comparing each directory only with its own reading). The provider never ran and the task was not retried; the unused worktree `cc/T-7eda086e…/builder-claude` was kept, as the run is designed to do after such a stop. Hardening that followed: #103 (smoke-scan review), #104 (the agent's branch is checked as well as HEAD), #105 (the builder worktree's history is checked again before the merge decision).
- First R1 dogfood on the owner's Windows workstation (2026-10-19, runs CC-20261019081440-41f45bed and CC-20261019083408-c00ce6bf, #4): Codex built in an isolated worktree, Claude reviewed with the handoff packet, the gates ran under approval and both runs ended `changes_required`. The review found the merge decision could report `ready` on a `changes_required` recommendation, a cancelled result, no results or no executed gate, and that a completion claim overrode the exit status (fixed, D-075); the gates showed the Node profile could not run on Windows (fixed, D-074); run 2's reviewer stopped at Claude Code's 20-turn limit (reviews now get 40 turns and the result names the stop reason).
  - **F4** from that review (gate evidence from the builder worktree not tied to the commit `ccon pr` pushes) was recorded as #111 and fixed on 2026-10-19 (#115): before the gate commands run, the builder worktree's content is compared with its HEAD commit, and a difference names the paths and the steps that ran there, runs no gate and makes the run `human_required`.
  - The `gate.output.recorded` events of both runs cover only the 42-byte `validate` gate, because `typecheck` and `unit-tests` could not run there, so the #94 token baseline still needs a run in which they do.
  - Codex's review documents and reproduction scripts from both runs exist only on `cc/T-96582597…/builder-codex` and `cc/T-9df624da…/builder-codex`, one commit each, not on `main`. Both branches, their worktrees and the six local run records are kept as evidence until the owner decides. The reproduction scripts assert the old, defective behaviour and would have to be inverted or retired before anything from them lands.
- I02 client states (#34, D-065, 2026-10-16): official sign-in status gates provider start (subscription sign-in for subscription assignments), workstation trust is bound to the smoke-tested client version, and `ccon doctor` separates installed, signed in, healthy and trusted. Verified on the owner's Windows workstation on 2026-10-19: Claude Code 2.1.302 signed in, read and modify trusted; Codex 0.163.0 and Kiro CLI 2.32.0 signed in; Kiro read trusted and modify fail-closed as designed (#41); Codex read and modify trusted on the build carrying D-073, which removed a flag `codex exec` never accepted (#4).
- I01 VS Code distribution (#33, D-066, 2026-10-16): the release `.vsix` holds only allowlisted files and is smoke-tested unpacked, outside the checkout, against an unrelated folder in CI. Install, update and uninstall are documented. Installing into VS Code on clean Windows, macOS, Linux and remote hosts remains owner validation (#4).
- I08 selective MCP (#40, 2026-10-16): `ccon mcp` is explicit selection with provenance, billing and pinned launch details; Code Conductor starts no MCP server. The experimental optimizer MCP entry is out of the packaged catalog until W-006. Per-profile live validation remains W-004 under #4.
- Repository governance (#3, closed 2026-10-17): every required check reports on every pull request, the `Protect main branch` and `Protect tags` rulesets are active and automatic deletion of merged branches is on (read back 2026-10-19). The settings are in `docs/REPOSITORY-GOVERNANCE.md` and `scripts/owner/Set-RepositoryGovernance.ps1`.
- Owner scripts (2026-10-17, #97 to #99): `scripts/owner` holds PowerShell scripts for the steps only the owner can take: governance, stale-branch removal, the Marketplace environment and the section 13 workstation evidence.
- Release engineering (#14, D-067, 2026-10-16): version tags on `main` produce a tested, attested draft GitHub release with SBOM and checksums (`docs/RELEASE.md`). A **Publish to the Marketplace** job and the owner's runbook `docs/MARKETPLACE-PUBLISHING.md` landed on 2026-10-19 (#106, #107); the job is skipped until `MARKETPLACE_PUBLISH=true`. As of 2026-10-19 the repository has no `marketplace` environment, no `VSCE_PUBLISHER` or `MARKETPLACE_PUBLISH` variable, and no version tag or release.
- I10 local discovery and selective context (#42, ADR 0007, 2026-10-16):
  - a warm start restores fingerprinted, non-secret discovery; `which` probes run only on first run or after a configuration change;
  - no provider, ACP, MCP or APM process starts at startup, and sign-in and version probes run only for `ccon doctor`, smoke tests and runs;
  - context reads are bounded by roots, sensitive paths, size and a single descriptor whose kernel path must be the checked path, which refuses symlinks, swapped directories and hard links. File reads therefore need Linux (including WSL); macOS and Windows refuse them pending an owner decision (ADR 0007);
  - the optimizer stays lossless by default, and the MCP transport remains experimental.
- I06 gate profiles (#38, D-061, 2026-10-16): prerequisite-checked, isolated and bounded deterministic gates for Node (npm/pnpm/yarn), Terraform (validate, explicit advisory plan) and Ansible. No installer runs. Terraform gates are limited to fmt/validate/plan/version, and shells and wrappers are rejected. A plan still runs provider code with your credentials and is approval-gated with that disclosure. Real Terraform, pnpm and yarn projects remain owner validation (#4).
- C02 pre-action approvals (#44, ADR 0013/D-059, 2026-10-16): provider start, context disclosure, gate commands and commits each require a single-use human decision bound to the exact recipient/revision/content/diff; non-interactive runs fail closed; approval evidence is recorded in `RunManifest.approvals`. VS Code task-terminal prompt behavior remains owner validation (#4).
- Recoverable gate output (#94, D-071, 2026-10-19): full gate output stored with the run and read back verified by `ccon gate-output`; evidence ends with a recovery pointer; `ccon run --tool-output summary` is an opt-in verbatim-line summary. The token baseline on real runs is owner dogfood under #4 (`gate.output.recorded` events).
- Deferred scope recorded (D-072, 2026-10-19): #46's deferred infrastructure list and the deferred optional backlog (#16, #53, #54, #55) are closed as deferred; activation needs a new ADR.
- Local CodeQL run (2026-10-19, `security-and-quality`, JavaScript/TypeScript and Actions): the six findings were fixed (one polynomial regular expression, three check-then-read file races, two unused imports); Actions had none.
- ADR 0011 (2026-10-08): the Code Workflow sibling boundary is locked (D-057). `ccon agents` / `ccon doctor` provide a read-only provider-native inventory. `AgentResult.notVerified` is available. `ccon import` ingests Code Workflow exports without granting readiness. Gate evidence carries `sha256`. APM projections were re-materialized and `apm audit` passes (D-058).
- ADR 0012 (Proposed): provider-local subagent evidence hooks, pending W-003/W-005 workstation validation of per-client hook trust flows.

## Roadmap and scope state

- #7 remains the durable roadmap umbrella; future substantive approved ideas should be captured in GitHub before implementation or deferral.
- Open issues on 2026-10-19: #4, #13, #14 and #18 only.
- #8 thin VS Code + optional `ccon` client/no standalone app: **closed 2026-10-17; clean-machine/customer validation continues under #4**.
- #9 first-run/warm-start/lazy activation: **closed 2026-10-19; target-workstation timings continue under #4** with the measurement method and initial budget in `docs/WORKSTATION-VALIDATION.md` §10.
- #10 surface-aware harness adapters/provider-native capabilities: **closed 2026-10-19; implemented in the runtime/configuration baseline**.
- #11 Kiro ACP-first + AWS/spec specialization: **closed 2026-10-17**. The guarded pilot (#41, closed 2026-10-19) left Kiro read trusted and modify fail-closed by design until the permission model in W-002 is validated.
- #12 explicit provider role/capability routing matrix: **closed 2026-10-17; implemented with representative routing tests**.
- #13 full legacy Agent Catalog/APM migration: **open; immutable intake/lineage tooling landed; the real corpus still requires inventory, semantic review, canonicalization, and 100% lineage closure**.
- #14 Marketplace/VSIX/CLI/provenance/customer trust: **open; packaging, SBOM, provenance attestation, draft release and a gated Marketplace publish job are implemented; the owner's Marketplace setup, the first tag and clean-machine release validation remain**.
- #15 deterministic engineering-tool model: **closed 2026-10-19; met for Terraform and Ansible; the PowerShell profile is deferred (D-069) until a real repository needs it**.
- #16 APM Agent Plugin ↔ Kiro Powers interoperability: **closed as deferred (D-072); activation needs a new ADR**.
- #17 Perplexity manual Pro vs paid automation boundary: **closed 2026-10-17; policy locked; automation remains optional/later**.
- #18 Antigravity current `agy` safety revalidation: **open; still required before unattended execution**.
- #3 repository governance: **closed 2026-10-17; rulesets active**.
- #4 is now the primary v0.1 execution gate.
- `docs/FUTURE-PLAN.md` (agent control environment: a network-restricted container as the place agents run) is **stored for reference and not scheduled** (owner, 2026-10-19).

## Repository cleanup state

- Foundation/context-optimizer work and the approved architecture/product delta are merged to `main`.
- PRs #19, #20, #24, #25, #26, #27, and #30 represent the consolidation sequence that moved the roadmap architecture, surface-aware runtime, TypeScript-7 compatibility fix, Kiro ACP path, thin VS Code packaging/startup, Agent Catalog intake, and VSIX packaging foundation into the canonical branch.
- Earlier stacked/rebuild branches and closed superseded PRs are historical scaffolding only; no future work should branch from them.
- Temporary one-shot lockfile materialization workflows used during branch repair were removed before merge and are not part of the product/release workflow.
- Branch protection and tag rulesets and automatic merged-branch deletion are in place (#3, closed 2026-10-17).
- Kept on purpose pending the owner's review (2026-10-19): the three agent worktrees and branches from the 2026-10-17 and 2026-10-19 runs (above), the local stale branch `feat/owner-scripts` (merged in #97) and the remote branch `fix/recheck-builder-worktree` (merged in #105 but not deleted automatically). Nothing is removed until the owner decides.

## Not yet release-verified

- Clean-machine installation of the packaged extension/VSIX and activation without a Code Conductor source checkout.
- First-run bootstrap and warm-start latency/resource behavior on the target workstation, including proof that providers/ACP/MCP/APM are not launched unnecessarily.
- Official subscription authentication on the actual execution workstation for GitHub Copilot and Google Antigravity. Claude Code, Codex and Kiro CLI sign-ins were verified on the owner's Windows workstation on 2026-10-19.
- Kiro modify and Antigravity smoke validation. Claude Code 2.1.302 and Codex 0.163.0 read and modify and Kiro CLI 2.32.0 read passed on 2026-10-19; trust is bound to those versions.
- Kiro ACP subscription-policy boundary and read/modify authority on the target workstation; implementation is present but unattended trust remains fail-closed until this passes.
- Authenticated official MCP behavior for real project profiles before write authority is granted.
- The context optimizer's optional MCP adapter against the official MCP TypeScript SDK/current protocol.
- A complete real R1/R2 task spanning isolated builder work, independent reviewer/challenger roles, deterministic validation, preserved worktree changes, GitHub PR checks/review, structured evidence, and final readiness. R1 ran twice on 2026-10-19 and ended `changes_required`; a rerun on the fixed build is pending, and R2 has not run.
- The full unit suite run natively on Windows, outside any agent sandbox.
- Google Antigravity unattended execution remains intentionally disabled pending permission/sandbox revalidation.
- Perplexity Pro remains human-in-the-loop unless separately billed official MCP/API automation is explicitly enabled.
- The actual legacy agent/skill corpus inventory, semantic deduplication/canonicalization, modular APM migration, and 100% lineage closure.
- Marketplace publication (the owner's setup is pending), a first tagged release that exercises the SBOM/provenance/attestation workflow, and customer-facing release-channel validation.

## Immediate next milestone

Done on 2026-10-19: Doctor, sign-in and smoke trust for Claude Code, Codex and Kiro (read) on the owner's Windows workstation, and the first R1 dogfood, whose defects are fixed on `main`.

1. Rerun R1 on current `main` on the Windows workstation, with dependencies installed in the builder worktree when the gate approval names it (`docs/WORKSTATION-VALIDATION.md` §12). The `typecheck` and `unit-tests` gates should now run (D-074), and the run can reach `ready` only with a passed blocking gate (D-075). This run also gives #94 its token baseline.
2. Raise the same scenario to R2 with a different-provider challenger, deterministic validation, a draft pull request through `ccon pr`, and `ccon github-gate` before and after re-review.
3. Post the remaining #4 evidence: the 2026-10-19 run evidence the last #4 comment asks for (now readable in the kept run records and builder branches), activation timings and the §10 process check, the MCP and tool profiles used, and package checksums and attestation once a tag exists.
4. #14: the owner's Marketplace setup (`docs/MARKETPLACE-PUBLISHING.md`), then a first version tag, which also gives #4 its package evidence; clean-machine install validation.
5. In parallel, run #13 immutable intake against the actual legacy agent/skill corpus and begin reviewed APM canonicalization batches with 100% source-lineage accounting.
6. Revalidate #18 when it can materially change the active release path.
7. Prepare the v0.1 release candidate only when the authoritative definition of done is satisfied.

## Release definition

The authoritative v0.1 definition of done remains in [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md). This file records progress and approved sequencing; it does not weaken those acceptance criteria.
