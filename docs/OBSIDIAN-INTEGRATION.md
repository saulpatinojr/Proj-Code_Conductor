# Optional Obsidian integration

The approved workstream is tracked in #141. [ADR 0016](adr/0016-local-first-knowledge-navigation.md)
is the proposed read-only boundary and must be independently reviewed before
implementation. No vault integration is currently claimed complete.

The intended first experience is **connect an existing vault folder -> inspect
repository-related notes -> open a verified local mapping in Obsidian or the
native editor -> disconnect**. The connection creates no notes and uploads
nothing. Indexing stays bounded, local and on demand.

Notes are navigation. Git/GitHub, approved ADRs, runtime evidence and APM remain
their respective authorities. Missing or changed sources stay unverified/stale.
No note may grant execution authority, change a gate or claim that a PR merged.

The separate cloud-sync request in #137 needs its own reviewed architecture and
deployment gates. It is not activated by connecting a local vault. Private run
outputs and provider credentials must never be copied automatically into a
folder that may already be synchronized by another application.

A later implementation will document the exact frontmatter schema, supported
hosts, selection/disconnect commands and disposable-vault walkthrough here.
