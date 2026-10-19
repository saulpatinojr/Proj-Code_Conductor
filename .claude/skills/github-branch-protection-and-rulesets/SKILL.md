---
name: github-branch-protection-and-rulesets
description: Analyze and design GitHub branch protection, rulesets, required checks, merge queues, bypasses, signed commits, and deployment gates.
---

# Branch Protection and Rulesets

Inventory all applicable rulesets and the legacy branch protection rule for the target ref. Rulesets layer and the most restrictive applicable setting wins; legacy protection has different matching behavior. Check active, disabled, and bypass actors separately.

Review pull request requirement, approvals, CODEOWNERS, stale approvals, last-push approval, status checks, unique job names, conversation resolution, signed commits, linear history, force-push/delete restrictions, merge queue, deployments, and bypass policy. A required check must match the actual workflow job name and event.

For a change, generate a policy diff, conflict analysis, impact matrix, required approvals, test plan, and read-back plan. Treat bypass grants and disabling enforcement as privileged mutations. Do not apply JSON/YAML to GitHub unless explicitly authorized.
