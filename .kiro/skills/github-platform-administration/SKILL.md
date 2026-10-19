---
name: github-platform-administration
description: Administer and assess GitHub enterprises, organizations, teams, repositories, policies, access, billing, and platform settings safely.
---

# GitHub Platform Administration

Assess the hierarchy: enterprise, organization, team, repository, environment, branch, and actor. Distinguish inherited policy from repository override and record plan, GHES version, licensing, and actor role when known.

Review organization members, teams, outside collaborators, repository roles, SSO/SAML, SCIM, IP allow lists, audit log, Actions policy, fork policy, repository creation, visibility, and Copilot policy. Prefer GitHub App installation tokens or fine-grained tokens with the narrowest permissions; never request a classic PAT by default.

Before a live change, produce a before-state, exact API/UI field changes, affected repositories and users, rollback, approval owner, and post-change read-back. Treat licensing, Copilot AI credits, public visibility, access grants, secret exposure, and enterprise policy changes as high impact. Do not change them without explicit authorization.

Useful evidence: organization settings export, repository metadata, team membership, audit events, policy documentation, and API permission headers. Mark inaccessible settings as NOT_VERIFIED rather than inferring them.
