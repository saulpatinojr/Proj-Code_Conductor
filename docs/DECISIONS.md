# Code Conductor Decision Register

This file is the durable record of user-approved architectural decisions. It exists so the project does not depend on chat history or model memory.

## Status vocabulary

- **LOCKED**: approved baseline; change only through an ADR with evidence.
- **VALIDATE**: intended decision that still requires local/runtime verification before merge.
- **OPEN**: implementation detail not yet locked.

## Locked decisions

| ID | Decision | Status |
|---|---|---|
| D-001 | `saulpatinojr/Proj-Code_Conductor` is the canonical GitHub home for Code Conductor and its durable architecture/code/docs. See ADR 0010. | LOCKED |
| D-002 | VS Code is the primary human cockpit. Code Conductor augments native VS Code surfaces instead of replacing chat, diff, terminal, Source Control, or PR UI. | LOCKED |
| D-003 | Code Conductor is the runtime orchestration/policy/evidence layer. MCP is the tool/reference plane, not the scheduler. | LOCKED |
| D-004 | Microsoft APM is the package, dependency, lock, distribution, integrity, and drift-governance layer for Agent Packs and supported MCP declarations. | LOCKED |
| D-005 | APM and Code Conductor remain separated by an adapter boundary because APM is new/evolving and must not become an internal hard dependency of the core domain model. | LOCKED |
| D-006 | Git is the code-state authority. GitHub is the repository, PR, Actions, review, and merge source of truth. | LOCKED |
| D-007 | Modifying agents use isolated branches/worktrees. Review-only agents are read-only by default. A clean Git merge is not proof of correctness. | LOCKED |
| D-008 | Model, provider, harness, subscription/billing channel, role, stance, specialization, tools, authority, and risk clearance are independent dimensions. | LOCKED |
| D-009 | Route by capability and unique platform advantage, not vendor brand alone. | LOCKED |
| D-010 | Prefer subscription-backed official clients before separately billed model APIs. Separately billed API use is disabled by default and must be explicit/policy-controlled. | LOCKED |
| D-011 | Official vendor CLI/headless clients are the preferred machine-facing adapters where officially supported; native platform surfaces remain first-class where they provide unique capability. | LOCKED |
| D-012 | GitHub Copilot Pro+ is the GitHub-native Gatekeeper for PR review/re-review, repository context, Actions/PR checks, and GitHub-specific quality gates. | LOCKED |
| D-013 | Claude Code via Claude Max is a primary implementation/refactoring/codebase-reasoning lane. | LOCKED |
| D-014 | Codex via ChatGPT Business is a primary implementation/debugging/testing/repository-work lane. | LOCKED |
| D-015 | Kiro Pro is the primary specification/requirements/design/task-planning lead and may also provide an official subscription-backed headless worker lane where supported. | LOCKED |
| D-016 | Google Antigravity is the native Google execution lane and Google/GCP specialist/alternate builder-reviewer lane. | LOCKED |
| D-017 | Perplexity Pro is the primary Research Captain for discovery and synthesis. Subscription-only mode is human-in-the-loop. Automated official MCP/API research is optional and requires explicit separately billed API enablement. | LOCKED |
| D-018 | No unofficial scraping, session-cookie reuse, or consumer UI automation is allowed to simulate API/MCP access. | LOCKED |
| D-019 | Authentication remains with official vendor clients/credential stores. Code Conductor does not store consumer OAuth tokens or become the credential authority. | LOCKED |
| D-020 | Agents use explicit stances: constructive, critical, or neutral. Important work uses independent critical/challenger roles that provide evidence rather than disagreement for its own sake. | LOCKED |
| D-021 | Implementers never self-review, self-approve, self-merge, or bypass deterministic required gates. | LOCKED |
| D-022 | Human approval remains mandatory for high-impact/destructive/external production operations as defined by risk policy. | LOCKED |
| D-023 | Per-project MCP activation is minimal and profile-driven. Do not load every available MCP/tool into every agent context. | LOCKED |
| D-024 | Initial MCP/reference catalog prioritizes official Microsoft, GitHub, HashiCorp Terraform, Ansible, AWS, Google Cloud, Kiro/vendor-required integrations, and Perplexity when explicitly enabled. | LOCKED |
| D-025 | Perplexity discovers sources; implementation-impacting technical claims should be reconfirmed against official vendor documentation or executable repository evidence where available. | LOCKED |
| D-026 | Agent outputs become structured evidence, not only prose. Core contracts include `TaskEnvelope`, `AgentAssignment`, `AgentResult`, `Evidence`, `Finding`, `GateResult`, `ReviewResult`, `MergeDecision`, and `RunManifest`. | LOCKED |
| D-027 | Risk class controls team size and required independent roles/gates; trivial work must not incur a large agent committee. | LOCKED |
| D-028 | The first release is workstation/VS Code centered and does not require an always-on Azure/Kubernetes/database control plane. | LOCKED |
| D-029 | The initial control plane implementation is TypeScript/Node, with vendor-specific integrations behind adapters. | LOCKED |
| D-030 | A thin VS Code extension is part of v0.1, with views for Team, Runs, Gates, Connections, Packs, and Usage. It deep-links to native VS Code/vendor surfaces. | LOCKED |
| D-031 | Agent Packs are authored once in canonical APM package source and projected/materialized to supported harness formats rather than manually maintained as duplicate copies. | LOCKED |
| D-032 | `AGENTS.md` is the repository constitution, not the entire agent roster. Reusable team roles/skills live in APM-backed packs and vendor-neutral configuration. | LOCKED |
| D-033 | The project dogfoods itself: Code Conductor's own implementation is the first R1/R2 multi-agent validation scenario. | LOCKED |
| D-034 | Architecture changes require an ADR when they alter a locked decision or are forced by a verified official-platform limitation. | LOCKED |
| D-035 | APM CLI version `0.30.0` is explicitly pinned in CI until a newer version is deliberately validated; the APM action's default CLI version is not trusted for compatibility-critical behavior. | LOCKED |
| D-036 | APM-generated lock/projection state is committed after maintainer materialization; normal CI audits it read-only with `setup-only: true` and does not auto-write back to branches. | LOCKED |
| D-037 | Runtime retries are bounded and important work must escalate or fail explicitly rather than loop indefinitely. | LOCKED |
| D-038 | CI never consumes paid AI subscriptions or separately billed model APIs; multi-agent runtime behavior is tested with deterministic fake adapters/fixtures. | LOCKED |
| D-039 | Unattended external CLI execution is permitted only after the installed harness/version passes Code Conductor workstation smoke validation for the required read or modify authority. | LOCKED |
| D-040 | Antigravity remains a first-class Google specialist but unattended headless execution is disabled until its permission/sandbox boundary is revalidated; no dangerous permission-bypass workaround is allowed. | LOCKED |
| D-041 | External agent subprocess results use the `CC_RESULT_JSON:` terminal marker contract; missing or invalid structured results fail closed while preserving non-secret output as evidence. | LOCKED |
| D-042 | Modifying worktrees are preserved by default, actual safe Git changes are committed to the task/agent branch before integration, sensitive credential/state paths are blocked from automatic commit, and cleanup is explicit. | LOCKED |
| D-043 | npm dependency resolution is committed in `package-lock.json`; normal CI installs with `npm ci` and never auto-writes lockfile changes. | LOCKED |
| D-044 | Repository documentation follows a single-purpose truth model: `README.md` is the entry point, `AGENTS.md` the constitution, `STARTER.md` the continuity handoff, `docs/STATUS.md` the live checkpoint, `docs/README.md` the index, `docs/DECISIONS.md` the durable decision register, and `docs/adr/` the architecture-change record. | LOCKED |
| D-045 | Third-party GitHub Actions used by maintained workflows are pinned to reviewed immutable commit SHAs, with the corresponding release tag recorded as a comment for readability and deliberate upgrades. | LOCKED |
| D-046 | Executable package references in the approved MCP catalog must not use floating tags such as `latest`; exact validated versions are reviewed and updated intentionally. | LOCKED |
| D-047 | Context optimization is a Code Conductor context-preparation capability: conservative/lossless by default, aggressive removal only by explicit opt-in, workspace-root/sensitive-path bounded, provider-neutral, and reported with estimated rather than billing-token telemetry. Its MCP transport is optional/experimental until migrated to the official MCP TypeScript SDK and current protocol validation. See ADR 0007. | LOCKED |
| D-048 | Code Conductor v0.x has no standalone desktop application requirement. The product is a thin VS Code extension plus an optional thin `cc` CLI/TUI over the same versioned core/runtime. See ADR 0008. | LOCKED |
| D-049 | First run performs explicit workstation bootstrap/discovery; later VS Code starts use cached non-secret health/trust state and lightweight fingerprints. AI providers, ACP sessions, MCP servers, and APM materialization are lazy/on-demand rather than started on every launch. See ADR 0008. | LOCKED |
| D-050 | Harness integration is surface-aware: IDE extension, CLI/headless, ACP, MCP, platform-native workflow/API, separately billed API/SDK, and manual surfaces are modeled independently. Provider-native subagents, skills, hooks, commands/plugins/Powers, permissions, sessions, and IDE capabilities are preserved where officially supported. See ADR 0009. | LOCKED |
| D-051 | Cross-provider AI invocation is mediated by Code Conductor so assignment, identity, authority, billing channel, worktree ownership, evidence, and readiness remain controlled. Provider-local subagents may operate within an assigned provider task; deterministic engineering CLIs may be governed tools. See ADR 0009. | LOCKED |
| D-052 | Kiro is the preferred specification/design/task-planning lead and AWS specialist. For the VS Code-centered product, `kiro-cli acp` is the preferred Kiro client/harness boundary where current Kiro policy and installed-version validation permit it; generic headless Kiro execution does not bypass this policy boundary. See ADR 0009. | LOCKED |
| D-053 | Provider primary specializations are routing preferences, not exclusivity: Kiro = specification/AWS; Claude Code = large-codebase engineering/refactoring; Codex = implementation/debugging/testing/repository execution; GitHub Copilot/GitHub = GitHub Gatekeeper; Perplexity = external research; Antigravity = Google/GCP specialist. Independent different-provider review requirements still apply by risk. See ADR 0009. | LOCKED |
| D-054 | Terraform, Ansible, PowerShell, Git/GitHub CLI, cloud CLIs, Kubernetes/Helm, language toolchains, linters, test runners, and similar deterministic engineering capabilities are governed tools, not peer GenAI agents. Deterministic validation evidence outranks unsupported model opinion about whether the check passed. | LOCKED |
| D-055 | Migration of the legacy agent/skill corpus into APM requires 100% source-lineage coverage: every original file is preserved/inventoried and receives a canonical destination or explicit duplicate/superseded disposition before legacy retirement. Canonical packages should be modular and provider overlays limited to genuine harness differences. | LOCKED |
| D-056 | Customer-facing distribution targets the VS Code Marketplace as the primary install/update channel, with VSIX for offline/enterprise/manual installation, GitHub Releases for auditable release artifacts/history, and an optional `cc` CLI distribution. Production artifacts must be CI-built and traceable to source/release provenance before public release. | LOCKED |
| D-057 | Code Conductor is the full cross-provider program; Code Workflow (`saulpatinojr/Proj-Code_Workflow`) is the slim in-client sibling. Code Workflow never spawns other providers, manages worktrees, or issues merge/readiness decisions; neither product depends on the other at runtime; `AgentResult`/`RunManifest` is the shared result vocabulary; `cc import` ingests a Code Workflow export into the private run store but never treats it as readiness (manifests with `mergeDecision` or `ready` are rejected). See ADR 0011. | LOCKED |
| D-058 | `AgentResult.notVerified` (optional) declares checks an agent did not or could not verify; deterministic gate evidence records `sha256` over full untruncated output; `cc agents` / `cc doctor` provide a read-only provider-native agent/skill inventory marked against `apm.lock.yaml` (informational; `apm audit` remains authoritative). See ADR 0011. | LOCKED |
| D-059 | Consequential actions require a human decision immediately before the action, bound by SHA-256 digest to its exact context: provider start and context disclosure (per recipient, prompt digest, revision and working-tree content), deterministic gate commands (exact command plan), commits (exact tree) and deployments. Missing, denied, expired (default 15 min) or changed-context decisions are refused; decisions are single-use and never read back as authority. Workstation trust, smoke success and final readiness are not approval. Non-interactive runs cannot approve; the terminal approver requires a request-derived confirmation code. Each retry is approved separately, and Code Conductor's own Git operations never run repository hooks or fsmonitor. See ADR 0013. | LOCKED |

