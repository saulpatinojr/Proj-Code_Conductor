# ADR 0018 — Approve and deploy exact native APM artifacts

- **Status:** Accepted
- **Date:** 2026-10-28
- **Scope:** remaining #142 selection/install/update/removal workflow
- **Related:** ADR 0013, ADR 0015, ADR 0017; D-004, D-059, D-060, D-077

## Context

The owner approved the remaining optional APM lifecycle and PR creation/merge.
ADR 0017 provides an isolated selected-pack comparison, not installation authority.
The remaining workflow must preserve human instructions, show exact changes and
obtain a new action-bound decision before customer files change.

Official APM 0.33.0 source and disposable reproductions demonstrate that direct
native reinstall is insufficient protection: skill promotion recursively removes
a managed directory and copies it again, deleting an unowned `HUMAN.md` and
overwriting an annotation in `SKILL.md` without `--force`. Legacy stale files
without hashes can also be deleted. Native uninstall may already have removed
package materialization before a later conflict fails. Managed-directory status
does not confer ownership of every descendant.

Native install/uninstall round-trip manifest edits preserve comments/unknown
fields but can normalize formatting/CRLF. Native CI audit can rehydrate pinned
remote sources into scratch when `apm_modules` is absent; a disposable cold audit
passed all 31 checks with no drift, no customer package cache, and unchanged
project file hashes. These properties permit artifact deployment while APM keeps
resolution, manifest edits, lock generation, projections and audit ownership.

## Decision

This ADR amends D-060 only for an explicitly selected, trusted local Linux
APM management command. The extension may launch the bounded bundled terminal
workflow; customer-file changes additionally require D-059's live, single-use
digest-bound approval inside that terminal. Starting the command, selecting
packs, Workspace Trust, prior chat approval and audit success are not installation
approval. No provider, MCP, hook, paid API, sign-in, commit, push or PR permission
is conferred.

For the new management workflow only, it also supersedes ADR 0017/D-079's fixed
two-pack source restriction with validated on-demand canonical-catalog selection.
The existing two-pack preview remains restricted until the new path is implemented
and validated. Discovery yields an untrusted candidate, not reviewed provenance
or compatibility. A full commit proves immutability only. Require canonical catalog
membership/provenance, matching package/version/target metadata, native policy/
integrity checks, secret/executable/path screening and explicit exact-artifact
review/approval before materialization is accepted. Named runtime eligibility
additionally requires ADR 0019's approved team review, deterministic validation
and matching private acceptance receipt. Materialized files alone do not certify
a specialist or authorize native execution.

1. **Bounded supported inputs.** The owner's clarified **+** action discovers
   pack versions on demand from the canonical mirror's catalog. Validate catalog
   provenance and package/version metadata, then resolve each selected version
   to an immutable full commit; fetching metadata itself installs nothing. The
   original ADR 0017 two-pack fixture remains validation evidence, not a permanent
   two-pack product limit. Accept only the canonical source/distribution identity
   and validated native targets. No floating installation references or arbitrary
   URLs/registries. Every selection still requires its own native generation,
   path/content/ownership checks, preview and audit. Inspect actual manifest,
   policy, lock, own Markdown skills and complete relevant projection directory
   contents, including unowned descendants. Bound files/depth/bytes; reject
   symlinks, hard links, special files, unsafe metadata and unsupported local
   source/executable configurations. Existing unsupported inputs produce a
   remediation, never a partial guessed plan or silent policy rewrite.
2. **Native generation in staging only.** Copy verified relevant bytes into a
   private staging project outside the selected repository. Preserve existing
   metadata/comments through native APM install/uninstall operations. Retain
   ADR 0017's write isolation, hidden personal home, minimal child environment,
   `APM_NO_SCRIPTS=1`, non-interactive operation, executable default denial and
   `--no-trust-bin`; service dependencies/grants must remain absent. Local source
   is restricted to supported non-executable skills. Reject unexpected generated
   paths, dependencies, source pins or executable projections. Never call native
   install/reinstall/uninstall in the customer tree.
