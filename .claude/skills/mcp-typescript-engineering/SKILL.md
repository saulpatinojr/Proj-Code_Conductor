---
name: mcp-typescript-engineering
description: Build or review TypeScript MCP servers and clients with precise schemas, safe transports, authorization, bounded results, and approval-aware actions.
---

# TypeScript MCP Engineering

Inspect the repository's MCP SDK generation and use the official documentation for that generation. Define tools, resources, and prompts separately. Use narrow names and descriptions, strict input schemas, output schemas where useful, bounded results, timeouts, cancellation, and explicit error behavior.

Treat tool arguments, resource contents, prompt text, and remote responses as untrusted. Authenticate and authorize outside model intent; enforce least privilege in code. Keep read-only resources distinct from side-effecting actions. Require approval for destructive, privileged, externally visible, expensive, or irreversible operations. Redact sensitive values in logs and record auditable action metadata.

For stdio, keep protocol output clean and log diagnostics to stderr. For remote HTTP, review origin/host validation, sessions, replay, CSRF, token handling, rate limits, and deployment boundaries. Test malformed arguments, oversized output, denial-of-wallet, cancellation, authorization, and tool failure.