## Validated implementation facts

| ID | Fact | Evidence/status |
|---|---|---|
| V-001 | APM 0.30.0 recognizes the explicit targets `agent-skills`, `antigravity`, `claude`, `codex`, `copilot`, and `kiro`. | VALIDATED in GitHub Actions on 2026-09-11. |
| V-002 | APM generated and committed `apm.lock.yaml` and harness projections from canonical `.apm/` sources. | VALIDATED by the GitHub Actions materialization commit on 2026-09-11. |
| V-003 | APM replay reported no drift after installation; source-attribution policy was then enabled in `apm.yml` as required by audit. | VALIDATED in GitHub Actions. |
| V-004 | TypeScript workspace, core state machine, policy validation, runtime planner, worktree utilities, and current unit tests build/pass in GitHub Actions. | VALIDATED in GitHub Actions. |
| V-005 | `package-lock.json` was generated by npm on Node 24 as lockfile version 3 and is committed; normal dependency CI is read-only. | VALIDATED in GitHub Actions on 2026-09-11. |
| V-006 | At the repository-cleanup checkpoint, Code Conductor CI, APM audit, and npm lockfile validation pass; the unit suite contains **27 passing tests across 11 files** and `cc validate` passes. | VALIDATED in GitHub Actions on 2026-09-11. |
| V-007 | Vitest 5.0.0 resolves the prior `@vitest/mocker` advisory in this dependency graph; `npm ci` and `npm audit` report **0 vulnerabilities**. | VALIDATED in GitHub Actions on 2026-09-11. |
| V-008 | The first GitHub Copilot Gatekeeper review identified MCP pinning, run-artifact permission, glob-matching, and trust-behavior concerns; valid defects were corrected and deliberate fail-closed workstation trust received explicit regression coverage. | VALIDATED through PR #1 review and CI on 2026-09-11. |
| V-009 | The second GitHub Copilot Gatekeeper review identified non-git GitHub-profile selection, advisory-gate blocking loss, and workstation-state directory permissions; all three were corrected with regression coverage and subsequent CI passed. | VALIDATED through PR #1 re-review and CI on 2026-09-11. |
| V-010 | The post-foundation context-optimizer retrofit preserves the feature inside Code Conductor's existing orchestration/MCP/security boundaries. Its reviewed implementation head passes **61 tests across 14 files**, TypeScript build/typecheck, `cc validate`, npm audit with **0 vulnerabilities**, APM audit, dependency review, CodeQL with no new alerts, and GitGuardian with no secrets detected; Copilot review findings were addressed and resolved. | VALIDATED through PR #6 and GitHub checks on 2026-09-12. |
| V-011 | Surface-aware harness capability metadata, execution-surface contracts, surface-specific workstation trust, provider specialization routing, and representative provider-routing tests are implemented. | VALIDATED through PR #20 and GitHub checks on 2026-09-18. |
| V-012 | The VS Code extension bundles the compiled Code Conductor runtime and implements workspace-scoped startup fingerprints/lazy local discovery so packaged use does not depend on a repository-local runtime build path. | VALIDATED through PR #26 and GitHub checks on 2026-09-18; clean-machine behavior remains a release-validation item. |
| V-013 | Kiro has a guarded ACP client path using the official ACP SDK boundary, fail-closed permission handling, bounded cancellation/teardown, read-before-modify surface trust, and deterministic fake-ACP regression coverage. | VALIDATED in repository/CI through PR #25 on 2026-09-18; live Kiro subscription-policy and read/modify authority remain W-002/W-005. |
| V-014 | The Agent Catalog immutable-intake tool inventories/hashes source files, records classification/duplicate/lineage candidates, does not follow symlinks, rejects output inside the source corpus, and does not auto-discard unique content. | VALIDATED through PR #27 and GitHub checks on 2026-09-18; the real corpus has not yet completed migration. |
| V-015 | VSIX packaging has a pinned official `@vscode/vsce` 4.0.0 toolchain, staged Marketplace manifest metadata, publisher validation, and ignored generated release output. | VALIDATED through PR #30 and GitHub checks on 2026-09-18; Marketplace publication/provenance automation remains open. |
| V-016 | At the consolidated post-roadmap checkpoint, Code Conductor CI passes **80 tests across 18 files**, repository validation passes, dependency review and npm lockfile validation pass, and CodeQL passes on the release-packaging head. | VALIDATED through PR #30 checks on 2026-09-18. |