3. **Complete artifact comparison.** Derive exact before/after bytes/hashes for
   native manifest, native lock, policy/ignore metadata where generated, and every
   supported projected file. APM generates the lock; Code Conductor never edits
   its fields. Show additions/replacements/removals, source pins, targets and
   metadata changes. Native cache/scratch files are temporary and never deployed.
   Never treat directory ownership as file ownership. An existing projected file
   can change only when its prior native per-file hash matches and its ownership
   permits the change. Modified/unowned/shared-conflicting descendants block the
   plan, even if native APM removed them successfully in staging. Unchanged human
   files remain unchanged. Missing legacy ownership hashes cannot authorize
   deletion. Preserve source skill files and human annotations.
4. **Immutable review material.** Generate a native Git binary patch for every
   allowlisted compared file, including text files. A `--binary` flag alone
   still permits contextual text hunks; those are unsupported. Bind before/after
   presence, regular-file type, exact bytes and filesystem mode. Reject symlink,
   gitlink, executable, rename/copy and other unsupported patch directives. Replay
   the patch against an independent approved preimage and require exact path,
   byte and mode correspondence before deployment. Only native binary literal or
   delta blocks are supported; delta compression must not be mistaken for a text
   hunk or a permission to accept another preimage. At apply time native binary
   preimage checks must reject a changed file even outside former hunk context.
   Store private before/after evidence and the patch digest. The terminal presents
   the exact changed files and content, not just package counts or a dry-run
   summary. Empty/no-change plans are visibly idempotent and apply nothing.
5. **Fresh action approval.** Reuse the existing ApprovalGate/TerminalApprover,
   including confirmation code, TTL, denial/non-interactive refusal, context
   rebuild and single-use records. Bind repository canonical identity, Git
   revision (or explicitly named unborn/unversioned state), exact input/current-file
   snapshot including absence/types/modes, desired pack/target set, metadata
   and patch digests, native executable paths/hashes and exact operation plan.
   Re-read immediately after the decision; changed or unavailable context refuses
   the write. Stored approval artifacts never authorize another operation.
6. **Isolate Git configuration and attributes.** Ordinary `git apply --check` and
   `git apply` can invoke clean/smudge/process filters from repository configuration
   and `.gitattributes`, and transform EOL/encoding even without `--index`. Hooks
   suppression does not stop this. Both generation and application must use private
   scratch Git metadata and an empty template. Disable inherited/system/global Git
   configuration/attributes. Use only
   controlled scratch attributes that force literal binary diffs and disable filter,
   text, ident and working-tree-encoding transformations, with autocrlf disabled.
   Use an isolated SHA-256 object format so binary preimage checks are not SHA-1
   dependent. The selected repository's Git configuration, index, attributes,
   hooks and objects must not govern patch conversion. Generation uses an explicit
   private empty-tree attribute source. Native Git 2.52 testing found that applying
   with that option and SHA-256 metadata crashes; apply/check instead use highest-
   priority controlled private `info/attributes`, with every conversion attribute
   neutralized. Probe and test the actual native capabilities; fail if unsupported,
   never retry in an unsafe configuration. Never change customer attributes/config
   to achieve isolation.
7. **Apply reviewed files through native Git.** Use bounded shell-free native
   patch checking/application in that isolated Git context with no hooks,
   fsmonitor, replace refs, external diff, textconv, forced overwrite, whitespace
   fixing, three-way/reject behavior or unsafe paths. Keep host writes restricted
   to the selected repository and private action scratch; protect Git metadata
   read-only. The patch contains only approved artifact files, never customer
   credentials, Git controls, package caches, arbitrary source or a recursive
   directory deletion. Preserve existing non-executable file permissions; new
   artifacts default owner-private. Git mode `100644` identifies regular/non-
   executable files, not exact POSIX permission bits: those are separately bound
   and checked. Any permission application must be restricted
   to the same approved regular files and verified afterward. No Git init, commits
   or staging of the person's index are performed in the customer repository.
8. **Deployment-correlated audit.** Re-read the actual deployed files and require
   exact agreement with approved hashes. Run bounded native CI audit against the
   deployed repository in a read-only project/write-isolated scratch boundary;
   cold source replay may use the public pinned mirror. Bind the audit outcome
   and output digest to the actual manifest/lock/file hashes, then recheck those
   hashes. Report success only for matching deployment plus passing audit. Audit
   is package evidence, never runtime readiness or authorization.
