# Agent Workflows in Python

Follow the repository's pinned SDK and its documentation for that version; agent SDKs change their APIs between releases.

## SDKs seen in Python repositories

| Purpose | Package on PyPI |
|---|---|
| OpenAI Agents SDK | `openai-agents` |
| Claude Agent SDK | `claude-agent-sdk` |
| Model Context Protocol servers and clients | `mcp` |
| Graph-based workflows | `langgraph` |
| Typed agents built on Pydantic | `pydantic-ai` |

Do not introduce a second orchestration SDK next to an existing one without a recorded decision.

## Tool contracts

- Describe tool arguments and results with Pydantic models or typed functions that the SDK turns into JSON Schema. The type hints document intent; the schema validation is what rejects bad input, so keep validation on.
- Validate tool results before the agent acts on them, and cap their size.
- Keep authorization in the tool implementation, keyed to the caller's identity, never to anything the model wrote.

## Concurrency, cancellation and time

- asyncio is cooperative. A synchronous call inside async code, such as a blocking HTTP client or file read, stops every other task. Use async clients, or move blocking work to `asyncio.to_thread`.
- Use `asyncio.TaskGroup` for parallel tool calls: when one fails, the others are cancelled. Use `asyncio.timeout()` for deadlines.
- Cancellation arrives as `asyncio.CancelledError`. Clean up in `finally` blocks and re-raise; catching and ignoring it leaves runs that never stop.
- In the default build, the global interpreter lock means CPU-bound Python code gains little from threads; use processes or a worker service for heavy computation. Check for a free-threaded interpreter before assuming otherwise.

## State and memory

- Persist run state as JSON or rows in a database. Never load `pickle`, `shelve` or similar data that an agent, a user or another tenant could have written: loading it can execute code.
- Give memory entries provenance, tenant, purpose and expiry fields in the schema, so expiry and deletion are enforceable.

## Runtime

Long-running agents usually run as services or workers. Notebooks are fine for exploration but are not a deployment target for agents that hold credentials.
