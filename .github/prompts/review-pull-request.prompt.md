---
description: "Review a GitHub pull request, including Copilot-authored or Copilot-reviewed changes, for merge readiness"
agent: github-expert-engineer
---

# Review a GitHub pull request

## Inputs

Host (github.com or GHES), owner/repo, and the pull request number or base/head refs. Optional: acceptance criteria, the ruleset or branch protection that governs the base branch, and any Copilot, Codex or Claude review already left on the PR. The request is review-only unless the user explicitly authorizes edits, replies or other PR actions.

## Workflow

1. Orient with github-expert-orchestration: actor, base branch, whether the PR author or a reviewer is an AI agent, and whether anything beyond read-only inspection is authorized.
2. If the installer has made the pack's pre-review inventory available, run it; it reads local Git and `.github/` state without calling GitHub. Otherwise list it under skipped checks.
3. Apply github-pull-requests-and-code-review: collect base and head SHAs, merge base, changed files, commits, draft state, requested and completed reviews, CODEOWNERS coverage, unresolved review threads, check runs on the current head SHA, labels and mergeability with read-only `gh pr view --json`, `gh pr diff` and `gh pr checks`. Recheck status if new commits arrive during the review.
4. Apply github-branch-protection-and-rulesets to the base branch: compare required checks, approvals, code-owner review, conversation resolution and bypass actors with what the PR actually reports. A required check that never reports is a finding, not a reason to bypass.
5. When the Copilot cloud agent created the PR or Copilot left review comments, apply github-copilot-engineering: treat the generated diff as untrusted work, inspect workflow, dependency and permission changes in full, and list AI suggestions apart from confirmed findings. An AI review never counts as a human approval.
6. Check the draft report with the post-review report check when it is available (github-review-automation-and-hooks).

## Expected output

A review report with Scope, Evidence, Findings, Skipped checks and Recommendation. Each finding has id, severity, evidence (file and line, or API field), impact, remediation and verification. Advisory AI suggestions are listed separately. Recommend READY_FOR_MERGE_REVIEW only when no confirmed finding remains and every required gate is evidenced on the current head SHA; that recommendation hands the merge decision to a human and is never an approval. Do not post the review, approve, merge, push or resolve threads unless explicitly asked. Follow the `github-expert-engineer-contract` instruction.
