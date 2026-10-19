---
inclusion: fileMatch
fileMatchPattern: "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"
---

# Test Standards

Choose the cheapest test layer that proves the behavior: unit, contract, integration, browser end-to-end, security, performance, or regression. Test invalid input, authorization, timeouts, retries, partial failure, cancellation, cleanup, and compatibility when relevant.

Prefer accessible and stable Playwright locators. Assert user-visible outcomes rather than implementation details. Preserve diagnostics on failure. Never weaken or delete an assertion simply to make a suite pass.
