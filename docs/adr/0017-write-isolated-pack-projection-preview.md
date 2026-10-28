# ADR 0017 — Write-isolated selected-pack projection previews

- **Status:** Accepted
- **Date:** 2026-10-28
- **Scope:** #142; selected public Agent Packs, Codex projections only
- **Related:** ADR 0013, ADR 0015; D-004, D-059, D-060, D-077

## Requirement and evidence

The approved APM workflow needs exact generated-file comparisons before any
installation approval. APM 0.33.0 `install --dry-run` reports package plans but
explicitly omits per-package stale-file cleanup. It cannot establish an exact
projection diff. Actual materialization is required, outside the customer tree.

Source inspection of the pinned official release established additional effects:
`--no-trust-bin` suppresses bin deployment, not lifecycle scripts;
`APM_HOME` does not redirect `~/.apm/config.json`; and audit refuses a scratch
directory inside its project. A temporary project alone is insufficient write
isolation. This ADR adds an optional bounded preview, not a replacement resolver.

## Decision

This ADR narrowly supersedes D-060's extension process allowlist for the approved
APM workflow: in addition to native read-only next/handoff, the extension may
start the bounded `ccon apm-audit` and `ccon apm-preview` commands on explicit user
request in a trusted selected repository. Preview additionally requires the local
Linux sandbox below. These commands grant no mutating install, arbitrary-command,
provider, authentication, PR, commit or deployment capability. All other native
ownership and approval constraints in D-060/D-059 remain in force.

1. Preview is explicit, optional and initially trusted local Linux only. It
   requires existing APM 0.33.0 and bubblewrap on absolute PATH entries. The
   extension invokes the bundled CLI as a native process task only after pack
   selection; activation/discovery never starts a preview or download.
2. Restrict input to the two currently reviewed TypeScript/GitHub engineer pack
   paths at mirror commit `16f41836d65cbf79070ecdb2ef835c78c57b6ae6`.
   No arbitrary URL, branch, lifecycle configuration or local `.apm/` content is
   copied into staging. APM remains the source of resolution, projections and lock.
3. Bubblewrap mounts the host filesystem read-only, hides the caller's home in a
   temporary filesystem, and binds only a private Code Conductor scratch directory
   writable. Process-group isolation, time/output limits and cleanup apply.
   The caller's home environment selector is preserved, never reassigned. An APM
   binary beneath the hidden home may be unavailable; refuse rather than copying
   an interpreter or running without isolation.
4. Child environment contains absolute PATH, inherited proxy/CA configuration
   and explicit native safety settings, without provider/Git/loader credentials.
   Set `APM_NO_SCRIPTS=1`, `APM_NON_INTERACTIVE=1`, synthesized
   `executables: {allow: {}}`, and native `install --only apm --no-trust-bin
   --target codex`. Disable ambient system/global Git configuration and prompts.
   Audit runs inside the same write boundary with scratch outside the project.
5. Accept only expected metadata, the package cache, recorded `.codex/agents`
   TOML and `.agents/skills` Markdown output. Refuse hooks, symlinks, unexpected
   dependencies, unsupported YAML and unrecorded output. Bound traversal, files,
   individual reads and aggregate reads. Descriptor-bound reads verify hashes.
6. Compare exact before/after bytes and SHA-256 hashes. Identify additions,
   replacements, unchanged files and selected-pack removal candidates. Block
   modified/unmanaged/shared instructions and unsafe locations. Preserve paths
   still claimed by another dependency or local primitive. Other target
   projections are outside this comparison, never implied removals.
7. Bind the selected repository, reviewed sources, staged/previous lock digests,
   file comparison and actual staged audit digest into the output digest.
   A comparison helper cannot claim an audit occurred. Terminal JSON escapes
   controls and formatting characters without changing decoded values.

## Authority and limits

The result is explicitly `selected-pack-projections-only`. It is not a complete
native installation diff: merging customer manifest/policy/local source, lock,
`.gitignore`, all selected targets and deployment ownership is a subsequent
reviewed boundary. No file is installed or removed in the selected repository.
The digest is evidence, never reusable installation approval. Staged audit is
not audit of a customer deployment and does not authorize any provider or MCP.

The sandbox provides host write isolation, not confidential-read isolation or
support for arbitrary malicious packages. Trusted native APM still processes a
fixed reviewed public catalog and uses public-network access. Read-only host
files remain visible outside the hidden home; writable home/proc/dev mounts are
ephemeral. Do not describe this as a network sandbox. On unsupported hosts or
namespace/configuration failure, fail explicitly; no unsafe fallback or automatic
prerequisite installation is permitted.

## Quality gates

Independent critical source/code review checks native flag semantics, authority,
file ownership and sandbox assumptions. Deterministic tests cover exact bytes,
hash mismatch, edits/deletions, shared ownership, symlink/hard-link rejection,
unsupported metadata, incomplete process outcomes, cleanup and VS Code
trust/repository changes across selection. A real pinned-APM scratch run must
pass staged audit and compare against known repository projections. Required
GitHub gates apply. Desktop acceptance and the installation lifecycle remain open.

Official sources (version-pinned):

- [Dry-run behavior](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/commands/install.py)
- [Lifecycle suppression](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/core/lifecycle_scripts.py)
- [Executable default denial](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/security/executables.py)
- [User configuration](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/config.py)
- [MCP install mode](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/install/service_integration.py)
- [Bubblewrap](https://github.com/containers/bubblewrap)
