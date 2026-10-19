# Code Conductor documentation

This directory contains the maintained design, operating, and validation documentation for Code Conductor.

## Start here

- [`../README.md`](../README.md) — project overview and quick start.
- [`../AGENTS.md`](../AGENTS.md) — repository constitution for human and AI contributors.
- [`../STARTER.md`](../STARTER.md) — concise continuity handoff for a new work session.
- [`STATUS.md`](STATUS.md) — current implementation checkpoint and next milestone.
- [`DECISIONS.md`](DECISIONS.md) — durable register of locked decisions and validation facts.

## Architecture and implementation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system boundaries, layers, team model, and source-of-truth architecture.
- [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) — v0.1 release plan and phased implementation scope.
- [`UI.md`](UI.md) — VS Code cockpit scope and deliberate non-features.

## Operations and integrations

- [`BOOTSTRAP.md`](BOOTSTRAP.md) — repository/workstation bootstrap sequence.
- [`WORKSTATION-VALIDATION.md`](WORKSTATION-VALIDATION.md) — official-client authentication and harness smoke validation.
- [`AUTHENTICATION.md`](AUTHENTICATION.md) — authentication, credential, and subscription/API billing boundaries.
- [`APPROVALS.md`](APPROVALS.md) — pre-action approvals bound to the exact recipient, revision, content and diff.
- [`NATIVE-INTERFACES.md`](NATIVE-INTERFACES.md) — next actions, native Source Control/GitHub/sign-in hand-offs and manual fallback.
- [`GITHUB.md`](GITHUB.md) — read-only pull-request gate (`ccon github-gate`) and approval-gated draft pull requests (`ccon pr`).
- [`HANDOFFS.md`](HANDOFFS.md) — versioned handoff packets between assignments and local evidence retention.
- [`WORKTREES.md`](WORKTREES.md) — agent worktree isolation, commit safeguards, retention/cleanup and provider environment.
- [`GATE-PROFILES.md`](GATE-PROFILES.md) — deterministic gate profiles, prerequisites, bounded execution and the validate/plan/apply boundary.
- [`INSTALL.md`](INSTALL.md) — installing the VS Code extension, prerequisites, compatibility, updates, running `ccon` from it, and uninstalling.
- [`RELEASE.md`](RELEASE.md) — tagged releases: tests, SBOM, signed provenance, draft release, verification, versions, rollback and Marketplace setup.
- [`MARKETPLACE-PUBLISHING.md`](MARKETPLACE-PUBLISHING.md) — the owner's step-by-step Marketplace setup: publisher, Entra ID application and federated credential, environment secrets, the publish switch.
- [`PACKAGED-DEFAULTS.md`](PACKAGED-DEFAULTS.md) — packaged configuration defaults and bounded user/workspace preferences.
- [`MCP-CATALOG.md`](MCP-CATALOG.md) — approved MCP/reference strategy and tool-plane rules.
- [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md) — branch, PR, required-check, and repository-setting baseline.

## Decisions

- [`adr/`](adr/) — architecture decision records. ADRs are required when a change supersedes a locked decision or alters a major system/security boundary.
- [`adr/README.md`](adr/README.md) — ADR format and lifecycle.

## Repository governance

Repository-wide contributor/review documentation lives at the root or under `.github/`:

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`../REVIEW.md`](../REVIEW.md)
- [`../SECURITY.md`](../SECURITY.md)
- [`../CHANGELOG.md`](../CHANGELOG.md)
- [`../.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)

## Documentation ownership

Avoid duplicating authoritative content. When possible, update the authoritative document and link to it elsewhere. `STATUS.md` is the living checkpoint; `DECISIONS.md` is the durable decision record; `AGENTS.md` is the operating constitution.
