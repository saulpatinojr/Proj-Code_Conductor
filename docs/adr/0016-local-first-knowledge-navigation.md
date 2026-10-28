# ADR 0016 — Optional local knowledge is navigation, not execution authority

- **Status:** Accepted (merged in PR #146)
- **Date:** 2026-10-28
- **Scope:** owner-approved local-first Obsidian workstream, issue #141
- **Related:** ADR 0007, ADR 0013, ADR 0015; D-059, D-060, D-063, D-072

## Context

Code Conductor already stores private run evidence and uses Git/GitHub, approved
ADRs and APM as domain authorities. The approved knowledge workstream connects
long-lived project notes without making their claims execution policy. There is
no current vault integration. Issue #137 describes a separate cloud-sync design;
this ADR does not activate cloud resources, identity brokers or synchronization.

## Decision

1. Knowledge integration is optional and local-first. Base planning, execution,
   package management and readiness work without Obsidian or a vault connection.
   No scan, provider process, network request or note write occurs at activation.
2. A person explicitly selects an existing local vault and a contained folder for
   one selected repository. Store only these non-secret connection paths in VS
   Code workspace state. Do not discover vaults or crawl drives automatically.
   A multi-root workspace keeps each connection bound to its repository.
3. The first slice is a read-only, bounded index of Markdown metadata and links.
   Index only allowlisted folders and repository mappings. Reject symlinks,
   canonical path escapes, sensitive paths, non-regular files, malformed metadata
   and credential-shaped content. Bound traversal count, depth, bytes per file
   and total bytes, with explicit limit diagnostics. Never index the private
   run store, Git control files or credential directories as a vault.
4. Notes and relationships are claims, not instructions. Nodes have typed kinds
   (`project`, `repository`, `decision`, `issue`, `pr`, `agent`, `skill`, `pack`,
   `task`, `run`, `evidence`, `lesson`); edges are `depends_on`, `uses`,
   `implements`, `decided_by`, `validated_by` or `related_to`. Parse an explicit
   versioned frontmatter schema. Do not infer verified relations from prose.
5. Every relationship carries a source identity, optional source revision/hash,
   and a last-observed timestamp. A matching local source hash may be labeled
   locally matched. Changed or missing sources are stale/broken. A note's own
   last-verified claim is never a fresh external verification. Remote issue/PR
   references remain unverified until an explicit official-client lookup; they
   cannot assert merge, CI, provider trust, approval or readiness.
6. Run associations contain only repository-bound run/evidence identifiers. Never
   copy prompts, private output, secrets or full manifests into a vault. Opening
   a related note grants no right to disclose it to a provider. D-059 continues
   to bind any later context disclosure to its exact content and recipient.
7. Navigation uses only fixed native operations: open a validated local note in
   the editor, or `obsidian://open?path=<encoded-absolute-note-path>`. No note-
   supplied executable URI, callback, append, overwrite, clipboard or new-note
   action is accepted. Confirm existence/scope again at click time. If Obsidian
   is unavailable, offer the native editor without installing anything.
8. Indexes are disposable in-memory state. Refresh is explicit and bounded;
   disconnect forgets connection/index state and deletes no notes. Renames and
   changed sources invalidate mappings on the next index or click-time check.
   No embedding service, background sync, hosted database, telemetry or plugin
   is required. Notes never change runtime gates or package locks.
9. Later note generation/update needs a separate reviewed slice: exact Markdown
   preview, source provenance, conflict handling, digest-bound confirmation and
   atomic no-overwrite semantics. Preserve human prose and prefer explicit
   export when conflicts exist. This ADR authorizes no vault write workflow.

## Read and display limits for the first implementation

- At most 200 Markdown files and 400 directory entries, depth at most 8.
- At most 64 KiB per file and 4 MiB total; stop with a diagnostic at a limit.
- Frontmatter at most 8 KiB, 32 typed sources/edges per note, bounded strings.
- Sources are local repository-relative paths, selected-repository GitHub
  identifiers, or validated run identifiers; no arbitrary URL fetches.
- Source content is never rendered as trusted Markdown, HTML, commands or policy.
- Reads must bind the opened file to the validated canonical scope. Reuse the
  established descriptor-location protection where available; any unsupported
  host must fail explicitly rather than silently weaken the boundary.

## Compatibility and authority

The first implementation may have a documented host limitation if safe file
binding is unavailable, consistent with ADR 0007 / D-070. URI construction and
native-editor fallback are tested for Windows path encoding independently of
installed-client validation. Do not claim Windows vault indexing from those
unit tests alone. Remote/virtual filesystems need separate validation.

Git owns code; GitHub owns issues/PRs/CI; RunManifest owns execution records;
apm.lock.yaml and APM audit own packaging; approved ADRs own decisions. The vault
helps a person navigate these sources. None of its prose supersedes them.

## Validation before implementation completion

Disposable-vault tests cover offline operation, two repositories, source hashes,
renames, malformed metadata, hostile links, traversal, symlinks, secret filtering,
size/count/depth bounds, absent Obsidian, disconnect and click-time invalidation.
Mocked VS Code tests cover explicit selection, Restricted Mode, multi-root scope
and no startup scan. A real Windows/Linux VSIX walkthrough remains release
validation. Fixtures may create disposable local notes; they never write into a
user vault or create cloud infrastructure.

## Official references

- [Obsidian URI](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI): fixed
  `open` action and absolute `path` parameter; values must be percent-encoded.
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault): an optional future
  plugin boundary; no third-party REST/MCP plugin is required for this design.

## ADR quality gates

Independent read-only architecture review on 2026-10-28 found no blockers against
the approved scope and D-059/D-060/D-070/D-072. Review specifically retained
unsupported-host failure, remote/local path separation and click-time rechecks.

Before merge, verify repository-relative documentation links, whitespace and the
required GitHub checks. The PR records scope, official references, authority and
data boundaries, migration/compatibility limits, and implementation acceptance
criteria. Required CI success does not substitute for independent design review.

After merge, the implementation must satisfy the disposable-vault and VSIX
gates above. ADR acceptance establishes the design baseline, not evidence that
indexing, native navigation or any release has been implemented or validated.
