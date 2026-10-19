---
description: Audit a repository's GitHub security features and software supply-chain
  controls
---

# Audit GitHub security and supply-chain posture

## Inputs

Owner/repo or organization, the purpose of the audit (pre-release check, compliance evidence, or incident follow-up), and the actor's access to security features. If a secret may already be exposed, say so first: containment comes before the audit.

## Workflow

1. Orient with github-expert-orchestration and record which security endpoints the actor can read.
2. Apply github-security-and-supply-chain: inventory the security policy, CodeQL default or advanced setup and its language coverage, secret scanning and push protection, Dependabot alerts and version updates per ecosystem, dependency review, private vulnerability reporting, advisories, SBOM and artifact attestations. For each control decide whether it is enabled, configured, running and gating; a workflow file alone proves none of these.
3. Apply github-actions-workflows-and-security to action pinning and third-party workflow permissions.
4. Apply github-audit-evidence-and-compliance: keep an evidence ledger with source, timestamp, endpoint or ref, actor, result summary, sensitivity and verification level. Summarize alerts by count and severity; never copy alert payloads or secret values into the report.
5. For a suspected secret exposure, stop further propagation, identify the secret class and its owner, and hand rotation to that owner. Preserve the evidence without the value.

## Expected output

A completion report that lists each control as confirmed, inferred or not verified, ranks findings by exploitability, reachability, exposure and fix confidence, and states the next evidence request for anything the actor could not read. Recommend NOT_VERIFIED when the feature or alert state the decision depends on could not be read. Do not dismiss alerts, change security settings or rotate credentials without authorization. Follow the `github-expert-engineer-contract` instruction.