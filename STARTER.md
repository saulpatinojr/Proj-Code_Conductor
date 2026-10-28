# STARTER.md — Code Conductor continuity handoff

This repository is the canonical home for Code Conductor. Use this file as the short entry point when a new human or AI work session resumes the project.

## Read first

Read in this order before making material changes:

1. `AGENTS.md` — repository constitution.
2. `docs/DECISIONS.md` — locked decisions and validated facts.
3. `docs/STATUS.md` — current checkpoint and immediate next milestone.
4. `docs/IMPLEMENTATION-PLAN.md` — v0.1 release plan/definition of done.
5. Relevant domain docs under `docs/` and the applicable ADRs, including ADR 0007 for context preparation, ADR 0008 for the thin-client/startup model, and ADR 0009 for surface-aware harness/provider specialization.
6. GitHub roadmap issue #7 and the active release/readiness issue #4.
7. `CONTRIBUTING.md` before changing branches, APM source, workflows, or governance files.

Do not redesign a locked architecture decision from memory or preference. If verified platform evidence requires a change, create a superseding ADR and update the decision register in the same PR.

## Current checkpoint

The repository foundation is implemented rather than architecture-only:

- TypeScript workspace and structured contracts exist;
- task state/risk/policy planning and runtime execution foundations exist;
- bounded retry, schema-validated structured result parsing, private run/evidence persistence, deterministic gates, and worktree handling exist;
- APM 0.33.0 is pinned (the version Agent Packs pins, D-077), the lockfile and materialized projections are committed, and APM audit passes;
- `package-lock.json` is committed and CI uses reproducible installs;
- Vitest 5 is installed and the npm dependency graph is audit-clean;
- initial Codex, Claude, Kiro, Antigravity, GitHub, APM, MCP, and workstation adapter boundaries exist;
- the first-party context optimizer exists as a bounded context-preparation component with lossless default behavior, explicit aggressive mode, workspace/sensitive-path protection, and estimated-token telemetry;
- the context optimizer's MCP transport is intentionally experimental pending official MCP TypeScript SDK/current-protocol validation;
- `ccon validate`, `doctor`, `plan`, `run`, `harness-smoke`, MCP/APM, GitHub-gate, `context-stats`, `compress` and `gate-output` command paths exist; gate output is stored with each run and may be shown as an opt-in verbatim-line summary (`run --tool-output summary`, D-071);
- the VS Code extension exposes Team, Runs, Gates, Connections, Packs, and Usage and now bundles the compiled Code Conductor runtime for packaged use;
- CodeQL, dependency-review configuration, repository CI, APM audit, npm lockfile validation, and secret scanning are part of the GitHub governance baseline;
- repository-scoped Copilot CLI MCP configuration is minimal under `.github/mcp.json`; GitHub.com Copilot MCP configuration remains a repository-settings/platform concern rather than a custom token-minting workflow;
- multiple GitHub Copilot Gatekeeper review rounds have been exercised and concrete findings have been addressed with targeted regression coverage;
- GitHub issue #7 now owns durable product roadmap capture so substantive approved ideas are not left only in chat;
- issues #8-#18 capture the approved thin-client, startup, harness, Kiro, routing, agent-catalog, release, tooling, APM/Kiro, Perplexity, and Antigravity workstreams;
- ADR 0008 locks the no-standalone-app/thin VS Code + optional `ccon` client and lazy startup model;
- ADR 0009 locks the surface-aware harness model, provider-native capability preservation, Kiro ACP-first preference, provider specializations, and deterministic-tool separation;
- the surface-aware capability schema/routing implementation is on `main`, including explicit execution surfaces and specialization tests;
- the guarded Kiro ACP SDK client path is on `main`; live subscription/policy and read/modify trust remain fail-closed until workstation validation;
- first-run/warm-start fingerprinting, lazy discovery, and self-contained VS Code bundle verification are on `main`;
- immutable Agent Catalog intake/lineage tooling is on `main`; the actual legacy corpus migration remains the parallel #13 workstream;
- the VSIX packaging foundation is on `main` with pinned official `@vscode/vsce`; Marketplace publication/provenance automation remains under #14;
- the large legacy agent/skill corpus migration is a parallel tracked workstream under issue #13 with a 100% source-lineage requirement.

The authoritative current status is `docs/STATUS.md`. The approved cockpit,
orchestration, APM and Obsidian follow-up is tracked in #139–#142;
PR #143 merged the initial scoped-run/configuration/task-refresh fixes; start with
#139 reliability and retain installed-VSIX validation before claiming completion.

## Immediate work order

The architecture/runtime delta from #10/#11/#12 is implemented. Do not reopen it unless validation evidence requires a superseding ADR.

