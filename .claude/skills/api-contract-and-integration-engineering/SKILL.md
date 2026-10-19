---
name: api-contract-and-integration-engineering
description: Design or review versionable TypeScript APIs and integrations with validated contracts, safe retries, idempotency, and observable failure handling.
---

# API and Integration Engineering

Define request, response, error, authentication, pagination, versioning, and compatibility behavior before implementation. Use OpenAPI or an equivalent contract when a public HTTP interface benefits from it. Validate both inbound and important outbound data at trust boundaries.

Classify failures as transient, permanent, or unknown. Use deadlines, cancellation, bounded exponential backoff, jitter, idempotency keys, deduplication, and retry budgets. Do not retry unsafe non-idempotent work without a safeguard. Map vendor errors into stable domain errors and isolate vendor SDKs behind adapters when useful.

Add contract, integration, negative, timeout, authorization, and partial-failure tests. Redact credentials and sensitive payloads in telemetry. State backward compatibility and rollback behavior.
