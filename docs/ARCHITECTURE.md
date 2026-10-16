# Code Conductor Architecture Baseline

## Purpose

Code Conductor is a VS Code-centered, multi-provider software-engineering team runtime. It coordinates specialized agents, official vendor harnesses, APM-managed Agent Packs, official MCP tools/reference sources, safe context preparation, Git worktrees, deterministic validation, and GitHub PR governance.

## System boundaries

### Human cockpit

VS Code remains the operator surface. Code Conductor adds lightweight orchestration/status/task-intake views and deep-links into native chat/session, terminal, diff, Source Control, and PR experiences.

Code Conductor v0.x does **not** require a standalone MAUI/Electron/tray application. The supported product surfaces are:

- thin Code Conductor VS Code extension;
- optional thin `ccon` CLI/TUI;
- the same versioned core/runtime behind both.

The production extension must not require a customer repository to contain Code Conductor source or run `npm run build`.

### Startup lifecycle

First run performs explicit local bootstrap/discovery:

- workspace/repository/config discovery;
- supported native extension, CLI, ACP, MCP, and deterministic-tool inventory;
- APM manifest/lock/projection checks;
- official authentication-boundary checks where safely discoverable;
- trust/smoke validation before unattended external execution.

Subsequent VS Code launches use cached non-secret health/trust state plus lightweight fingerprints. Claude, Codex, Kiro ACP, MCP servers, APM materialization, and other heavy external processes are lazy/on-demand rather than launched at startup.

### Runtime orchestration plane

Code Conductor Core owns:

- task intake and normalization
- risk classification
- role/stance assignment
- capability-aware routing
- dependency/task DAG
- bounded retries and escalation
- cross-provider assignment mediation
- worktree ownership
- context selection/preparation policy
- evidence aggregation
- disagreement arbitration
- readiness/merge recommendation

### Surface-aware harness plane

A provider is not modeled as one generic executable. Each harness may independently expose:

- native VS Code/IDE extension;
- CLI/headless client;
- ACP endpoint;
- MCP client/server capability;
- platform-native workflow/API surface;
- separately billed SDK/API surface;
- manual human-in-the-loop surface;
- provider-native agents/subagents, skills, hooks, commands/plugins/Powers, sessions, permissions, and other native capabilities.

Initial first-class harness/provider lanes:

- GitHub Copilot / GitHub platform
- Claude Code
- OpenAI Codex
- Kiro
- Google Antigravity
- Perplexity research client/manual lane and optional official MCP/API lane

Harness adapters must be replaceable. Runtime state and policy must not depend on vendor-private internals.

Provider-native capability must be preserved rather than flattened to a lowest-common-denominator chat interface.

### Cross-provider vs provider-local agents

There are two distinct agent levels:

1. **Code Conductor team agents** — cross-provider roles selected by Conductor. Conductor owns provider selection, risk, authority, billing channel, worktree ownership, evidence, and readiness.
2. **Provider-local agents/subagents** — native helpers spawned within an already-assigned provider task. These may use the provider's own subagent/crew/team model when policy permits.

Provider-local subagents do not become independent cross-provider schedulers. One AI provider may not silently shell out to another AI provider and bypass Code Conductor's assignment/evidence boundary.

### Kiro integration

Kiro is a preferred first-class integration, not a generic interchangeable CLI worker.

For the VS Code-centered product, the preferred Kiro boundary is `kiro-cli acp` where current Kiro policy and installed-version validation permit it. Code Conductor acts as an ACP client and preserves Kiro-native session/tool/MCP/agent/subagent/steering/spec/permission capabilities exposed through the harness.

Kiro is the primary routing preference for:

- requirements/specification;
- architecture/design planning;
- task decomposition and verification planning;
- AWS-focused architecture/engineering;
- Kiro-native Power/agent workflows.

Unattended Kiro execution remains fail-closed until current ACP/subscription-policy and read/modify authority are validated on the target workstation.

### Package plane

Microsoft APM is responsible for reusable agent context packaging and dependency integrity:

- Agent Packs
- agents
- skills
- instructions
- prompts
- hooks
- supported MCP declarations
- manifests/locks
- target materialization
- drift/integrity audit

Code Conductor consumes APM; it does not replace APM.

The large legacy agent/skill corpus is migrated through a lineage-controlled process. Every original file must be preserved/inventoried and receive either a canonical destination or an explicit duplicate/superseded disposition before retirement. Canonical packages should be modular by domain/capability, with provider overlays only for genuine harness-specific behavior.

