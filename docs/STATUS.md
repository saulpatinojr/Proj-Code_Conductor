# Code Conductor status

**Checkpoint:** 2026-10-16  
**Target:** v0.1 workstation/VS Code release

## Current state

The approved architecture and implementation work from the roadmap/chat consolidation is now incorporated into `main`. ADR 0008/0009 and decisions D-048 through D-056 are canonical, and the corresponding runtime/product foundations have landed rather than remaining only in feature branches.

Merged implementation includes surface-aware provider/harness capabilities and specialization routing, a guarded Kiro ACP client path using the official ACP SDK boundary, a self-contained bundled VS Code runtime with lazy startup/fingerprinting, the immutable Agent Catalog intake/lineage mechanism, and the VSIX packaging foundation with a pinned official `@vscode/vsce` toolchain. The earlier context-optimizer retrofit remains part of the baseline under ADR 0007.

The repository is therefore past the architecture-delta stage. The active v0.1 critical path is now live workstation validation and dogfood under issue #4: official subscription authentication, surface-specific read/modify smoke, Kiro ACP policy/authority validation, representative MCP/tool profiles, then real R1/R2 execution with GitHub Gatekeeper evidence.

Parallel work continues under #13 for the actual legacy corpus migration and #14 for Marketplace publication/provenance/customer-trust automation. The intake and VSIX packaging foundations are implemented; full corpus migration and public release hardening are not yet complete.

## Verified in repository/CI

- TypeScript workspace builds successfully on Node 24.
- Current consolidated unit suite passes: **178 tests across 26 test files** (re-verified 2026-10-16 after integrating C01 packaged defaults).
- `cc validate` passes repository policy/configuration validation.
- `npm ci --ignore-scripts` and `npm audit --audit-level=high` report **0 vulnerabilities**.
- `package-lock.json` is committed and normal dependency CI remains read-only/reproducible.
- APM 0.30.0 remains pinned; `apm.lock.yaml` and generated harness projections are committed and APM audit passes.
- Canonical APM agent/skill sources project to Copilot, Claude, Codex, Kiro, and Agent Skills targets.
- Task planning, structured result contracts, risk/policy checks, deterministic gates, run persistence, bounded retries, and modifying worktree support remain implemented and covered by the existing regression suite.
- Planner assignments project configured authority labels, select explicit execution surfaces/specializations, and enforce the configured R2+ different-provider challenger requirement fail-closed when it cannot be satisfied.
- CLI commands cover repository validation, surface-aware doctor/planning/execution, harness smoke tests, MCP selection, APM audit, GitHub gate inspection, context statistics, and bounded file-based context preparation.
- The context optimizer preserves comments/instructions by default, permits aggressive removal only explicitly, compacts valid JSON semantically, and does not inject provider-specific cache-control markup into core output.
- Context file reads are restricted to approved workspace roots after canonical/symlink resolution and reject sensitive/state paths, non-regular files, and oversized inputs.
- Context telemetry is owner-private on POSIX systems and token counts are explicitly estimates rather than provider billing/quota data.
- The context optimizer is cataloged as a Code Conductor first-party **experimental** MCP adapter rather than a vendor-official/GA server, and catalog policy requires explicit first-party approval.
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

