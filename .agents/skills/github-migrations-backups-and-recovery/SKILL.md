---
name: github-migrations-backups-and-recovery
description: Plan and assess GitHub repository, organization, issue, branch, release, package, Actions, and governance migrations, backup, restore, and disaster recovery.
---

# Migrations, Backups, and Recovery

Define source and destination host, enterprise/org/repo scope, data classes, identities, permissions, branches, tags, issues, discussions, PRs, projects, releases, packages, Actions history, secrets, variables, environments, rulesets, webhooks, Apps, LFS, submodules, and external integrations.

Separate export, transform, import, verification, cutover, freeze, and rollback. Test representative restores in an isolated destination. Preserve IDs and links where possible, record lossy conversions, and validate branch protection and security controls after migration.

Never delete or overwrite the source, rotate credentials, or cut over traffic as part of an assessment. Secrets require a separate re-issuance plan; do not copy secret values into backups or migration artifacts.
