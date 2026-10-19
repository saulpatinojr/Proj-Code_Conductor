# Agent Workflows in TypeScript and JavaScript

Follow the repository's pinned SDK and its documentation for that version; agent SDKs change their APIs between releases.

## SDKs seen in TypeScript repositories

| Purpose | Package on npm |
|---|---|
| OpenAI Agents SDK | `@openai/agents` |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` |
| Model Context Protocol servers and clients | `@modelcontextprotocol/sdk` |
| Graph-based workflows | `@langchain/langgraph` |
| Model calls, tools and streaming for web apps | `ai` (Vercel AI SDK) |
| Agent framework | `@mastra/core` |

Do not introduce a second orchestration SDK next to an existing one without a recorded decision.

## Tool contracts

- Describe tool arguments and results with Zod schemas, which many of these SDKs accept directly and turn into JSON Schema. Derive the static type with `z.infer` so the type and the runtime check cannot drift. A TypeScript type on its own rejects nothing at runtime.
- Validate tool results before the agent acts on them, and cap their size.
- Keep authorization in the tool implementation, keyed to the caller's identity, never to anything the model wrote.

## Concurrency, cancellation and time

- Every I/O call returns a promise. An un-awaited promise, a "floating" promise, runs detached: its errors surface as unhandled rejections and its work outlives the run. Enable `@typescript-eslint/no-floating-promises`.
- Promises cannot be cancelled. Create an `AbortController` per run, pass its `signal` into every model call, tool call and `fetch`, and stop loops when `signal.aborted` is true. `AbortSignal.timeout(ms)` gives a deadline.
- One event loop serves everything in the process. CPU-heavy work, large JSON parsing or a slow regular expression blocks every concurrent run; move it to a worker thread or another service.

## State and memory

- Persist run state as JSON or rows in a database. With `JSON.stringify`, `Date` values become strings, `Map` and `Set` become empty objects, and `bigint` throws, so define the stored shape with a schema and convert explicitly.
- Never evaluate stored state or model output as code with `eval`, `new Function` or the `vm` module.

## Runtime

Check the deployment target before choosing APIs. Serverless platforms cap execution time, so long agent runs need a queue or a durable workflow. Edge runtimes and browsers lack Node.js modules such as `fs` and `child_process`. Match the package's module system (ES modules or CommonJS) to the runtime.
