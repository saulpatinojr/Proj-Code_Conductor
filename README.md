# Code Conductor

Code Conductor is a **VS Code-centered, multi-provider agent engineering system**. It coordinates subscription-backed AI clients, reusable APM agent packs, official MCP tools/references, safe context preparation, Git worktrees, GitHub pull requests, deterministic quality gates, and human approval without collapsing every provider into a generic chat interface.

## Status

**Target:** v0.1 workstation/VS Code release  
**Current checkpoint:** the approved v0.1 architecture/product delta is implemented on `main`: surface-aware harnesses and provider specialization/routing, a guarded Kiro ACP path, self-contained thin-client packaging/lazy startup, immutable Agent Catalog intake tooling, and the VSIX packaging foundation. The active critical path is now clean-machine/workstation validation plus real R1/R2 dogfood. The first-party context optimizer remains a conservative context-preparation capability; its MCP transport is experimental until official-SDK/current-protocol validation is complete.

See [`docs/STATUS.md`](docs/STATUS.md) for the maintained checkpoint and GitHub issue **#7** for the durable product roadmap/backlog.

## Product shape

Code Conductor v0.x is intentionally **not another standalone desktop app**.

- VS Code is the primary graphical cockpit.
- The Code Conductor extension stays thin and deep-links into native provider/editor/terminal/diff/SCM/PR surfaces.
- An optional thin `cc` CLI/TUI uses the same versioned core/runtime.
- The packaged extension now bundles the compiled Code Conductor runtime; clean-machine validation and Marketplace publication still must prove customers do not need this source tree or a local `npm run build` step.
- First run performs explicit local discovery/bootstrap; subsequent starts use cached non-secret state and lazy provider/MCP/APM activation.

### Sibling product: Code Workflow