- C01 packaged defaults (#43, PR #61, integrated 2026-10-16): the seven canonical config documents ship with the runtime under a SHA-256 manifest; bounded user/workspace preferences can only narrow/reorder eligible harnesses; `cc workspace-validate` works in an unrelated empty folder; gate selection fails closed with `no-applicable-gates`; the standalone bundle smoke runs on every build. Clean-machine VSIX install remains owner validation (#33).
- C03 native interfaces (#45, D-060, 2026-10-16): next actions from stored runs (`cc next`, `cc run` output, Runs view) hand off to native Source Control, official sign-in, GitHub and manual handoff (`cc handoff`) without executing outward-facing steps. Runs-view/SCM behavior on the owner workstation remains validation (#4).
- I05 handoffs (#37, D-063, 2026-10-16): versioned, expiring, digest-verified handoff packets between assignments; local evidence retention via `cc runs`; no central session store.
- I04 worktrees (#36, D-062, 2026-10-16): isolated agent worktrees with explicit retention/cleanup (`cc worktrees`), commit-time sensitive-path and credential refusal, and provider environments without separately billed API keys; native diff review via C03.
- I03 GitHub integration (#35, D-064, 2026-10-16): read-only `cc github-gate` over `gh pr view`, and approval-gated draft pull requests (`cc pr --create`) that push the exact approved commit and never merge or approve. Fork workflows and GitHub Enterprise Server remain owner validation (#4).
- I02 client states (#34, D-065, 2026-10-16): official sign-in status gates provider start (subscription sign-in for subscription assignments), workstation trust is bound to the smoke-tested client version, and `cc doctor` separates installed, signed in, healthy and trusted. Verified against the installed Claude Code 2.1.301; Codex and Kiro sign-in on an owner workstation remain validation (#4).
- I01 VS Code distribution (#33, D-066, 2026-10-16): the release `.vsix` holds only allowlisted files and is smoke-tested unpacked, outside the checkout, against an unrelated folder in CI. Install, update and uninstall are documented. Installing into VS Code on clean Windows, macOS, Linux and remote hosts remains owner validation (#4).
- I06 gate profiles (#38, D-061, 2026-10-16): prerequisite-checked, isolated and bounded deterministic gates for Node (npm/pnpm/yarn), Terraform (validate, explicit advisory plan) and Ansible. No installer runs. Terraform gates are limited to fmt/validate/plan/version, and shells and wrappers are rejected. A plan still runs provider code with your credentials and is approval-gated with that disclosure. Real Terraform, pnpm and yarn projects remain owner validation (#4).
- C02 pre-action approvals (#44, ADR 0013/D-059, 2026-10-16): provider start, context disclosure, gate commands and commits each require a single-use human decision bound to the exact recipient/revision/content/diff; non-interactive runs fail closed; approval evidence is recorded in `RunManifest.approvals`. VS Code task-terminal prompt behavior remains owner validation (#4).
- ADR 0011 (2026-10-08): the Code Workflow sibling boundary is locked (D-057). `cc agents` / `cc doctor` provide a read-only provider-native inventory. `AgentResult.notVerified` is available. `cc import` ingests Code Workflow exports without granting readiness. Gate evidence carries `sha256`. APM projections were re-materialized and `apm audit` passes (D-058).
- ADR 0012 (Proposed): provider-local subagent evidence hooks, pending W-003/W-005 workstation validation of per-client hook trust flows.

## Roadmap and scope state

- #7 remains the durable roadmap umbrella; future substantive approved ideas should be captured in GitHub before implementation or deferral.
- #8 thin VS Code + optional `cc` client/no standalone app: **implementation foundation landed; clean-machine/customer validation remains**.
- #9 first-run/warm-start/lazy activation: **implementation foundation landed; target-workstation behavior remains to validate**.
- #10 surface-aware harness adapters/provider-native capabilities: **implemented in the runtime/configuration baseline**.
- #11 Kiro ACP-first + AWS/spec specialization: **guarded ACP implementation landed; live subscription-policy/read-modify authority remains fail-closed pending workstation validation**.
- #12 explicit provider role/capability routing matrix: **implemented with representative routing tests**.
- #13 full legacy Agent Catalog/APM migration: **immutable intake/lineage tooling landed; the real corpus still requires inventory, semantic review, canonicalization, and 100% lineage closure**.
- #14 Marketplace/VSIX/CLI/provenance/customer trust: **VSIX packaging foundation landed; Marketplace publication, provenance/SBOM/attestation and release automation remain**.
- #15 deterministic engineering-tool model: **policy/model locked; expand representative Terraform/Ansible/PowerShell/cloud profiles as dogfood requires them**.
- #16 APM Agent Plugin ↔ Kiro Powers interoperability: **research/validation remains open**.
- #17 Perplexity manual Pro vs paid automation boundary: **policy locked; automation remains optional/later**.
- #18 Antigravity current `agy` safety revalidation: **still required before unattended execution**.
- #3 repository governance enforcement remains an administrative prerequisite for a trustworthy public release.
- #4 is now the primary v0.1 execution gate.

## Repository cleanup state

- Foundation/context-optimizer work and the approved architecture/product delta are merged to `main`.
- PRs #19, #20, #24, #25, #26, #27, and #30 represent the consolidation sequence that moved the roadmap architecture, surface-aware runtime, TypeScript-7 compatibility fix, Kiro ACP path, thin VS Code packaging/startup, Agent Catalog intake, and VSIX packaging foundation into the canonical branch.
- Earlier stacked/rebuild branches and closed superseded PRs are historical scaffolding only; no future work should branch from them.
- Temporary one-shot lockfile materialization workflows used during branch repair were removed before merge and are not part of the product/release workflow.
- Repository-level branch protection/ruleset enforcement and automatic merged-branch deletion remain tracked in issue #3 because those repository-settings mutations are outside the current connector's administration surface.

## Not yet release-verified

- Clean-machine installation of the packaged extension/VSIX and activation without a Code Conductor source checkout.
- First-run bootstrap and warm-start latency/resource behavior on the target workstation, including proof that providers/ACP/MCP/APM are not launched unnecessarily.
- Official subscription authentication on the actual execution workstation for Claude, Codex/ChatGPT, Kiro Pro, GitHub Copilot, and Google Antigravity.
- Surface-specific read/modify smoke validation against installed current client versions.
- Kiro ACP subscription-policy boundary and read/modify authority on the target workstation; implementation is present but unattended trust remains fail-closed until this passes.
- Authenticated official MCP behavior for real project profiles before write authority is granted.
- The context optimizer's optional MCP adapter against the official MCP TypeScript SDK/current protocol.
- A complete real R1/R2 task spanning isolated builder work, independent reviewer/challenger roles, deterministic validation, preserved worktree changes, GitHub PR checks/review, structured evidence, and final readiness.
- Google Antigravity unattended execution remains intentionally disabled pending permission/sandbox revalidation.
- Perplexity Pro remains human-in-the-loop unless separately billed official MCP/API automation is explicitly enabled.
- The actual legacy agent/skill corpus inventory, semantic deduplication/canonicalization, modular APM migration, and 100% lineage closure.
- Marketplace publication, release provenance/SBOM/attestation, and customer-facing release-channel validation.

## Immediate next milestone

1. Start from current `main` and execute issue #4 / `docs/WORKSTATION-VALIDATION.md` on the real VS Code workstation.
2. Validate clean packaged extension installation/activation, first-run discovery, and warm lazy startup without a source-tree build dependency.
3. Validate official subscription authentication and surface-specific read/modify trust for Codex, Claude Code, and Kiro ACP; keep Kiro fail-closed until the installed version and current policy boundary pass.
4. Validate only the MCP/reference and deterministic-tool profiles needed for the dogfood repository.
5. Run a real R1 task through Code Conductor in an isolated modifying worktree and capture structured evidence.
6. Raise the same scenario to R2 with a different-provider challenger, deterministic validation, and GitHub Gatekeeper review/re-review.
7. In parallel, run #13 immutable intake against the actual legacy agent/skill corpus and begin reviewed APM canonicalization batches with 100% source-lineage accounting.
8. Continue #14 from the merged VSIX packaging foundation to Marketplace publication, reproducible release automation, SBOM/provenance/attestation, and clean-machine release validation.
9. Validate/revalidate #16/#18 when they can materially change the active release path.
10. Prepare the v0.1 release candidate only when the authoritative definition of done is satisfied.

## Release definition

The authoritative v0.1 definition of done remains in [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md). This file records progress and approved sequencing; it does not weaken those acceptance criteria.
