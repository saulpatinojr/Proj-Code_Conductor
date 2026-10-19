---
name: cloud-integration-and-identity
description: Integrate TypeScript systems with Azure, AWS, and Google Cloud using explicit identity, configuration, resilience, and provider-neutral operational boundaries.
---

# Cloud Integration and Identity

Identify provider, account or subscription boundary, region, data classification, network path, identity model, and deployment environment. Prefer workload identity or short-lived credentials, least privilege, and provider SDK clients isolated behind adapters.

Keep configuration and secrets outside source and logs. Make retries, timeouts, idempotency, quotas, pagination, eventual consistency, and regional failure behavior explicit. Do not invent resource names, permissions, APIs, or live state.

Use official provider documentation for current behavior. Validate with mocks for pure logic and authorized integration tests for real boundaries. Ask before changing IAM, service principals, roles, keys, cloud resources, or incurring cost.
