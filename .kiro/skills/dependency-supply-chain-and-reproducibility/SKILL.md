---
name: dependency-supply-chain-and-reproducibility
description: Manage TypeScript and JavaScript dependencies for compatibility, provenance, reproducible builds, vulnerability response, and minimal supply-chain risk.
---

# Dependencies and Reproducibility

Inspect manifests, lockfiles, package manager, workspace boundaries, overrides, engines, registries, scripts, and CI installation mode. Preserve lockfile intent and verify package exports and peer dependencies before upgrading.

Prefer maintained, narrowly scoped, verified and pinned dependencies. Review lifecycle scripts, provenance, licenses, transitive impact, bundle impact, and advisories. Do not force major upgrades merely to remove a warning when compatibility evidence is absent.

Run the repository's install, type, lint, test, and build checks as appropriate. Record package versions, source registry, change rationale, migration notes, and rollback or pinning strategy. Never install an unverified executable or MCP server without approval.
