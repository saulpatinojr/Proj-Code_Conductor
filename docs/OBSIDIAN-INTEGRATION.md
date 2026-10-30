# Optional Obsidian integration

[ADR 0016](adr/0016-local-first-knowledge-navigation.md) merged in #146. The
read-only local Linux slice merged in [#147](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/147);
installed VSIX/Obsidian validation and the whole #141 workstream remain open.

## Connect and browse

1. In a trusted local Linux workspace, run **Connect Knowledge Vault**.
2. Select an existing vault and a contained non-hidden folder for this repository.
   Connection stores only paths in VS Code workspace state and performs no scan.
3. Run **Browse Knowledge** or click **Knowledge** in Workstation. Indexing is
   explicit, local and bounded. A run's **Related knowledge** filters declared
   run identifiers without copying private prompts, manifests or output.
4. Choose a note, then the native editor or Obsidian. The command rechecks note
   content and source/edge states. If Obsidian cannot open it, or its path has
   URI-reserved characters, the editor is used.
5. **Disconnect Knowledge Vault** forgets connection state and deletes no notes.

There is no startup scan, note generation, persistent content index, provider
context disclosure, embedding service, network request, synchronization or cloud
resource. GitHub references may trigger one safe local Git origin query, limited
to two seconds and 4 KiB, only during explicit browsing. Git/GitHub, approved ADRs,
runtime evidence and APM remain authoritative; notes cannot change their state.

## Supported metadata

Only explicit `code_conductor` frontmatter version 1 is indexed. Ordinary prose,
Markdown links, commands and arbitrary URIs are not interpreted as instructions.
For example, manually author a note using the actual selected repository path:

```yaml
---
code_conductor:
  version: 1
  id: decision-context
  kind: decision
  repository: /absolute/path/to/repository
  sources:
    - kind: file
      path: docs/DECISIONS.md
      sha256: "0000000000000000000000000000000000000000000000000000000000000000"
    - kind: issue
      id: owner/repository#7
    - kind: run
      id: CC-example
  edges:
    - kind: decided_by
      target: project-overview
      source: 0
---
Human-owned prose stays here.
```

Replace the sample SHA-256 with the actual UTF-8 source-file digest. Quote a digest
if it contains only digits so YAML keeps it a string. GitHub identity must match
the selected repository's official GitHub `origin`; issue/PR existence/status
remains unverified. Missing or unsupported origins cannot establish association.
Run IDs remain unverified navigation references and are never treated as readiness.

Node kinds: project, repository, decision, issue, pr, agent, skill, pack, task, run,
evidence and lesson. Edge kinds: depends_on, uses, implements, decided_by,
validated_by and related_to. Each edge points to a source index and another
explicit note ID. Missing target IDs are broken; duplicate identities are excluded.

Source states are `locally_matched` (local source digest matches), `stale` (digest
changed), `broken` (missing, blocked or unavailable), or `unverified` (external/run
claim). A matched digest identifies content; it does not prove a note's semantic
claim. `observedAt` is the local indexing time, not remote verification.

## Safety, bounds and host support

Reads reuse the established descriptor-bound reader: regular single-link files,
canonical scope, no symlink traversal and Linux descriptor-location verification.
Hidden/sensitive path components, configured private run-store descendants,
credential-shaped content, malformed or tagged YAML and unsupported metadata are
excluded with generic diagnostics. No parser snippets or credential values are
logged. Click-time changes require refreshing the selection.

Limits: 200 Markdown files, 400 traversed entries, depth 8, 64 KiB per read,
4 MiB total charged read budget, 8 KiB frontmatter, and 32 sources/edges per note.
Directory iteration is bounded. Failed/invalid UTF-8 reads reserve their allowance
rather than bypassing the budget. Repeated source reads share a per-scan hash cache.

Windows, macOS and remote/virtual indexing fail explicitly. URI serialization and
Windows path encoding have unit coverage, not installed-client evidence. Paths
containing reserved query characters use the editor fallback to avoid native URI
reinterpretation. No third-party Obsidian plugin is required.

## Incremental parsing and cache retention

Explicit refreshes reuse validated frontmatter parsing for unchanged note-content
SHA-256 hashes within one canonical vault/folder/repository scope. Parsing is the
only reused work: every scan still descriptor-reads current note bytes, enforces
the existing scan/read budgets, reads referenced local sources and rechecks the
local GitHub origin association. Source verification results and remote/run
status are never cached. Relationships and observation timestamps are rebuilt
from that current scan; changed or missing targets become stale/broken normally.
Click-time revalidation performs the same fresh reads even on a parsing cache hit.

The extension retains at most 200 entries and 2 MiB of serialized parsed metadata
in memory. It retains no note bodies, source contents or persistent content index.
Entry and byte bounds can cause a valid note to be reparsed; they never omit it
from the current bounded scan. Renamed notes receive their current path/title;
deleted or no-longer-readable notes leave the result and their unused cache
entries are pruned at the next scan. Unsupported repository/source associations
are not retained as accepted metadata.

Only the latest active connection scope is retained. Connecting/disconnecting,
selecting a repository, workspace-folder changes and extension disposal clear
retained metadata. Invalid connections or a failed root scan also clear it. While idle, the bounded
metadata remains in memory until one of those events; there is no background
rescan, expiry timer, disk persistence or claim of current remote verification.
Returned notes cannot mutate the retained parsed metadata.

## Remaining work and validation

Disposable tests cover two repository scopes, source changes, renamed/modified
notes, traversal, symlinks, credentials, malformed metadata, scan limits, byte
budgets, incremental parsing reuse, cache bounds/mutation isolation and URI handling. Mocked VS Code tests cover no startup/connection scan,
Restricted Mode, remote refusal, editor fallback and disconnect preservation.

Real installed VSIX/native Obsidian walkthroughs, broader host support, note-body
search and explicit note templates/write previews remain outstanding. Incremental
parsing does not remove the full bounded file/source safety checks on each scan. The
separate cloud-sync request #137 requires its own reviewed architecture and
protected deployment gates; this adapter activates none of it.

Official references:

- [Obsidian URI](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI)
- [VS Code external opener](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/services/openerService.ts)
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault), a possible later
  plugin boundary, not a dependency of this slice.
