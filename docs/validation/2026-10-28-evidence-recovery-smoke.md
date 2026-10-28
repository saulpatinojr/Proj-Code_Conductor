# Native evidence recovery smoke — 2026-10-28

Product source: `dfd9a24` (PR #151). Same isolated official VS Code 1.105.1/Linux
installation, test-publisher VSIX and empty fixture setup as the
[initial native smoke](2026-10-28-linux-vsix-smoke.md). The rebuilt VSIX was
installed using the native CLI; Code Conductor was loaded from the installed
extensions directory, with only the empty smoke driver in development mode.

All **12 native checks passed** at `2026-10-28T09:48:33Z`: the original eight
activation/command/defaults/inventory/summary/task/workspace assertions, plus:

- A synthetic private capture opens only when its exact streams match the
  selected manifest digest/source. Its untrusted `command:` URI is not followed;
  the viewer displays the manifest's failed gate verdict.
- Editing the open capture's stdout invalidates the native document through the
  real filesystem watcher, without manual refresh.
- Reopening the cached native document retains the unavailable/unverified state.
- Restoring the original bytes makes the watcher show the matching capture again.

Synthetic capture data exercises recovery integrity; it is not evidence that a
model or tool ran for that fixture. The separate native bundled validation task
did run and exited zero. The unrelated workspace stayed empty. Fixture cleanup
and owner-private report behavior are unchanged.

| Bundle | SHA-256 |
|---|---|
| extension.js | `6ec4f75f05af82d19b993adbf84713a0a940757bb3742701ba8da4a2ef72f75f` |
| ccon.js | `97d3b83a58fd7162b9e87432b2ecbbde6c13612a078b7e03ba19abdf8481ee1b` |

Local regression evidence: **73 files, 661 passed / 33 skipped**. Typecheck,
repository validation, standalone bundle/default smoke and test-publisher VSIX
packaging passed. Independent critical review found no remaining blockers after
fixes for provenance, canonical-only legacy digests, exit metadata, storage
creation, run identity, redirected newline preservation and document caching.

Windows, Restricted Mode, exhaustive click-through/accessibility, actual Obsidian,
APM installation and release publication remain outside this result. Repeat with
the current `scripts/vscode-desktop-smoke.cjs` and the launch documented in the
initial record. Strong recovery intentionally refuses legacy combined/truncated
captures while preserving their files; see [stored output](../GATE-PROFILES.md#stored-output-and-the-summary-mode-94).
