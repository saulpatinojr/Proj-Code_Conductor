# Code Conductor v0.1 Implementation Plan

## Goal

Deliver a working orchestration system for VS Code that coordinates existing subscription-backed AI clients and official platform integrations rather than recreating them. The v0.1 design remains workstation-first, provider-neutral, evidence-driven, surface-aware, and safe to extend.

## Architecture layers

### 1. Cockpit

VS Code is the primary operator UI. A thin Code Conductor extension exposes Team, Runs, Gates, Connections, Packs, and Usage views and deep-links into native agent sessions, terminals, diffs, Source Control, and GitHub PR tooling.

Code Conductor v0.x does not require a standalone desktop application. An optional thin `ccon` CLI/TUI uses the same versioned core/runtime as the extension.

The production VS Code package must contain or reliably resolve the compiled Code Conductor runtime required by normal users. Customer repositories must not need this source repository or an `npm run build` step.

### 2. Runtime control plane

Code Conductor Core owns:

- task envelope creation
- DAG/dependency scheduling
- capability/surface-aware routing
- risk classification
- role and stance assignment
- authority checks
- bounded retry/escalation
- cross-provider assignment mediation
- context-selection/preparation policy
- evidence aggregation
- disagreement arbitration
- merge/readiness decisions

The core must remain vendor-neutral.

### 3. Surface-aware harness plane

Initial supported provider lanes:

- GitHub Copilot / GitHub platform
- Claude Code
- OpenAI Codex
- Kiro
- Google Antigravity
- Perplexity research: manual Pro-client mode plus optional official MCP/API mode

A harness may independently expose a VS Code/IDE surface, CLI/headless execution, ACP, MCP, platform-native workflow/API, separately billed SDK/API, and/or a manual human-in-the-loop surface. A single generic `cli_preferred` assumption is not sufficient for the long-term adapter model.

Code Conductor must preserve provider-native subagents/agents, skills, hooks, commands/plugins/Powers, permissions, sessions, MCP, and native IDE capabilities where officially supported. Provider-local subagents may operate within an assigned task, while cross-provider AI invocation remains mediated by Code Conductor so authority, billing channel, worktree ownership, evidence, and readiness remain controlled.

Preserve each vendor's native authentication boundary. AHP or other compatibility layers may be used only behind replaceable adapters and must not become the core orchestration contract.

#### Kiro preferred boundary

Kiro is not treated as an interchangeable generic CLI worker. For the VS Code-centered product, `kiro-cli acp` is the preferred Kiro client/harness boundary where current policy and installed-version validation permit it.

Kiro receives primary routing preference for:

- specification/requirements
- architecture/design planning
- task decomposition and verification planning
- AWS-focused architecture/engineering
- Kiro-native Power/agent workflows

Kiro may still implement or review code when policy/capability calls for it. Unattended execution remains fail-closed until current ACP/subscription-policy and read/modify authority are validated.

### 4. Context-preparation plane

The first-party context optimizer prepares context already selected by Code Conductor. It is not a scheduler and it does not decide what evidence is authoritative.

- lossless/conservative is the default;
- valid JSON may be compacted semantically;
- comment/whitespace removal for other content requires explicit aggressive mode;
- file reads are workspace-root scoped after canonical/symlink resolution;
- sensitive/state/credential paths and oversized/non-regular files are denied;
- local token counts are estimates for relative telemetry, never billing/quota truth;
- core output is provider-neutral;
- direct package/CLI integration is primary for v0.1;
- the MCP transport is optional and remains experimental until official MCP TypeScript SDK/current-protocol validation is complete.

### 5. Package plane

Microsoft APM is authoritative for reusable agent-pack dependency/distribution/integrity concerns.

- `apm.yml` is the project manifest.
- `apm.lock.yaml` is generated and must never be hand-edited.
- `apm-policy.yml` controls allowed package/MCP policy.
- `.apm/` is canonical package source for reusable agents/skills.
- Copilot/Claude/Codex/Kiro/Antigravity/Agent Skills target directories are materialized projections.

Pinned targets for the foundation are Copilot, Claude, Codex, Kiro, Antigravity, and converged Agent Skills.

The legacy agent/skill library migration is a dedicated parallel workstream. It requires 100% source-lineage coverage before legacy retirement: immutable intake, inventory, classification, duplicate/merge lineage, canonical destination, provider overlays where genuinely required, and semantic validation.

### 6. Tool/reference plane

Only vendor-official or explicitly approved Code Conductor first-party MCPs belong in the catalog. Enable them per repository profile, not globally by default.

Initial catalog:

