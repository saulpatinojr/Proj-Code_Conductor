---
name: github-ci-cd-and-deployment-environments
description: Design and review GitHub CI/CD pipelines, environments, approvals, concurrency, deployment protection, release promotion, and rollback boundaries.
---

# CI/CD and Deployment Environments

Separate CI validation, artifact creation, promotion, and deployment. Map each workflow job to an environment, permissions, inputs, artifact digest, required reviewers, branch policy, concurrency group, and rollback action.

Review environment secrets and variables, branch restrictions, required reviewers, custom deployment protection rules, wait timers, self-review prevention, concurrency, cancel behavior, immutable artifacts, provenance, and deployment records. Do not assume a YAML `environment` block proves the environment is protected; verify live settings when authorized.

For infrastructure, separate plan from apply and protect stateful operations with approval and concurrency. For GitOps, publish the desired commit and let the deployment controller reconcile. Do not use long-lived kubeconfig or cloud keys where OIDC or workload identity is available.