### Context-preparation plane

The first-party context optimizer prepares already-selected context before it is handed to a harness. It does **not** select agents, decide what evidence is authoritative, or bypass repository/harness policy.

Its boundaries are:

- conservative/lossless mode by default;
- explicit aggressive mode only when comment/whitespace removal is acceptable;
- workspace-root and sensitive-file enforcement before local file reads. A file is read through one descriptor opened without following a final symlink, and the kernel's path for that descriptor must be exactly the checked path, so a directory swapped for a symlink mid-read is refused. Only Linux exposes that path to Node, so context files are read only on Linux (including WSL). Hard-linked files are refused, because a hard link can make a file from outside the workspace appear inside it. Reads are size-bounded (ADR 0007);
- provider-neutral core output;
- approximate token-reduction telemetry, never vendor billing/quota truth;
- private local telemetry and time-bounded in-memory original-content cache;
- direct package/CLI use is the primary v0.1 integration path;
- MCP is an optional experimental interoperability adapter until official SDK/current-protocol validation is complete.

### Tool/reference plane

MCP and deterministic CLIs expose tools/resources. They do not choose agents or own orchestration.

Initial official catalog focus:

- GitHub
- Microsoft Learn / Azure
- HashiCorp Terraform
- Ansible
- AWS
- Google Cloud
- Perplexity only when automated API-backed research is explicitly enabled

Code Conductor may also expose approved **first-party** MCP adapters. They are explicitly distinguished from vendor-official servers and remain profile-driven/minimal.

Deterministic engineering tools are not peer GenAI agents. Examples include:

- Terraform extension + `terraform`
- Ansible extension + `ansible` / `ansible-lint`
- PowerShell extension + `pwsh` / analyzers/tests
- Git / GitHub CLI
- Azure CLI / Azure PowerShell
- AWS CLI
- Google Cloud CLI
- Kubernetes / Helm
- language/build/test/lint tooling

Human UX may use native extensions while agents/gates invoke approved CLIs under repository profile and authority policy. Deterministic validation evidence outranks unsupported model opinion about whether a deterministic check passed.

### Change-control plane

Git owns code state. GitHub owns pull requests, CI, review, merge status, and repository audit history.

## Team model

An agent assignment is a composition of independent dimensions:

```text
provider
+ model/capability tier
+ harness/client
+ surface
+ subscription/billing channel
+ role
+ stance
+ specialization
+ skills
+ tools
+ authority
+ risk clearance
```

The same underlying model may serve multiple roles. A primary specialization is a routing preference, not exclusivity.

## Provider specialization map

| Provider / harness | Primary specialization | Secondary eligible work |
|---|---|---|
| Code Conductor | orchestration, risk, routing, authority, evidence, gates, arbitration | none; coordinates rather than competes |
| Kiro | specification/design/task planning, AWS specialist, Kiro-native workflows | implementation, review |
| Claude Code | large-codebase engineering, refactoring, deep codebase reasoning | implementation, challenger/reviewer |
| Codex | implementation, debugging, testing, repository execution | review/challenge, focused planning |
| GitHub Copilot + GitHub | GitHub Gatekeeper: PR review/re-review, Actions, repository/merge context | repository-native coding assistance |
| Perplexity | external research, source discovery, synthesis | comparison/reconnaissance; automation only when explicit paid API/MCP policy permits |
| Google Antigravity | Google/GCP specialist and alternate independent worker/reviewer | implementation/challenge after authority validation |

When more than one provider can satisfy a task, routing prefers unique platform advantage while preserving different-provider independence at higher risk.

## Orchestration roles

- **Conductor**: neutral coordinator and scheduler.
- **Spec Lead**: requirements, design, task planning, verification planning; Kiro preferred.
- **Research Captain**: external research discovery/synthesis; Perplexity preferred.
- **Builder**: implementation; provider selected by specialization/task fit.
- **Reviewer/Challenger**: independent critical role; different provider at R2+ when required.
- **Security Reviewer**: critical read/block role.
- **Validator**: neutral deterministic validation role.
- **GitHub Gatekeeper**: GitHub-native PR review/re-review, Actions/PR checks, repository context.
- **Arbiter**: neutral dispute resolver.
- **Finalizer**: objective-level readiness evaluator.
- **Human Owner**: final authority for consequential operations.

