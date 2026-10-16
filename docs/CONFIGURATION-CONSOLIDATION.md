# Configuration delivery consolidation

PR #61 is the canonical packaged-default implementation for #43. It covers the
shared policy package, planner, CLI, native views, gates, MCP and isolated bundle
validation. PR #62 overlaps this work and must not introduce a second configuration
resolver or conflicting distribution layout. Its alternate commit is preserved in
GitHub; no unique source history is deleted by closing a superseded PR.

This integration retains merged #57-#60 maintenance, APM limits, release preflight,
literal task transport, configured native-client discovery and version-3 discovery
cache. The previous stacked PR now targets main.

Unique requirements surfaced during the alternate implementation remain tracked:
pre-action approval bound to exact revision/context (#44, implemented by
[`APPROVALS.md`](APPROVALS.md) / ADR 0013), evidence retained across
handoffs (#37), and no false readiness when zero applicable deterministic gates run
(#38). These require integration tests and must not be marked complete by config
packaging. Preference-only overlays in #61 cannot broaden authority or restore a
user-disabled harness; they are not authorization for executing a provider.

Current-head CI and independent review must pass after consolidation before merge.
Project 3 rename/membership, live workstation testing and Marketplace publication
are separate operations and are not implied by these code changes.
