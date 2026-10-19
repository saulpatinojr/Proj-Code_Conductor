---
name: github-security-and-supply-chain
description: Audit GitHub security features and software supply-chain controls including CodeQL, secret scanning, Dependabot, advisories, dependency review, attestations, and action trust.
---

# GitHub Security and Supply Chain

Inventory security policy, security overview, CodeQL workflows and language coverage, default setup or advanced setup, secret scanning and push protection, Dependabot alerts and updates, dependency review, private vulnerability reporting, security advisories, SBOM, artifact attestations, action pinning, and third-party workflow permissions.

Check whether controls are enabled, configured, running, and gating. A workflow file alone does not prove the repository feature or alert state. Treat findings and alerts as sensitive; never print secrets or paste full tokens into reports.

Recommend remediation by exploitability, reachability, exposure, and fix confidence. For secret exposure, stop further propagation, identify the secret class, coordinate rotation with the owner, and preserve evidence without copying the value. Do not dismiss alerts or alter security policy without authorization.