[Code Workflow](https://github.com/saulpatinojr/Proj-Code_Workflow) is the slim, in-client sibling. It runs multi-agent workflows inside one AI client (Claude Code, Codex CLI, or GitHub Copilot) through that client's own subagents, installs with one script, and has no background runtime. Code Conductor remains the full cross-provider program: routing, risk classes, independence, worktrees, gates, and human approval. Work exported from Code Workflow (`workflow.py export`) can be brought under Code Conductor review with `cc import <run-manifest.json>`; import never establishes readiness. The boundary and the shared `AgentResult`/`RunManifest` contract are locked in [ADR 0011](docs/adr/0011-code-workflow-sibling-boundary-and-shared-contract.md) (D-057).

## Architecture at a glance

| Layer | Responsibility |
|---|---|
| VS Code | Human cockpit and native editor/terminal/diff/SCM/provider surfaces |
| Code Conductor | Task DAG, routing, risk, authority, context policy, evidence, arbitration, readiness |
| Surface-aware harness adapters | Native extensions, CLI/headless, ACP, MCP, platform workflows/APIs, manual lanes, provider-native agents/subagents/skills/hooks/plugins |
| Context preparation | Provider-neutral, workspace-bounded context reduction; lossless by default, aggressive only by explicit opt-in |
| Microsoft APM | Agent-pack dependency, distribution, lock, projection, integrity, drift |
| MCP | Vendor-official and approved first-party tools/resources; not the runtime scheduler |
| Deterministic tools | Terraform, Ansible, PowerShell, cloud CLIs, Git, Kubernetes/Helm, linters/tests/build tools |
| Git worktrees | Isolated modifying-agent workspaces |
| GitHub | Repository, PR, Actions, review, and merge source of truth |
| Human owner | Final authority for consequential/destructive operations |

The repository constitution is [`AGENTS.md`](AGENTS.md). Locked architectural decisions are in [`docs/DECISIONS.md`](docs/DECISIONS.md). The context-optimization boundary is recorded in ADR 0007, the thin-client/startup model in ADR 0008, and the surface-aware harness/provider-specialization model in ADR 0009.

## Team model

Code Conductor separates **provider, model, harness, surface, billing channel, role, stance, specialization, tools, authority, and risk clearance**. Primary specialization is a routing preference, not exclusivity.

| Provider / platform | Primary Code Conductor specialization |
|---|---|
| **Kiro** | specification/design/task planning, AWS specialist, Kiro-native workflows; preferred Code Conductor boundary is `kiro-cli acp` where policy/workstation validation permits it |
| **Claude Code** | large-codebase engineering, refactoring, deep codebase reasoning |
| **Codex** | implementation, debugging, testing, repository execution |
| **GitHub Copilot / GitHub** | GitHub-native Gatekeeper for PR review/re-review, Actions/PR state, repository/merge context |
| **Perplexity** | external research discovery/synthesis; Pro subscription mode remains human-in-the-loop unless separately billed official MCP/API automation is explicitly enabled |
| **Google Antigravity** | Google/GCP specialist and alternate independent worker/reviewer; unattended execution remains gated by validated authority/sandbox behavior |
| **Code Conductor** | orchestration, risk, routing, authority, evidence, gates, arbitration; it coordinates rather than competes with the specialists |

Provider-native subagents, skills, hooks, commands/plugins/Powers, sessions, permissions, and MCP capabilities should remain available where officially supported. Cross-provider AI invocation remains mediated by Code Conductor so worktree ownership, billing channel, authority, evidence, and readiness are not bypassed.

Important work can add independent constructive, critical/challenger, neutral validator, security, arbiter, and finalizer roles according to risk.

## Agent and skill platform

`.apm/` is the canonical source for reusable agent/skill content. Harness-specific Claude/Codex/Copilot/Kiro/Agent Skills projections are generated/materialized rather than manually maintained as divergent copies.

The user's larger legacy agent/skill library is tracked as a dedicated migration workstream in issue #13. The immutable inventory/lineage intake mechanism is implemented; the actual corpus review and migration are still pending. The migration rule is **100% source-lineage coverage**: every original file is preserved/inventoried and receives a canonical destination or explicit duplicate/superseded disposition before retirement. The goal is modular APM packages with lean personas, reusable deep skills/references, and provider overlays only for genuine harness differences.

## Quick start

To use Code Conductor in your own repositories, install the VS Code extension from a
release `.vsix`; no clone or build is needed. Prerequisites, compatibility, updates and
uninstalling are in [`docs/INSTALL.md`](docs/INSTALL.md).

Prerequisites for repository development are Git, Node.js 22+ (Node 24 recommended), GitHub CLI, and APM 0.30.0. Subscription-backed execution additionally requires the official vendor clients/surfaces described in [`docs/WORKSTATION-VALIDATION.md`](docs/WORKSTATION-VALIDATION.md).

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run cc:validate
```

Validate APM state:

```bash
apm targets
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```

Run workstation diagnostics after building the development checkout:

```bash
npm run cc:doctor
```

List provider-native agents and skills (project and user scope, read-only), marking project files APM did not deploy:

```bash
node packages/cli/dist/index.js agents --repo .
```

Prepare a repository file as context after building. Reads are scoped to the supplied root and sensitive/state paths are blocked:

```bash
node packages/cli/dist/index.js compress README.md --root .
```

That command is lossless/conservative by default. `--aggressive` is an explicit opt-in for content where removing comments/extra whitespace is known to be acceptable. Token counts shown by this local optimizer are estimates, not provider billing or quota data.

Do not enable unattended paid-client execution until the appropriate **surface-specific** trust/smoke validation passes on that workstation. Kiro in particular must validate the approved ACP/native boundary rather than relying only on the older generic CLI smoke path.

## Documentation

Start with [`docs/README.md`](docs/README.md). Key documents include:

- [`STARTER.md`](STARTER.md) — short continuity handoff for a new work session.
- [`docs/STATUS.md`](docs/STATUS.md) — current implementation checkpoint.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and boundaries.
- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) — v0.1 plan and release definition.
- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — credential and subscription/API boundaries.
- [`docs/MCP-CATALOG.md`](docs/MCP-CATALOG.md) — MCP strategy and provenance/activation rules.
- [`docs/WORKSTATION-VALIDATION.md`](docs/WORKSTATION-VALIDATION.md) — live-client/surface validation runbook.
- [`docs/adr/`](docs/adr/) — architecture decision records.

## Repository truth model

- GitHub issue #7 / the linked GitHub Project is the durable product roadmap/backlog once the Project is created.
- `.apm/` is canonical source for reusable agent/skill pack content in this repository.
- `apm.yml` declares package targets/dependencies.
- `apm.lock.yaml` and harness-specific projections are generated/materialized state and are committed for reproducibility; do not hand-edit the lockfile.
- `config/mcp-catalog.yaml` is Code Conductor's policy-driven MCP catalog. `.github/mcp.json` is a minimal Copilot CLI repository configuration, not a second catalog.
- Git is code-state truth; GitHub is PR/CI/review/merge truth.
- Code Conductor run/evidence state is runtime truth, not a replacement for Git/GitHub.
- Chat is design collaboration, not durable product truth; approved substantive ideas are captured in GitHub issues/ADRs/config/tests before they are considered preserved.

## Contributing and security

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change. Security issues must follow [`SECURITY.md`](SECURITY.md); do not place credentials or exploitable vulnerability details in public issues.

This repository is licensed under the [Apache License 2.0](LICENSE).
