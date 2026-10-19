---
name: github-actions-workflows-and-security
description: Author and audit GitHub Actions workflows, reusable workflows, composite actions, permissions, action pins, OIDC, expressions, runners, artifacts, caches, and supply-chain controls.
---

# Actions Workflows and Security

Read workflow YAML end to end. Check triggers and trust boundaries, permissions at workflow and job scope, fork behavior, `pull_request_target`, expression injection, untrusted checkout, secrets, environments, concurrency, matrix limits, job dependencies, outputs, artifacts, caches, runner labels, and timeout/cancellation behavior.

Pin third-party actions to full commit SHAs with version comments when policy requires it. Prefer OIDC with narrowly scoped cloud trust over long-lived cloud keys. Minimize `GITHUB_TOKEN`; grant `id-token: write` only to the job that needs it. Do not place untrusted PR text in shell or script source.

Prefer reusable workflows and composite actions with typed inputs and explicit secrets. Validate with actionlint, YAML parsing, local shell checks, and a dry-run or rendered plan where possible. Never dispatch, approve, rerun, cancel, or deploy a workflow without explicit authorization.
