---
name: agentic-cost-and-budget-controls
description: Bound and measure model, tool, workflow, and cloud consumption in agentic TypeScript applications.
---

# Agentic Cost and Budget Controls

Make token, step, time, concurrency, tool-call, retry, response-size, and external API budgets explicit. Prefer deterministic routing and cacheable work where appropriate. Add circuit breakers and safe partial-completion behavior when limits are reached.

Record model, prompt, tool, Skill, and workflow versions with usage and estimated cost where supported. Redact payloads while retaining enough metadata for attribution. Distinguish estimates from provider invoices and local measurements from production telemetry.

Test budget exhaustion, denial-of-wallet inputs, expensive loops, retries, cancellation, and degraded outcomes. Require approval for material cost or paid external calls.
