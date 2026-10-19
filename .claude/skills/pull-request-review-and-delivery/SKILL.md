---
name: pull-request-review-and-delivery
description: Review implementation diffs and pull requests for correctness, maintainability, security, tests, operations, and delivery readiness without silently merging or publishing.
---

# Pull Request Review and Delivery

Read repository contribution rules, target branch, changed files, linked requirements, CI, and deployment impact. Review behavior and failure paths rather than style alone. Check API compatibility, migrations, dependencies, secrets, authorization, logging, performance, cost, accessibility, rollback, and observability.

Prioritize findings by severity and evidence. Include file and line evidence when available, impact, remediation, and whether a check is static or executed. Treat Copilot, Codex, Claude, and model reviews as advisory; human ownership and required checks remain authoritative.

Do not approve, merge, push, dispatch, release, or publish without explicit authorization. End with `READY_FOR_REVIEW`, `CHANGES_REQUIRED`, `BLOCKED_ON_HUMAN_DECISION`, or `NOT_VERIFIED`.
