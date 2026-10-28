# Architecture Decision Records

ADRs record decisions that materially change Code Conductor's architecture, security boundaries, authentication/billing behavior, provider/harness contracts, or a `LOCKED` entry in `docs/DECISIONS.md`.

## Naming

Use sequential names:

```text
NNNN-short-kebab-case-title.md
```

Example: `0007-provider-capability-discovery.md`.

## Required sections

Each ADR should include:

1. **Status** — Proposed, Accepted, Superseded, or Rejected.
2. **Date** — decision date.
3. **Context** — problem, constraints, and evidence.
4. **Decision** — the chosen change in concrete terms.
5. **Consequences** — positive, negative, migration, compatibility, and security impacts.
6. **Validation** — tests, official documentation, runtime evidence, or experiments supporting the decision.
7. **Supersedes / Superseded by** — when applicable.

## Change rule

An accepted ADR that changes a locked baseline must update `docs/DECISIONS.md` in the same PR. Also update `AGENTS.md`, configuration, tests, `STARTER.md`, or implementation docs when they become inaccurate.

Do not use an ADR to justify bypassing a failing deterministic gate. Fix the problem or explicitly redesign the gate with evidence.

- [ADR 0017 — Write-isolated selected-pack projection previews](0017-write-isolated-pack-projection-preview.md)
- [ADR 0018 — Approve and deploy exact native APM artifacts](0018-approved-apm-artifact-deployment.md) — proposed.