- GitHub official MCP
- Microsoft Learn official MCP
- Azure official MCP when an Azure project requires it
- HashiCorp Terraform official MCP for Terraform repositories
- Ansible official ADT/MCP where supported, with deterministic Ansible tooling remaining release authority while preview limitations exist
- AWS official managed/local MCP tooling when an AWS project requires it
- Google Cloud managed MCP tooling when a GCP project requires it
- Perplexity official MCP only when API billing is explicitly enabled
- Code Conductor context optimizer only under its explicit first-party profile while the adapter remains experimental

MCP provides tools/resources. It does not schedule the team.

Deterministic engineering capabilities such as Terraform, Ansible, PowerShell, Git/GitHub CLI, Azure/AWS/GCP CLIs, Kubernetes/Helm, language toolchains, linters, build systems, and test runners are governed tools, not peer GenAI agents. Native extensions remain first-class human surfaces; approved CLIs may be used by agents/gates under assignment/risk policy.

GitHub Copilot has a separate configuration boundary: `.github/mcp.json` is minimal repository-scoped Copilot CLI configuration; GitHub.com Copilot code-review/cloud MCP servers are configured through repository settings and built-in GitHub MCP capability rather than a custom token-minter workflow.

### 7. Startup lifecycle

First run performs explicit local bootstrap/discovery:

- workspace/config detection
- provider extension/CLI/ACP/platform/manual surface inventory
- APM manifest/lock/projection checks
- deterministic tool inventory
- safe auth-boundary/health checks
- smoke/trust validation before unattended execution

Warm starts use cached local non-secret health/trust state and lightweight fingerprints. Do not start AI provider processes, Kiro ACP, MCP servers, or APM materialization unless the active task/config requires them.

### 8. Change plane

Git owns code state. GitHub owns repository, PR, Actions, review, and merge state.

Every modifying assignment should receive a task/agent branch and isolated worktree. Review-only assignments are normally read-only. Integration must be validated again after combining work.

## Team and provider specialization

Primary specialization is a routing preference, not exclusivity.

| Provider / harness | Primary responsibility | Secondary eligible work |
|---|---|---|
| Code Conductor | orchestration, routing, risk, authority, evidence, gates, arbitration | coordinates rather than competes |
| Kiro | specification/design/task planning, AWS specialist, Kiro-native workflows | implementation, review |
| Claude Code | large-codebase engineering, refactoring, deep codebase reasoning | implementation, challenger/reviewer |
| Codex | implementation, debugging, testing, repository execution | review/challenge, focused planning |
| GitHub Copilot + GitHub | GitHub Gatekeeper: PR review/re-review, Actions, repository/merge context | repository-native coding assistance |
| Perplexity | external research discovery/synthesis | comparison/reconnaissance; automated API/MCP only when explicitly paid/enabled |
| Google Antigravity | Google/GCP specialist and alternate independent worker/reviewer | implementation/challenge after authority validation |

### Conductor
Neutral coordinator. Assigns work, composes the task DAG, enforces policy, and escalates.

### Spec Lead
Primary requirements/specification/design/task-planning role for substantial feature work. Kiro is preferred, especially for AWS/Kiro-native workflows.

### Research Captain
Primary external research discovery role. Perplexity is preferred. In subscription-only mode, research is human-in-the-loop through the Pro client. Automated research requires the official MCP/API lane and explicit spend policy.

### Builder
Implementation role. Provider selection is based on specialization and capability. Claude is preferred for large/refactoring-heavy codebase work; Codex for implementation/debugging/testing/repository execution; Kiro for AWS/spec-driven work; Antigravity for Google/GCP work after authority validation.

### GitHub Gatekeeper
GitHub Copilot plus GitHub platform capabilities. Owns GitHub-native PR review/re-review, repository context, Actions/PR inspection, and PR-quality checks. It is not merely another generic coder.

### Challenger
Critical stance. Must be independent from the primary builder when risk policy requires it. Attempts to falsify assumptions and surface defects.

### Security Reviewer
Critical stance, read/block authority by default.

### Validator
Neutral stance. Re-runs deterministic tests/validation from a clean state.

### Arbiter
Neutral principal-level role for material disagreement.

### Finalizer
Determines objective-level readiness based on structured evidence. Does not bypass human approval policy.

## Risk policy

- R0: builder + deterministic check.
- R1: builder + reviewer + deterministic tests.
- R2: builder + different-provider challenger + validator + GitHub review when applicable.
- R3: research/reference + spec/architecture + builder + challenger + security + validator + GitHub review + finalizer + human approval.
- R4: R3 plus explicit human approval before destructive/external production action.

## Structured contracts

Core contracts are:

