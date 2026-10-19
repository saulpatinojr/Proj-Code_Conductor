---
description: Author or harden a GitHub Actions workflow for least privilege, pinned
  actions, OIDC and safe triggers
---

# Harden a GitHub Actions workflow

## Inputs

Owner/repo, the workflow files in scope, and the goal: a new workflow, a security audit, or a move from long-lived cloud keys to OIDC. Optional: the organization's action-pinning policy, the cloud provider and the owner of the cloud role, and the deployment environments the workflow uses.

## Workflow

1. Orient with github-expert-orchestration and record the repository's default workflow token permission if the actor can read it.
2. Apply github-actions-workflows-and-security: read each workflow end to end and check triggers and trust boundaries, `pull_request_target` with untrusted checkout, expression injection from event fields, workflow and job permissions, secrets, concurrency, timeouts, runners, artifacts and caches. Pin third-party actions to full commit SHAs with a version comment, move untrusted values into environment variables, set workflow-level `permissions` to the minimum, and grant `id-token: write` only to the job that exchanges the OIDC token.
3. When a job deploys, apply github-ci-cd-and-deployment-environments: bind it to a protected environment, add a concurrency group that does not cancel an in-flight deployment, and separate build from deploy so the same artifact is promoted.
4. Apply github-security-and-supply-chain to third-party action trust and to any dependency, SBOM or attestation step the workflow adds.
5. Validate locally with YAML parsing and actionlint where available. The cloud trust policy that accepts the OIDC subject belongs to the cloud identity owner: hand over the exact subject and audience claims instead of changing it.

## Expected output

A local workflow diff, a finding for each risk found (id, severity, evidence, impact, remediation, verification), the validation commands actually run with their results, and a handoff for every change outside the repository, such as a cloud role trust policy or the removal of old secrets. Never dispatch, rerun or deploy the workflow, and never delete repository secrets, without explicit authorization. Follow the `github-expert-engineer-contract` instruction.