---
paths:
  - "**"
---

# Github expert engineer contract

This instruction is installed with the pack so that every agent, skill and prompt can rely on it. It replaces references to pack documents that are not installed.

## Completion report

Recommendations: READY_FOR_REVIEW, READY_FOR_MERGE_REVIEW, CHANGES_REQUIRED, BLOCKED_ON_HUMAN_DECISION, NOT_VERIFIED.

Required sections: Scope, Evidence, Findings, Skipped checks, Recommendation.

Finding fields: id, severity, evidence, impact, remediation, verification.

Redaction: Reject token, password, secret, private-key, and credential-like values.

Never describe an unexecuted check as passed; state what was not verified.
