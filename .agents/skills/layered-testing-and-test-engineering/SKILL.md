---
name: layered-testing-and-test-engineering
description: Build a proportionate layered test strategy for TypeScript systems, public contracts, integrations, browser journeys, and regression coverage.
---

# Layered Testing

Map requirements and risk to unit, contract, integration, end-to-end, security, negative, performance, and regression tests. Use the cheapest layer that can prove the behavior, but do not substitute mocks for a boundary whose real behavior matters.

Inspect actual scripts, fixtures, CI, environment setup, test ownership, and coverage meaning. Make tests deterministic and independent. Test invalid input, authorization, timeouts, retries, partial failure, cancellation, resource cleanup, and backward compatibility where relevant.

Report commands, results, failures, flaky behavior, environment limits, and untested risk. A green test command proves only the exercised scope.
