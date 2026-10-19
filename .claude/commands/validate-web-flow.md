---
description: Validate a web journey with Playwright in Python or TypeScript, with
  accessible locators, web-first assertions, isolated authentication and replayable
  evidence
---

# Validate a web journey

## Inputs

- The authorized environment, URL, test account and allowed domains.
- The user journey, the expected states, and the data and side-effect limits.

## Workflow

1. Identify the language of the existing browser test suite, which can differ from the application's, and extend that suite in its own language.
2. Apply playwright-validation: discover the configuration and versions, use role, label or test-id locators and web-first assertions, cover failure and boundary states, and keep authentication state out of version control.
3. On failure, keep the trace and diagnostics and investigate the product before changing the test.

## Expected output

The tests or changes, the exact environment, commands and results, failures with their location, sanitized artifacts and cleanup status, followed by a completion report in the format of the installed pack's contract instruction.

## Guardrails

Stop at out-of-scope redirects, uploads or consequential production actions. Never weaken an assertion or accept an auto-healed selector without confirming the intended behavior.