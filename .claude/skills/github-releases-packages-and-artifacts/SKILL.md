---
name: github-releases-packages-and-artifacts
description: Design and audit GitHub releases, tags, packages, artifacts, provenance, retention, immutability, promotion, and rollback workflows.
---

# Releases, Packages, and Artifacts

Trace source commit to build run, artifact digest, attestation, package version, tag, release, and deployment. Check tag protection, signed tags or commits, immutable references, package visibility, permissions, retention, deletion policy, and rollback availability.

Prefer immutable artifact digests and promotion of the same artifact between environments. Review whether release automation can be triggered from untrusted branches or tags, whether credentials are scoped, and whether prerelease versus stable channels are explicit.

Do not create, publish, delete, retag, overwrite, or promote releases, packages, tags, or artifacts without authorization. A successful build does not prove release provenance or deployment success.
