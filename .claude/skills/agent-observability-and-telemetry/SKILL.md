---
name: agent-observability-and-telemetry
description: Design useful, privacy-aware observability for TypeScript services, tool calls, agent runs, workflows, and operational decisions.
---

# Agent Observability

Define correlation across request, run, tool call, handoff, model call, and state transition. Capture latency, outcome, error class, retry count, cancellation, policy decision, approval, model/prompt/tool/Skill version, token usage, and estimated cost where supported.

Prefer OpenTelemetry-compatible traces, metrics, and logs. Redact credentials, tokens, full prompts, model responses, personal data, and proprietary source by default. Bound payload size and retention. Make sampled diagnostics useful without making sensitive content permanent.

Test context propagation, redaction, cardinality, failure telemetry, and budget/circuit-breaker events. Distinguish instrumentation present in code from data actually exported and observed.