1. Start from current `main`, review `docs/STATUS.md`, issue #4, and `docs/WORKSTATION-VALIDATION.md`.
2. Install/activate the packaged extension on the target VS Code workstation and validate first-run discovery plus warm lazy startup.
3. Validate official subscription authentication and surface-specific read/modify trust for Codex, Claude Code, and Kiro ACP. Kiro remains fail-closed until installed-version/policy/authority validation passes.
4. Keep Antigravity unattended execution blocked until ADR 0004 is superseded with current evidence; continue treating it as the Google/GCP specialist lane.
5. Validate only the MCP/reference and deterministic-tool profiles required by the dogfood scenario.
6. Execute the first real R1 Code Conductor task in an isolated modifying worktree, then raise it to R2 with a different-provider challenger and GitHub Gatekeeper participation.
7. Capture structured evidence, fix defects found, and validate the VS Code cockpit/startup behavior against the real run.
8. In parallel, use the merged Agent Catalog intake tool against the actual legacy corpus and review migration batches into modular APM packages with 100% source-lineage accounting.
9. Continue the merged VSIX packaging foundation into #14 Marketplace/provenance/SBOM/attestation/publication work.
10. Prepare a v0.1 release candidate only when the release definition and repository-governance requirements are satisfied.

## Locked operating model

- VS Code is the primary cockpit; Code Conductor v0.x does not require a standalone desktop application.
- The thin VS Code extension and optional thin `ccon` CLI/TUI use the same versioned core/runtime.
- First run performs explicit bootstrap/discovery; warm starts use cached non-secret state and lazy provider/MCP/APM activation.
- Code Conductor owns runtime orchestration, risk, authority, context-preparation policy, evidence, and readiness.
- APM owns reusable agent-pack dependency/distribution/integrity concerns.
- MCP provides tools/resources and is not the team scheduler.
- Harness integration is surface-aware rather than reduced to a generic CLI boolean.
- Provider-native subagents, skills, hooks, commands/plugins/Powers, permissions, sessions, and IDE capabilities are preserved where officially supported.
- Cross-provider AI invocation is mediated by Code Conductor; provider-local subagents may operate inside an assigned task boundary.
- Kiro is the preferred specification/design/task-planning lead and AWS specialist; `kiro-cli acp` is the preferred Kiro client/harness boundary where policy and workstation validation permit it.
- Claude Code is preferred for large-codebase engineering/refactoring/deep codebase reasoning.
- Codex is preferred for implementation/debugging/testing/repository execution.
- GitHub Copilot/GitHub remains the GitHub Gatekeeper.
- Perplexity remains the external Research Captain in human-in-the-loop subscription mode unless explicit paid official MCP/API automation is enabled.
- Antigravity remains the Google/GCP specialist and alternate independent lane, with unattended headless use gated by safety revalidation.
- Terraform, Ansible, PowerShell, cloud CLIs, Git, Kubernetes/Helm, linters, test runners, and similar deterministic capabilities are governed tools rather than peer AI agents.
- Context preparation is provider-neutral, lossless by default, bounded to approved workspace inputs, and never treats heuristic token estimates as billing truth.
- Git owns code state; GitHub owns PR, Actions, review, and merge state.
- Subscription-backed official clients are preferred before separately billed model APIs.
- Provider/model/harness/surface/role/stance/specialization/authority/risk are independent dimensions.
- Modifying agents use isolated branches/worktrees; a clean Git merge is not proof of correctness.
- Implementers do not self-review, self-approve, self-merge, or bypass deterministic gates.
- High-impact/destructive external operations retain explicit human approval.

## Repository development checks

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run ccon:validate
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```

For live clients, use the smoke-test sequence in `docs/WORKSTATION-VALIDATION.md`; never infer trust merely because a CLI binary or extension is installed.

## Branch and file hygiene

- Do not work directly on `main` for normal feature changes.
- Remove merged/superseded remote and local branches after confirming their commits are preserved on `main`.
- Do not commit runtime state, credentials, local worktrees, build output, package caches, or local context-optimizer telemetry.
- Specialist agents and skills come from the Agent Packs repository through APM; `.apm/` holds only Code Conductor's own skills (ADR 0015), and generated target projections are committed only when they match the APM lock/materialization state.
- Keep GitHub-specific review skills under `.github/skills/` scoped to GitHub behavior; do not duplicate cross-harness canonical pack content there.
- Keep `README.md`, `STARTER.md`, `docs/STATUS.md`, `CHANGELOG.md`, and relevant ADR/runbooks synchronized with material behavior changes.

## Completion rule

Continue until the current task's acceptance criteria and required gates are satisfied. Preserve decisions, code, evidence, roadmap items, and documentation in GitHub as you go so future sessions do not depend on chat history.
