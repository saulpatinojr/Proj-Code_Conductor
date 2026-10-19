---
name: javascript-node-runtime-engineering
description: Engineer Node.js services and JavaScript modules with correct ESM/CommonJS behavior, lifecycle management, resource cleanup, and operational readiness.
---

# JavaScript and Node.js Runtime Engineering

Inspect `package.json` exports, `type`, `engines`, lockfile, runtime version, loader or bundler, and ESM/CommonJS boundaries before changing imports. Verify the actual supported runtime; do not assume current Node behavior or silently mix module systems.

Design HTTP and worker processes with explicit configuration, secret separation, bounded resource use, graceful shutdown, health and readiness semantics, timeouts, abort signals, and cleanup of sockets, timers, streams, child processes, and files. Use secure path and process handling and avoid shell interpolation with untrusted values.

Test startup, shutdown, malformed configuration, dependency failure, streaming, and concurrency. Profile before optimizing. Preserve lockfiles and document runtime or package export changes.
