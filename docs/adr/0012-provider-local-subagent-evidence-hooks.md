# ADR 0012 — Provider-local subagent evidence through lifecycle hooks

- **Status:** Proposed
- **Date:** 2026-10-08
- **Related:** ADR 0003, ADR 0009, ADR 0011, D-051, W-003, W-005

## Context

D-051 permits provider-local subagents to operate inside an assigned provider task. Code Conductor currently records only the assignment's final `CC_RESULT_JSON`. Any subagents the provider spawned inside that assignment are invisible to the run manifest. Code Conductor ships no lifecycle hooks: there are none in `.apm/`, `.claude/settings.json`, `.codex/hooks.json`, or `.github/hooks/`.

The sibling product Code Workflow (ADR 0011) demonstrates a working pattern. One fail-open hook script handles `SessionStart`/`SubagentStart`/`SubagentStop`/`Stop` payloads from Claude Code, Codex, and Copilot, and appends an allowlisted audit record. APM 0.30.0 can project one hook source into Claude settings merges, `.codex/hooks.json`, and `.github/hooks/<pkg>-<name>.json`.

## Proposed decision

1. Add a canonical hook source under `.apm/hooks/` that records `SubagentStart`/`SubagentStop` events to the owner-private run store, only when `CODE_CONDUCTOR_RUN_ID` and `CODE_CONDUCTOR_ASSIGNMENT_ID` are present.
   - Outside a Code Conductor run the hook is a silent no-op, so it does not affect ordinary developer sessions in this repository.
2. Adapters export those two variables to the spawned client process.
3. The hook stores allowlisted metadata only: event name, agent type/id, and timestamps. It never stores prompts, transcripts, tool input, or tool output.
4. Materialize the hook with the pinned APM CLI per ADR 0003 and commit the projections.

## Why proposed, not accepted

- This touches every provider configuration in the repository, plus each client's hook-trust flow. Codex requires `/hooks` review and trust; VS Code Copilot requires `chat.useClaudeHooks` for Claude-format hooks. Those flows need workstation validation (W-003, W-005) first.
- The adapter environment contract is a provider/harness contract change that needs owner approval.

## Validation required before acceptance

- Per-client hook firing and payload-shape evidence on the installed client versions.
- A regression test that the hook is a no-op without the run variables.
- `apm audit` passing after materialization.