- `TaskEnvelope`
- `AgentAssignment`
- `AgentResult`
- `Evidence`
- `Finding`
- `GateResult`
- `ReviewResult`
- `MergeDecision`
- `RunManifest`

Each result records task id, agent id, role, stance, provider, harness, billing channel, status, changes, tests, evidence, findings, risks, blockers, and recommendation.

The adapter capability model must evolve to describe provider surfaces and native capabilities without forcing those details into the core task/result contract.

## Authentication design

Code Conductor must not store consumer OAuth tokens or impersonate vendor clients.

- GitHub/Copilot: official GitHub/VS Code authentication.
- Claude Code: official Claude account/subscription authentication; warn when API-key environment variables could change billing behavior.
- Codex: ChatGPT/Codex subscription authentication where supported.
- Kiro: official Kiro authentication; ACP/native automation must remain within current Kiro subscription/policy boundaries.
- Antigravity: official Google sign-in/keyring flow.
- Perplexity: Pro consumer login for manual mode; official API key only for explicitly enabled MCP automation.

`ccon doctor` detects relevant client/surface availability, auth status where safely discoverable, conflicting API-key environment variables, repository trust, Git state, APM state, MCP health, deterministic tools, and sandbox capability. It never prints secret values.

## Surface-aware execution decision

Do not reduce the product to either "extensions" or "CLIs." Use the best official surface for the job:

- native IDE extensions are first-class human interaction surfaces;
- official CLI/headless execution is preferred for machine orchestration when the provider supports it safely;
- ACP is the preferred Kiro client/harness boundary for Code Conductor where validated;
- GitHub/Copilot workflow operations use GitHub-native PR/review/Actions semantics;
- Perplexity Pro remains manual unless official paid MCP/API access is explicitly enabled;
- deterministic CLIs are governed tools, not peer AI providers;
- cross-provider AI invocation always returns through Code Conductor assignment/evidence policy.

## Repository layout

```text
Proj-Code_Conductor/
├── AGENTS.md
├── STARTER.md
├── README.md
├── apm.yml
├── apm.lock.yaml
├── apm-policy.yml
├── apps/
│   └── vscode/
├── packages/
│   ├── core/
│   ├── cli/
│   ├── schemas/
│   ├── policy/
│   ├── runtime/
│   ├── evidence/
│   ├── gates/
│   ├── git/
│   ├── workstation/
│   ├── context-optimizer/
│   ├── mcp/
│   ├── apm-adapter/
│   ├── github-gate/
│   └── adapters/
├── config/
│   ├── capabilities.yaml
│   ├── roles.yaml
│   ├── risk.yaml
│   ├── authorities.yaml
│   ├── references.yaml
│   ├── gates.yaml
│   └── mcp-catalog.yaml
├── .apm/
├── .agents/
├── .github/
│   ├── agents/
│   ├── skills/
│   ├── workflows/
│   └── mcp.json
├── tests/
└── docs/
    ├── IMPLEMENTATION-PLAN.md
    ├── ARCHITECTURE.md
    └── adr/
```

Do not create empty scaffolding merely to make the tree look complete; create directories when their first implementation lands.

## Implementation phases

### Phase 0 — Foundation — implemented

- repository constitution and decision register
- APM manifest/lock/policy and explicit targets
- `STARTER.md`
- architecture/implementation plan
- CI and repository governance baseline

### Phase 1 — Contracts and core — implemented baseline

- TypeScript workspace
- schemas and validation
- task state machine
- policy/risk engine
- capability registry
- structured evidence/run persistence

### Phase 2 — Local execution — implemented baseline, workstation validation next

- CLI `ccon`
- `ccon doctor`
- `ccon validate`
- Git/worktree manager
- Codex adapter
- Claude adapter
- initial Kiro adapter
- Antigravity safety boundary
- workstation trust/smoke validation
- context-preparation package/CLI with lossless default and explicit aggressive mode

The required architecture delta is implemented in the repository:

