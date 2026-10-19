---
name: typescript-strict-engineering
description: Design, implement, or review maintainable strict TypeScript with explicit contracts, safe narrowing, runtime validation, and reliable asynchronous behavior.
---

# Strict TypeScript Engineering

Inspect the repository's TypeScript version, `tsconfig` inheritance, module settings, generated code, build tool, and public package boundaries. Prefer the repository's supported version and enable strictness deliberately; do not rewrite configuration merely to satisfy a preference.

Avoid `any`, unsafe assertions, non-null assertions, swallowed exceptions, and implicit public contracts. Use `unknown` at untrusted boundaries, narrow deliberately, use discriminated unions and exhaustive checks for closed state, and keep public types independent of private implementation details. Pair compile-time types with runtime schemas for external input.

For async code, make cancellation, timeout, concurrency, cleanup, error causes, retries, and backpressure explicit. Add focused tests for invalid states and failure paths. Record compatibility impact when changing exported types or generated declarations.
