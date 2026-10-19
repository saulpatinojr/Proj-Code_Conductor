---
name: performance-reliability-and-operability
description: Improve TypeScript system performance and production operability using measured bottlenecks, resilience controls, and recovery evidence.
---

# Performance and Operability

Define service-level objectives, critical paths, capacity assumptions, dependencies, failure budgets, recovery objectives, and ownership. Measure before optimizing. Review event-loop blocking, memory, streams, connection pools, caching, concurrency, backpressure, cold starts, bundle size, and database or API calls.

Use timeouts, cancellation, bounded queues, bulkheads, circuit breakers, graceful degradation, health/readiness, safe shutdown, and runbooks where appropriate. Avoid unbounded retries, queues, logs, or agent loops.

Test load and failure behavior in an isolated environment when authorized. State what was measured, workload shape, environment, and limits; do not infer production performance from a unit test.
