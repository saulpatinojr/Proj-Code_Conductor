# Code Conductor working status

Updated 2026-10-28 (UTC). This document distinguishes merged development work,
prepared changes and released/workstation evidence. GitHub and executable
validation remain authoritative; issue scope alone is not completion.

## Current position

**0.1.2 beta is published. Reliability, stored execution monitoring, optional
pack provenance/audit and read-only local knowledge navigation are merged on
main. The full workstreams and release validation are not complete.**

| Area | Evidence-backed status |
|---|---|
| Published release | [v0.1.2](https://github.com/saulpatinojr/Proj-Code_Conductor/releases/tag/v0.1.2), published October 22 from `130c155`, with VSIX, SBOM and checksums. New development changes are unreleased. |
| Dependency remediation | [#136](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/136) merged at `f9130e8`: ACP 2.0.1 and dependency fixes. Local/CI validation is recorded in that PR. |
| Initial cockpit reliability | [#143](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/143) merged at `e3a145c`: task-end refresh, repository-scoped runs, multi-root selection and effective read-only configuration. |
| Stored execution overview | [#144](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/144) merged at `04ad126`: approved start observations, dependency/provider/authority details, evidence refresh, one-shot stale expiry and inert summary text. No new scheduler. |
| Optional APM inventory/audit | [#145](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/145) merged at `8e2b2cb`: pinned source metadata, mismatch diagnostics, explicit bounded audit and absolute executable resolution. Installation lifecycle remains open. |
| Knowledge implementation | [#147](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/147) merged at `599b03a`: bounded local knowledge navigation and source provenance, initially trusted local Linux only. |
| Knowledge architecture | [#146](https://github.com/saulpatinojr/Proj-Code_Conductor/pull/146) merged at `5cf27ea`: accepted ADR 0016/D-078, optional bounded read-only navigation with no cloud activation. |
| Workstation evidence | #4 is closed with recorded 0.1.1 Windows evidence: provider smoke tests, activation, R1/R2 and GitHub review. That is not clean-machine validation of 0.1.2 or current source. |

## Merged knowledge implementation

PR #147 adds explicit existing-vault/folder selection,
repository-bound typed metadata, local source hashes, stale/broken states,
click-time invalidation and native editor/Obsidian navigation. It creates no
notes, copies no private run content and starts no indexing/provider/network
operation at activation or connection. Indexing supports trusted local Linux
hosts only; Windows/macOS/remote indexing fails explicitly.

The implementation reuses descriptor-bound reads, excludes hidden/credential
and configured private-state paths, bounds traversal and total reads, and charges
failed/invalid UTF-8 reads against its budget. A lazy local Git origin lookup has
a two-second/4 KiB bound. Remote issues and run references remain unverified.
URI-ambiguous paths and an unavailable Obsidian client use the editor fallback.
See [Obsidian integration](OBSIDIAN-INTEGRATION.md) for schema and limitations.

Validation after integration with current main: **70 test files, 618 passed /
33 skipped**; typecheck, repository validation, standalone bundle/default smoke
and local VSIX packaging passed. The VSIX uses a test publisher, not publication.
Independent read-only review found no remaining blockers after corrections and
reran focused integration tests. Required GitHub checks passed before merge.
Post-merge on `main`: typecheck, 100 focused tests (one host-specific skip),
repository validation and standalone bundle smoke passed. Knowledge navigation in
a real installed Obsidian client remains unvalidated.

## Native installed-VSIX evidence

The packaged source at `76b903a` passed eight real extension-host checks in an
installed test-publisher VSIX on Linux/VS Code 1.105.1 under Xvfb: activation,
command registration, packaged defaults, optional absent APM, scoped run summary,
open-summary refresh and a successful bundled native validation task. The
unrelated empty workspace remained empty. This does not establish Windows,
Restricted Mode, exhaustive click-through, accessibility or real Obsidian behavior.
The reusable runner and bundle hashes are in the [native smoke record](validation/2026-10-28-linux-vsix-smoke.md).

## APM evidence and remaining lifecycle

Prepared on `feat/apm-exact-preview`: explicit fixed-catalog Codex projection
comparison in a Linux bubblewrap write boundary (ADR 0017). The pinned native APM
run passed staged audit and compared **54 unchanged files** for both reviewed
packs against this repository. Local validation: **72 files, 645 passed / 33
skipped**, typecheck, repository validation, standalone bundle/default smoke and
test-publisher VSIX packaging passed. Independent critical review found and
verified fixes for shared legacy ownership and pre-creation staging containment.
GitHub review/required CI and merge are still pending for this prepared slice.
This is not an installed-VSIX desktop walkthrough or a repository installation.

The official APM 0.33.0 Linux archive was checked against its published SHA-256.
`apm targets`, native audit and the built CLI audit passed all 31 checks with no
drift against this repository's unchanged package source/projections.

A disposable single-pack Codex fixture confirmed that native installation creates
agent/skill projections, a lock and `.gitignore`. Native `install --dry-run` lists
packages but explicitly omits per-package stale-file cleanup; it is not an exact
projected-file diff. The prepared comparison adds fixed-catalog selection and
exact selected Codex projection/conflict evidence. Full native diffs including
manifest/lock/local-source/all-target merging, action-bound install approval,
deployment-correlated audit evidence and safe update/removal remain required
under #142. See [APM workflows](APM-WORKFLOWS.md).

## Active delivery work

- [#139](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/139): remaining
  cockpit action/state coverage and real installed-VSIX interaction/host evidence.
- [#140](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/140): remaining
  orchestration UX acceptance, source-linked evidence and desktop validation.
- [#142](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/142): full APM
  select/preview/approve/install/audit/update/removal workflow.
- [#141](https://github.com/saulpatinojr/Proj-Code_Conductor/issues/141):
  validate native navigation, then add incremental indexing and
  reviewed note-template/write workflows. No automatic vault write is authorized
  by connection.
- #137/#138 capture additional Second Brain/sidebar requests. Cloud sync needs
  separate reviewed architecture and protected deployment gates; it is not
  activated by the local adapter.
- #14 remains the Marketplace/release-engineering path. Recheck publisher/Entra
  configuration before acting; existing `v0.1.2` is not an uncreated tag.

## Limits to retain

- Linux installed-VSIX command/document/task smoke passed as recorded above.
  Clean Windows, exhaustive interactive click-through and real Obsidian walkthrough
  remain outstanding. Mocked extension-host/URI tests are separate evidence.
- Kiro modify remains fail-closed; Antigravity unattended execution stays blocked.
- Context file reads and initial knowledge indexing require supported local Linux
  descriptor protection. The context optimizer MCP transport remains experimental.
- No release, Marketplace publication, cloud provisioning or GitHub Project board
  change was performed during these implementation slices.
- PR creation and merge are owner-authorized after required checks; runtime
  provider/disclosure/commit/deployment approvals remain action-specific.