## Items requiring workstation/runtime validation before subscription-backed execution

| ID | Item | Status |
|---|---|---|
| W-001 | Confirm official CLI/client authentication for Copilot, Claude Code/Max, Codex/ChatGPT Business, Kiro Pro, and Antigravity on the actual workstation. | VALIDATE |
| W-002 | Confirm Kiro Pro ACP/subscription-policy behavior and any permitted automation mode on the installed current Kiro CLI before unattended subscription execution. | VALIDATE |
| W-003 | Confirm current VS Code/native-extension and harness capabilities, including provider-native subagents/skills/hooks/MCP/plugin behavior, on the installed VS Code release; keep integration behind surface-aware adapters. Installed-file discovery is available through `cc agents` (ADR 0011); runtime capability behavior and hook evidence (ADR 0012, Proposed) still require validation. | VALIDATE |
| W-004 | Confirm official MCP endpoint/toolset/auth behavior for each project profile before granting any write-capable runtime authority. | VALIDATE |
| W-005 | Confirm exact installed permission/sandbox/authority behavior for Codex, Claude, and Kiro ACP/CLI before Code Conductor enables modifying execution through that harness; Antigravity remains interactive pending ADR 0004 revalidation. | VALIDATE |
| W-006 | Validate the context optimizer's optional MCP adapter against the official MCP TypeScript SDK/current protocol before promoting that adapter beyond experimental; direct package/CLI use may proceed under ADR 0007 boundaries. | VALIDATE |

## Open implementation choices

These remain deliberately replaceable behind interfaces unless/until an ADR locks them:

- exact SQLite client/ORM for persistent indexed task state beyond the v0.1 file-backed run/evidence store
- exact internal event-bus implementation
- exact VS Code tree/webview composition beyond the locked six views
- exact telemetry backend beyond local structured logs for v0.1
- exact model version names; runtime capability discovery/configuration prevents brittle hard-coding

## Change rule

When a future decision supersedes an entry above:

1. create an ADR in `docs/adr/`;
2. cite official/runtime evidence;
3. describe migration impact;
4. update this register in the same PR;
5. update `AGENTS.md`, `STARTER.md`, configuration, tests, and implementation docs if affected.