- surface-aware capability discovery/routing and provider-native capability metadata (#10);
- guarded Kiro ACP-first client path with surface-specific trust and fail-closed permissions (#11);
- provider specialization/routing rules and representative tests (#12).

Remaining work is live installed-client/subscription/authority validation, not reimplementation of these boundaries.

### Phase 3 — Package/tool integration — implemented baseline, live validation + agent-catalog work next

- APM adapter
- approved MCP catalog
- selective MCP activation profiles
- vendor-official vs approved first-party provenance
- official-reference policies
- pack compilation/materialization validation
- context-optimizer experimental MCP adapter; official SDK/current-protocol migration remains a pre-GA task
- immutable inventory/lineage intake tooling is implemented; run it against the actual legacy corpus and continue reviewed migration/canonicalization batches (#13)
- validate representative deterministic-tool profiles as required (#15)

### Phase 4 — GitHub Gatekeeper — implemented baseline, dogfood next

- PR state adapter
- Actions/status inspection
- Copilot review/re-review workflow
- required gate aggregation
- CodeQL and dependency-review workflows
- human merge boundary
- repository-specific `.github/skills/code-review` instructions

### Phase 5 — VS Code cockpit/productization — thin foundation implemented, product validation next

- Team
- Runs
- Gates
- Connections
- Packs
- Usage, including clearly labeled estimated context-optimization telemetry
- first-run/bootstrap and warm-start/lazy-activation implementation (#9); live startup validation remains
- bundled compiled runtime and VSIX packaging foundation so customer repositories do not need this source tree (#8/#14); clean-machine and Marketplace validation remain
- preserve/deep-link native provider surfaces rather than building a replacement chat UI

### Phase 6 — Evaluation / current next phase

The architecture/runtime/product foundations above are merged. Execute the live release-readiness path in this order:

1. sync/verify current `main` and install/activate the packaged extension on the target workstation;
2. run `ccon doctor` and validate first-run discovery plus warm lazy startup;
3. authenticate supported subscription-backed clients using official mechanisms;
4. smoke-test the selected Codex/Claude/Kiro surfaces in read mode, then isolated modify mode; Kiro ACP remains fail-closed until current subscription-policy and authority behavior are proven;
5. verify only the MCP/reference and deterministic-tool profiles required by the scenario;
6. exercise context preparation in lossless mode on representative repository inputs;
7. execute a real R1 task through Code Conductor using an isolated worktree and deterministic validation;
8. raise the same scenario to R2 with a different-provider challenger plus GitHub Gatekeeper review/re-review;
9. capture structured evidence, resolve defects, and validate cockpit/startup/package behavior against the run;
10. complete the context-optimizer official MCP SDK/current-protocol gate before calling that adapter GA;
11. finish #14 publication/provenance/customer-trust controls and prepare the v0.1 release candidate.

Track task success, defects caught, false positives, retries, latency, subscription/API lane, API spend, estimated context reduction, human interventions, selected provider surface, and native-capability use. Do not treat heuristic token estimates as vendor cost measurements.

### Parallel workstreams

These may advance without silently blocking the runtime release path:

- #13 legacy Agent Catalog/APM migration: immutable intake, 100% lineage ledger, deduplication/canonicalization, modular packages, projections, semantic validation;
- #14 Marketplace/VSIX/CLI/release provenance/customer trust pipeline;
- #16 APM Agent Plugin ↔ Kiro Powers interoperability research;
- #18 current Antigravity `agy` safety revalidation.

Pull a parallel item into the active release only when a concrete acceptance criterion depends on it.

## First dogfood scenario

Use this repository itself. The first real R1/R2 run must exercise the already-built runtime plus the approved surface-aware delta rather than manually reproducing its behavior. A modifying builder works in an isolated worktree, an independent role reviews/challenges it, deterministic gates run, GitHub Gatekeeper reviews the PR, and Code Conductor captures the evidence/readiness result.

Kiro should be exercised through the approved ACP/native boundary if selected for the scenario; do not count obsolete generic Kiro execution as proof of the post-ADR design.

## Release gate for v0.1

A clean workstation must be able to:

- install Code Conductor through the release extension/VSIX path without cloning this repository;
- open an ordinary repository and complete first-run discovery, creating no files in it unless the person opts in (C01);
- restart VS Code with fast lazy warm-start behavior and no unnecessary provider/MCP/APM launches;
- verify APM targets for repositories that package agent packs (APM is optional for basic provider handoffs, I07);
- authenticate supported official clients through their native boundaries;
- run `ccon doctor` with surface-aware/provider/tool status;
- safely prepare bounded context;
- repeat that in a second, unrelated repository that has no Code Conductor files;
- execute an R1/R2 task using independent roles and the approved provider surfaces;
- isolate changes;
- run deterministic checks;
- create a GitHub PR;
- surface GitHub-native review/re-review;
- collect structured evidence;
- enforce human approval where policy requires it.

For Kiro, the release path must validate the approved ACP/native boundary and current subscription/authority behavior before unattended use. The context optimizer's direct/CLI path may ship in v0.1 when its boundaries pass; its MCP adapter remains experimental until the official-SDK/current-protocol gate is satisfied.

Public/customer publication additionally requires the release-engineering/trust controls tracked in #14 and the repository-governance settings tracked in #3 to be satisfied or explicitly documented as release blockers.
