# ADR 0011 — Code Workflow sibling boundary, shared result contract, and provider-native inventory

- **Status:** Accepted
- **Date:** 2026-10-08
- **Decided by:** repository owner (explicit direction: Code Conductor is the full program; Code Workflow is the slimmer product)
- **Related:** ADR 0003, ADR 0009, D-041, D-051, D-055, W-003, issue #13
- **Sibling repository:** [`saulpatinojr/Proj-Code_Workflow`](https://github.com/saulpatinojr/Proj-Code_Workflow)

## Context

The owner maintains two orchestration products that overlap in purpose but not in architecture:

- **Code Conductor** (this repository) orchestrates *across* providers from outside them: it spawns official clients as processes or ACP sessions, isolates modifying work in worktrees, enforces risk classes, independence, deterministic gates, and human approval, and keeps run evidence in the owner-private run store.
- **Code Workflow** orchestrates *inside one* AI client (Claude Code, Codex CLI, or GitHub Copilot) using that client's native subagents, with a one-script install, a Python workflow controller, a repository-local `.agentic/` evidence directory, and no background runtime.

Without an explicit boundary the two drift toward each other: Code Workflow is tempted to spawn other providers (rebuilding Code Conductor badly), and Code Conductor is tempted to grow a second, incompatible evidence vocabulary. A review of both codebases on 2026-10-08 also found three Code Conductor gaps that Code Workflow already handled:

1. `AgentResult` had no way to state what an agent explicitly **did not verify**, so a "completed" result could not honestly carry live-deployment or external-auth caveats.
2. `Evidence.sha256` existed in the contract but was never populated, including for deterministic gate output whose summary is truncated at 8,000 characters.
3. No command showed which **provider-native agents and skills** are installed (W-003), and nothing distinguished APM-deployed projections from hand-placed files.

## Decision

1. **Product boundary.**
   - Code Conductor owns cross-provider scheduling, routing, risk classes, independence, worktrees, authority, deterministic gates, merge readiness, and human-approval gates.
   - Code Workflow stays inside one client. It never spawns another provider's CLI, never manages worktrees, and never issues merge or readiness decisions.
   - Neither product depends on the other at runtime.
2. **Shared contract.** `AgentResult` (packages/schemas) is the shared result vocabulary. Code Workflow's `export` command projects its handoffs into a `RunManifest`-compatible document, so work started in Code Workflow can be inspected or continued by Code Conductor. Code Workflow never sets `mergeDecision` and never recommends `ready`.
3. **`notVerified`.** `AgentResult` gains an optional `notVerified: string[]`. Agents are instructed to populate it. The parser preserves it, and contract validation fails closed when it is malformed.
4. **Gate evidence integrity.** Deterministic gate evidence records `sha256` over the full, untruncated combined output.
5. **Provider-native inventory.** `cc agents` and a `cc doctor` summary list provider-native agents and skills across Claude, Copilot, Codex, Kiro, and Agent Skills locations, at project and user scope.
   - Inventory is read-only: it never installs, rewrites, or deletes files, and never follows symlinks.
   - Project files are marked `apm` or `unmanaged` against `apm.lock.yaml` `local_deployed_files`. This marking is informational; `apm audit` remains the policy authority.

## Consequences

- The owner can position each product honestly. Code Workflow is the fast on-ramp; Code Conductor is where governed multi-provider work moves.
- The optional field keeps `AgentResult` backward compatible: existing producers remain valid.
- The `code-conductor-protocol` skill was updated in `.apm/` and re-materialized with the pinned APM 0.30.0 CLI per ADR 0003. `apm audit --ci` passes with no drift.
- The inventory currently reports `.github/skills/code-review/SKILL.md` as not recorded in the APM lock. It is a deliberate repository-specific Copilot review skill outside APM source. AGENTS.md §10 prefers APM-projected sources, so whether it moves into `.apm/` is an open owner decision; APM's own audit does not flag it.
- Code Workflow's contract fixture is a snapshot. When `contracts.schema.json` changes, the sibling repository must refresh its fixture.

## Validation

- TypeScript build and the full Vitest suite pass, including new coverage for inventory discovery, lock-based managed/unmanaged marking, symlink non-traversal, `notVerified` preservation and fail-closed validation, and gate evidence hashing.
- `cc doctor` and `cc agents` were exercised against this repository.
- `apm install` (APM 0.30.0) re-materialized the edited skill deterministically, and `apm audit --ci --policy ./apm-policy.yml --no-fail-fast` passed all 31 checks.
