# VS Code cockpit

Code Conductor v0.1 uses a thin VS Code extension rather than a replacement chat interface.

## Activity Bar views

- **Team** — roles, stances, and preferred harnesses from repository policy.
- **Runs** — recent runs from `~/.code-conductor/runs` (or `CODE_CONDUCTOR_HOME`), each with its decision and next step. Clicking a run lists its next actions. These hand you to native Source Control, copy a command for you to run, or show the manual handoff ([`NATIVE-INTERFACES.md`](NATIVE-INTERFACES.md)).
- **Gates** — deterministic gate profiles and whether each gate is blocking.
- **Connections** — presence of GitHub CLI, APM, Claude Code, Codex, Kiro CLI, and Antigravity CLI. Clicking a client shows its official sign-in command and documentation link; detected never means signed in or trusted.
- **Packs** — APM lock state, canonical agent/skill counts, and explicit APM targets.
- **Usage** — subscription-first/API-spend policy. v0.1 does not scrape or persist vendor quota telemetry.

## Commands

The extension exposes refresh, doctor, repository validation, task planning, and decision-register navigation. Execution remains in the Code Conductor CLI and official vendor clients. Terminal output, source control, diffs, GitHub PRs, and native agent sessions stay in their existing VS Code surfaces.

## Deliberate non-features

- no custom multi-model chat window
- no credential entry/storage UI
- no secret display
- no attempt to mirror GitHub's PR UI
- no paid-client execution from extension activation
