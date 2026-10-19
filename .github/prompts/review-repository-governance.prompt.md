---
description: "Assess organization and repository governance, or plan a ruleset, branch protection or settings change without applying it"
agent: github-expert-engineer
---

# Review repository governance or plan a governance change

## Inputs

Host, enterprise or organization, the repositories in scope (one, a list, or a selection rule), and the outcome wanted: an assessment, or a proposed change such as a new ruleset, a merge-method policy, a default-branch rename or a visibility change. Optional: the actor's role, the plan (Free, Team, Enterprise Cloud, or GHES and its version), and any approved change window.

## Workflow

1. Orient with github-expert-orchestration. Record which settings the actor can read, and mark the rest NOT_VERIFIED instead of inferring them.
2. Apply github-platform-administration to enterprise, organization, team, member, outside-collaborator, SSO, Actions and fork policy, separating inherited policy from repository overrides.
3. Apply github-repository-lifecycle-and-governance to README, CONTRIBUTING, SECURITY, LICENSE, templates, default branch, merge methods, topics and archive state, and github-documentation-and-repository-contracts to CODEOWNERS coverage of sensitive paths and to contradictions between governance files.
4. Apply github-branch-protection-and-rulesets: inventory organization and repository rulesets and legacy branch protection for each target ref, including disabled rulesets and bypass actors, and confirm that each required check matches a job that actually reports.
5. For a proposed change, produce the before-state, policy diff, conflict analysis, impact matrix across the repositories in scope, required approvals, rollout (evaluate mode first where the plan offers it), rollback and post-change read-back. Preview the exact API call and payload; do not send it.

## Expected output

For an assessment: a completion report with findings ranked by risk and the settings that could not be read. For a change: the same report plus the change plan, recommending BLOCKED_ON_HUMAN_DECISION until the named owner authorizes the exact change. Bypass grants, disabled enforcement, visibility, transfer, archive and default-branch changes are privileged. Follow the `github-expert-engineer-contract` instruction.
