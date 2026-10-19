---
description: Trace a release from commit to deployment and assess whether it is ready
  to promote
---

# Assess release and deployment readiness

## Inputs

Owner/repo, the release, tag, version or commit to assess, the target environment, and the artifact type (container image, package or binary). Optional: the release workflow, the deployment controller, and the expected rollback target.

## Workflow

1. Orient with github-expert-orchestration.
2. Apply github-releases-packages-and-artifacts: trace the source commit to its build run, artifact digest, attestation, package version, tag and release. Verify attestations with `gh attestation verify` where available, and check tag protection, immutability, package visibility and retention.
3. Apply github-ci-cd-and-deployment-environments: map each deploy job to its environment, required reviewers, branch and tag policy, wait timer, concurrency and secrets, and confirm that production receives the same digest staging received. Read live environment settings when authorized; a YAML `environment` key does not prove the environment is protected.
4. Apply github-audit-evidence-and-compliance: record each link of the chain in the evidence ledger with its verification level, and name the rollback target and its owner.

## Expected output

A completion report with the provenance chain, environment protection state, findings, rollback path, and the evidence still missing. A successful build is not provenance, and a green run is not a successful deployment. Do not create, publish, retag, promote or deploy anything; the promotion decision stays with the release owner. Follow the `github-expert-engineer-contract` instruction.