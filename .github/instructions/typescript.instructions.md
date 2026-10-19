---
description: "Prefer the repository's supported TypeScript or JavaScript runtime and module system. Use strict typing, explicit public contracts, runtime validation at untrusted boundaries, safe narrowing, clear er"
applyTo: "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"
---

# TypeScript and JavaScript Standards

Prefer the repository's supported TypeScript or JavaScript runtime and module system. Use strict typing, explicit public contracts, runtime validation at untrusted boundaries, safe narrowing, clear error causes, cancellation and bounded retries, resource cleanup, and deterministic tests. Avoid `any`, unsafe assertions, hidden global mutable state, swallowed exceptions, invented APIs, unnecessary dependencies, secrets, and unrelated refactoring.

For public or operational behavior, update documentation and compatibility notes. For UI, preserve accessible semantics and useful error feedback. For APIs, define versioning, timeout, idempotency, authorization, and error mapping behavior.
