---
name: code-conductor-review
description: >-
  Repository-specific code review for Code Conductor — TypeScript packages,
  runtime orchestration, policy engine, deterministic gates, Git worktree isolation,
  context preparation, APM packaging, official MCP adapters, and the VS Code cockpit.
  Use this whenever reviewing a diff, branch, or pull request in this repository,
  whenever checking changes to any component here, and before opening or merging
  a PR with non-trivial changes.
---

# Code Conductor Code Review

Review changes the way this repository's CI and Gatekeeper reviewers will: component by component, with the repository's deterministic checks and locked governance policies.

## 1. Scope the review

Establish exactly what is being reviewed before reading code:

```bash
git diff --stat main...HEAD        # a branch
git diff --stat HEAD               # the working tree
git show <sha> --stat              # a single commit
```

Map every touched path to its component and validation requirement:

| Touched path | Component | Core considerations & verification |
| --- | --- | --- |
| `packages/core/**`, `packages/runtime/**` | Orchestration & execution engine | State machine transitions, bounded retries, structured `AgentResult` validation, plan execution, fail-closed handling. Run `npm test`. |
| `packages/policy/**`, `config/**` | Risk & authority policy | Separation of duties (implementer cannot self-approve/merge), role authority projection, challenger independence, risk tiers (R0-R4). Run `npm test` and `node packages/cli/dist/index.js validate .`. |
| `packages/schemas/**` | Schema & contract boundary | JSON Schema Draft 2020-12 compliance, type safety, enum validation. Run `npm test`. |
| `packages/gates/**` | Deterministic quality gates | Recursive glob matching, blocking vs advisory semantics, profile detection. Run `npm test`. |
| `packages/git/**` | Git & worktree manager | Owner-only directory permissions (`0700`), ref sanitization (`..`, `.lock`), rename/copy-aware status parsing. Run `npm test`. |
| `packages/evidence/**` | Evidence store | Path traversal prevention, tamper resistance, owner-only directory permissions. Run `npm test`. |
| `packages/context-optimizer/**` | Context preparation | Lossless/conservative behavior by default, explicit aggressive mode, workspace-root enforcement after symlink resolution, sensitive-path blocking, bounded file size, owner-only telemetry, provider-neutral output, estimated-token labeling. Run `npm test`. |
| `packages/mcp/**`, `config/mcp-catalog.yaml` | MCP selection & catalog | Vendor-official vs approved Code Conductor first-party provenance, least privilege, profile-driven activation, pinned executable versions, MCP must not become the scheduler. Run `npm test`. |
| `.github/mcp.json` | Copilot CLI repository MCP config | Keep minimal and read-only. This file is for repository-scoped Copilot CLI configuration; GitHub.com Copilot code-review/cloud MCP servers are configured in repository settings and GitHub's built-in GitHub MCP should not be duplicated here. |
| `packages/workstation/**` | Workstation trust | Private trust storage, fail-closed behavior for unvalidated harnesses. Run `npm test`. |
| `packages/apm-adapter/**`, `.apm/**`, `apm*.yml` | APM packaging & projections | Lockfile consistency (`apm.lock.yaml`), `.apm/` skill source matching projections in `.github/`, `.claude/`, `.codex/`, `.kiro/`; no agent files in `.apm/` (specialists come from Agent Packs, ADR 0015). Run `apm audit`. |
| `apps/vscode/**` | VS Code extension cockpit | Extension activation, state labels matching real implementation status, non-blocking UI integration. Run `npm run typecheck`. |
| `docs/**`, `*.md` | Governance & documentation | Check `AGENTS.md`, `docs/DECISIONS.md`, and ADRs. Ensure locked decisions are preserved. |

## 2. Review each component

For each component, do three passes in this order:

1. **Correctness & Robustness** — check for unhandled error paths, broken state transitions, missing spawn diagnostics, path traversal vulnerabilities, unbounded reads, and contract drift.
2. **Security & Governance** — apply the separation-of-duties rules from `AGENTS.md`. Ensure modifying agents remain isolated in worktrees and cannot self-approve or self-merge. Verify that external CLI actions fail closed without proper workstation trust. Treat comments and instruction text as authoritative context unless a caller explicitly opts into lossy/aggressive transformation.
3. **Verification** — run the exact commands CI runs:
   ```bash
   npm ci --ignore-scripts
   npm run typecheck
   npm test
   node packages/cli/dist/index.js validate .
   ```

## 3. MCP context

MCP configuration has three different surfaces and they must not be conflated:

- `config/mcp-catalog.yaml` is Code Conductor's policy-driven server catalog and profile selector.
- `.github/mcp.json` is the committed repository configuration used by compatible local Copilot CLI workflows. Keep it minimal; do not place every catalog server there.
- GitHub.com Copilot code review/cloud-agent MCP servers are configured in the repository's Copilot settings. GitHub's built-in GitHub MCP is already the GitHub-native path and should not be replaced with a custom token-minting workflow unless a documented, repository-specific requirement is approved.

The first-party context optimizer is an optional context-preparation service under Code Conductor policy. Its MCP transport is an experimental interoperability adapter; it is not a scheduler and is not auto-enabled for every Copilot session.

## 4. Report

Structure the review report as:

1. **Verdict** — One sentence: mergeable as-is, mergeable with nits, or blocking findings.
2. **Findings** — Rank by severity, cite exact `file:line`, provide the failure scenario, and offer a concrete remedy.
3. **Verification** — Commands run and outcomes recorded.
