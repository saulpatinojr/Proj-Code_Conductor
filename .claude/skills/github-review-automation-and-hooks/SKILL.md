---
name: github-review-automation-and-hooks
description: Run and design safe pre-review and post-review automation, deterministic inventory, finding validation, mutation guards, and GitHub review handoff tools.
---

# Review Automation and Hooks

Use the pre-hook to inventory Git state, `.github` files, workflows, Copilot instructions, CODEOWNERS, security configuration, and available local tools. The hook must not call a live mutation and should make live reads opt-in.

Use the post-hook to validate the report contract: stable findings, severity, evidence, remediation, recommendation, skipped checks, and redaction. Reject reports with tokens, secret-like values, duplicate IDs, or no explicit limitations.

Use `tools/query_guard.py` before any `gh`, git, REST, GraphQL, or MCP command. It should block known mutations by default and require an explicit human-approved override. Keep scripts idempotent, bounded, auditable, and safe when the repository contains hostile filenames or content.