9. **Honest interruption/recovery.** Preserve phase, bounded output, timeout/
   cancellation and before/after evidence. Failed patch/audit or changed post-state
   must never report installed/verified. No automatic retry, hard reset or rollback
   can overwrite later human edits. Expose the reviewable native Git diff and
   retained private before-state for recovery. Every later repair/removal is a new
   preview and approval; preserve unrelated user/index state.

## Consequences

The first supported host is local Linux with descriptor-bound reads, bubblewrap
and existing Git/APM 0.33.0. Git must support private SHA-256 objects, binary
preimage checks and the validated configuration/attribute isolation; native
feature probes establish support. Unsupported
hosts, namespace policy or input formats
fail explicitly. Basic Code Conductor use remains independent of APM. No tool is
installed automatically and no personal subscription is used for deterministic
validation. This does not make the filesystem sandbox confidential-read or
network isolation and does not authorize arbitrary malicious packages. Credential-looking
metadata/projection content must fail closed before staging/disclosure/display;
path allowlists alone do not establish safe content. No credential values appear
in public reports or unredacted terminal diagnostics.

APM generation is reproducible input to a constrained artifact deployment, not a
second resolver or custom lock format. Cold native audit may require network;
offline/unavailable audit leaves current verification unknown/failing. Metadata
round-trip formatting changes must be visible in the approved diff. Conservative
conflict handling can require a person to resolve instructions manually.

Native Git patch application plus pre/post snapshots is not a promise of a
multi-file filesystem transaction. A crash or I/O error can require inspection;
the workflow must preserve evidence and refuse a success claim rather than
silently restoring files a person may have edited meanwhile. Recovery guidance
is required before this is described as a complete user-facing lifecycle.

## Validation

Independent disposable Git 2.52 fixtures established private SHA-256 binary patch
generation/application with no malicious clean/smudge sentinel invocation, exact
LF/CRLF/ident/declared-encoding bytes, and stale full-preimage rejection for both
replacement and deletion. Both literal and native delta records were reproduced.
Applying with `--attr-source` crashed, so that apply configuration is excluded;
controlled private attribute overrides worked. These findings validate the design
choice, not an implemented customer deployment workflow. Four native symlink
fixtures (final/intermediate, inside/outside target root, matching preimage)
were refused by check/apply without changing sentinel files.

Six-target native generation with both reviewed packs and three own Markdown
skills passed all 31 audit checks with no drift or symlinks. It produced 235
projections plus four metadata files: `.agents/skills` Markdown; Claude agents,
commands, rules and skills Markdown; Codex agent TOML; GitHub agents,
instructions and prompts Markdown; Kiro agents, skills and steering Markdown.
The implementation must validate each exact native path/extension and retain
warnings: native generation dropped unsupported Claude command `agent`
frontmatter, so audit success is not proof of perfect cross-client semantics.

Independent architecture/security review challenged file ownership, Git path
handling, executable/secret boundaries, approval binding, cold audit and
interruption claims against official sources. No architecture blockers remained
after the configuration/filter, preimage, mode and identity corrections above.
Acceptance establishes the design, not implemented deployment or release evidence.
Implementation tests must cover fresh unrelated repositories, selected targets,
native provenance/lock generation, same-version idempotence, version change,
removal, shared/unowned/modified descendants, unsupported/missing hashes,
symlinks/hard links/escapes, file modes/types/absence, unborn/unversioned roots,
secret-shaped content, malicious filter sentinels, EOL/encoding transforms, stale
binary preimages outside former textual hunk context, denied/missing/expired/changed approval, time/output
limits, cancellation, patch failure, audit failure and post-deployment tampering.

Run real official pinned-APM fixture scenarios and a packaged VSIX terminal flow
on a supported host. Correlate before/after file hashes, exact patch, approval and
audit in the report. Required GitHub checks and independent code review remain
mandatory; no acceptance criterion is satisfied by an ADR alone.

Official pinned sources:

- [Native skill promotion](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/integration/skill_integrator.py)
- [Cleanup ownership](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/integration/cleanup.py)
- [Manifest install edits](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/install/manifest_helpers.py)
- [Uninstall flow](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/commands/uninstall/cli.py)
- [Round-trip YAML](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/utils/yaml_io.py)
- [Cold CI audit replay](https://github.com/microsoft/apm/blob/v0.33.0/src/apm_cli/install/audit_replay.py)
- [Git apply](https://git-scm.com/docs/git-apply)