## Stance model

- `constructive`: build, improve, optimize, solve.
- `critical`: find defects, challenge assumptions, identify risk.
- `neutral`: research, compare, validate, arbitrate.

A critical stance never means inventing disagreement. Findings require evidence.

## Risk-driven orchestration

```text
R0 -> builder + deterministic check
R1 -> builder + validator/reviewer + deterministic tests
R2 -> builder + different-provider challenger + validator + GitHub gatekeeper
R3 -> research/spec + builder + challenger + security + validator + GitHub gatekeeper + finalizer + human approval
R4 -> R3 + explicit human approval before destructive/external side effects
```

## Execution topology

```text
VS Code
  |
  +-- Code Conductor Extension (thin)
  |      +-- task intake/status
  |      +-- Team / Runs / Gates / Connections / Packs / Usage
  |      +-- deep-links to native provider/editor surfaces
  |
  +-- Code Conductor Core
         |
         +-- optional ccon CLI/TUI
         +-- Policy + Risk + DAG + Evidence
         +-- Startup/Capability Discovery Cache
         +-- Context Preparation
         |
         +-- Surface-aware Harness Adapters
         |      +-- Copilot/GitHub platform
         |      +-- Claude extension + CLI
         |      +-- Codex extension + CLI
         |      +-- Kiro ACP + CLI/native harness
         |      +-- Antigravity
         |      +-- Perplexity manual + optional paid MCP/API
         |
         +-- APM Adapter
         +-- MCP Catalog/Broker
         +-- Deterministic Tool Registry
         +-- Git Worktree Manager
         +-- GitHub Gatekeeper Adapter
```

## Work isolation

Each modifying assignment receives a task-scoped branch/worktree where practical. Review-only roles remain read-only. Worktree isolation prevents accidental file collisions but is not itself a security sandbox.

Recommended naming:

```text
branch: cc/<task-id>/<agent-id>
worktree: ~/.code-conductor/worktrees/<repo-id>/<task-id>/<agent-id>/
```

## Structured contracts

All orchestration crosses stable structured contracts:

- `TaskEnvelope`
- `AgentAssignment`
- `AgentResult`
- `Evidence`
- `Finding`
- `GateResult`
- `ReviewResult`
- `MergeDecision`
- `RunManifest`

Free-form agent prose may be attached as evidence, but runtime decisions must be representable in structured fields.

## Evidence precedence

1. user-approved requirements and repository policy
2. executable repository evidence: tests, build output, CI, plan/diff
3. official vendor documentation/reference sources
4. structured run evidence/findings
5. model recommendation/confidence

No model wins merely because it is more capable or expensive. Context optimization must preserve this ordering; it may reduce transport size but may not discard higher-precedence meaning.

## Authentication boundary

Code Conductor never becomes the credential vault for consumer subscriptions. Vendor clients authenticate through their supported official mechanisms. Conductor may report health/presence and warn about billing-mode conflicts without printing or persisting secret values.

## Deployment baseline

v0.1 is local/workstation-first:

- VS Code on the operator workstation
- WSL2/dev container recommended where stronger Linux sandbox/tool compatibility is useful
- local Code Conductor core plus optional `ccon` CLI/TUI
- local runtime state/cache
- Git worktrees on local disk
- outbound HTTPS/OAuth to GitHub and vendor/cloud services
- no always-on Code Conductor daemon required

No always-on cloud control plane or standalone desktop application is required for v0.1.

## Distribution baseline

Customer-facing distribution targets:

- VS Code Marketplace as the primary install/update path;
- Marketplace pre-release channel for beta/RC testing;
- VSIX for offline/enterprise/manual installation;
- GitHub Releases for auditable release history/artifacts;
- optional `ccon` CLI distribution under the same version/release policy.

Production artifacts must be CI-built and traceable to source/release provenance before public release.

## Non-goals for v0.1

- replacing vendor chat UIs
- building a standalone Code Conductor desktop app
- hosting a proprietary model gateway
- scraping consumer AI web sessions
- building a custom APM replacement
- building a custom MCP standard
- allowing providers to bypass Conductor for cross-provider AI scheduling
- autonomous production deployment without policy/human gates
- hard-coding current model version names into core orchestration logic
- treating heuristic token estimates as billing/quota truth
- stripping instructions/comments by default for the sake of a compression percentage
