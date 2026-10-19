---
description: "Plan or assess a GitHub migration, backup, restore or disaster-recovery exercise"
agent: github-expert-engineer
---

# Plan a GitHub migration or recovery

## Inputs

Source and destination host (github.com, GHE.com, or GHES and its version), the enterprise, organization or repositories in scope, the data classes that must move, and constraints such as the freeze window and the recovery point and recovery time objectives. Optional: the migration tool already chosen.

## Workflow

1. Orient with github-expert-orchestration.
2. Apply github-migrations-backups-and-recovery: inventory branches, tags, issues, discussions, PRs, Projects, releases, packages, Actions history, secrets, variables, environments, rulesets, webhooks, Apps, LFS, submodules and external integrations, and mark which migrate, which convert lossily and which must be recreated. Separate export, transform, import, verification, cutover, freeze and rollback, and plan a representative restore into an isolated destination.
3. Apply github-branch-protection-and-rulesets and github-security-and-supply-chain to the post-migration checks: rulesets, branch protection and security features are read back on the destination, never assumed.
4. Apply github-audit-evidence-and-compliance to record what was inventoried and how each check will be verified.
5. Plan secrets as a separate re-issuance with their owners; never copy secret values into backups or migration artifacts.

## Expected output

A completion report with the scope inventory, phase plan, lossy-conversion register, restore test, post-migration verification list, rollback, and owners. An assessment never deletes or overwrites the source, rotates credentials, or cuts over traffic. Follow the `github-expert-engineer-contract` instruction.
