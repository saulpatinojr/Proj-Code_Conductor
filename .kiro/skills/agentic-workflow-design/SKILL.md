---
name: agentic-workflow-design
description: "Design bounded, auditable agent applications and multi-step tool workflows in Python or TypeScript: state, tools, memory, budgets, cancellation and optional specialist handoffs, using autonomy only where it adds value. Use when an agent application or tool-calling workflow needs design or change in either language."
---

# Agentic Workflow Design

## Purpose and activation

Produce an agent workflow that finishes, stays inside its budgets and authority, and can be audited afterwards. Activate when an agent application or a multi-step tool workflow is designed or changed, in Python, TypeScript, or both.

## Scope and exclusions

In scope: choosing between deterministic steps and agent autonomy, states and transitions, tool contracts, identities and approvals, run state and memory, budgets, cancellation and recovery, handoffs, and the evaluation cases that prove the design. Out of scope: multi-agent orchestration added only to mirror an organization chart, and committing to an SDK the repository does not use. Security review of the design belongs to secure-agent-engineering and measuring it to agent-evaluation.

## Inputs

The user outcome, which decisions are stable and which are uncertain, tool contracts, identities and tenancy, state and memory needs, latency and cost limits, the deployment runtime, and the repository's language, orchestration stack and pinned SDK versions.

## Dependencies and tools

- The repository's agent or orchestration SDK at its pinned version, and the policy enforcement layer outside the model.
- [references/python.md](references/python.md) and [references/typescript.md](references/typescript.md): SDKs, schemas, concurrency, cancellation and runtime limits in each language.

## Workflow

1. Identify the language from the code, not from which pack is installed. Python shows up as `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `uv.lock`, `poetry.lock` or `.py` sources. TypeScript or JavaScript shows up as `package.json`, `tsconfig.json`, a lockfile such as `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`, or `.ts`, `.tsx` and `.js` sources. In a repository with both, decide per component, and treat the boundary between them (HTTP, queue messages, MCP) as a contract that each side validates. Then read the reference for that language. Translate concepts between the languages, never code.
2. For new work with no existing code, choose the language with the user and record the decision. Python suits workflows that live next to data, machine-learning or evaluation code and long-running workers. TypeScript suits workflows that share types and code with a web front end, or that run in browsers, serverless functions or edge runtimes. Both have official agent and MCP SDKs, so SDK availability alone rarely decides it.
3. Prefer deterministic steps where the requirements are stable. Start with one capable agent, and add specialists only for bounded expertise, independent evidence or useful concurrency.
4. Model the states, transitions, completion, retry and recovery, and termination. Bound elapsed time, model, tool and browser calls, parallelism, tokens, context and estimated spend.
5. Define tools with schema-validated arguments and outputs, and enforce identities, authorization and approvals outside the model. Keep untrusted content apart from instructions.
6. Design cancellation and timeouts in the language's own model (see the table below): every tool call and model call must stop when the run is cancelled or out of budget.
7. Separate run state, user preferences, repository facts, retrieval, durable memory and audit records. Attach provenance, time, tenant scope, purpose, expiry and deletion to memory, and never promote speculation or poisoned retrieval into authoritative memory. Store state in JSON or a database, never in a format that executes code when loaded.
8. Use structured outputs, version prompts, tools, models and skills, keep human approval at consequential boundaries, and hand the evaluation cases to agent-evaluation.

### Where Python and TypeScript differ for agent workflows

| Concern | Python | TypeScript |
|---|---|---|
| Tool schemas | Pydantic models or typed functions turned into JSON Schema; hints alone are not enforced | Zod schemas turned into JSON Schema, which many TypeScript agent SDKs accept directly; types alone are erased |
| Concurrency | asyncio runs only when started; synchronous code is the default, and a blocking call inside async code stalls the loop | one event loop is always running; I/O is asynchronous by default, and CPU-heavy work blocks every request |
| Cancellation | cancel the task; `asyncio.CancelledError` propagates and `asyncio.timeout()` sets deadlines | promises cannot be cancelled; pass an `AbortSignal` into every call and check it |
| Streaming | `async for` over async generators | `for await` over async iterables |
| Runtimes | servers, workers and notebooks | Node.js servers, serverless and edge functions where some Node APIs are missing, and browsers |
| State serialization | `pickle` executes code when loaded; use JSON | `Date`, `Map`, `Set` and `bigint` do not survive `JSON.stringify` unchanged |

## Output

The workflow and state design, tool and handoff contracts, budgets, the cancellation, failure and escalation paths, and the evaluation cases.

## Validation

Record the exact checks run, their results, and the evidence that was unavailable. A design, a static check or a local mock does not establish live behavior. Every state has an exit, every budget has an enforcement point, and every tool call has an owner of its authorization.

## Failure handling and escalation

- A loop with no terminal state or no budget: redesign it before implementing.
- Context or memory that crosses users or tenants: stop and escalate.
- An agent able to approve its own consequential action: move the approval outside the model.
- An agent hierarchy with no measurable benefit: collapse it to one agent or deterministic steps.
- A missing input or approval: stop only the dependent operation and continue the useful authorized work.

## Permissions and guardrails

Design and change only what the assignment covers. Never let model output grant permissions, approve actions or widen tool scope. Do not install new SDKs, MCP servers or packages without approval. A specialist cannot approve its own work or expand its assignment.

## Connection to the pack

This skill ships unchanged in the Python and TypeScript Distinguished Engineer packs, so whichever pack is installed last leaves the same skill in place, and either pack can design workflows in either language. Installed on its own, the skill still works and the guardrails above still apply. Installed with a pack, it follows that pack's always-on contract instruction for approval levels, handoffs and the completion report.
