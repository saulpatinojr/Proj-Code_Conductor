---
name: agent-evaluation
description: "Evaluate the outcomes and tool-use process of agentic systems written in Python or TypeScript, with scenario datasets, deterministic checks, rubrics, model judges and human review. Use when agent behavior, a release gate, a prompt, tool or model change, or reliability and safety evaluation is requested."
---

# Agent Evaluation

## Purpose and activation

Establish, with evidence, whether an agent does the right thing in the right way. Activate when agent behavior, a release gate, a prompt, tool or model change, or reliability and safety evaluation is in scope, for a system written in Python, TypeScript, or both.

## Scope and exclusions

In scope: scenario design, datasets and fixtures, outcome and process scoring, deterministic and model-judged checks, human-review gates, cost and latency measurement, and the evaluation report. Out of scope: changing product goals, approving a release, publishing results, and running cost-bearing provider evaluations without scoped authorization. Threat modeling belongs to secure-agent-engineering and workflow structure to agentic-workflow-design; this skill evaluates against both.

## Inputs

Task distribution and dataset provenance, expected and prohibited behavior, tool and approval policy, budgets, approved thresholds and their owner, the language and test stack of the system under evaluation, and the model, prompt and tool versions under test.

## Dependencies and tools

- The repository's existing test runner and evaluation framework. Do not add a framework without approval.
- [references/python.md](references/python.md) and [references/typescript.md](references/typescript.md): runners, output checks, reproducibility, concurrency and pitfalls in each language.
- A model judge only when one is approved and the data policy allows sending the fixtures to it.

## Workflow

1. Identify the language from the code, not from which pack is installed. Python shows up as `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `uv.lock`, `poetry.lock` or `.py` sources. TypeScript or JavaScript shows up as `package.json`, `tsconfig.json`, a lockfile such as `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`, or `.ts`, `.tsx` and `.js` sources. In a repository with both, decide per component. Then read the reference for that language. Translate concepts between the languages, never code: a Python idiom in TypeScript, or the reverse, is a defect even when it runs.
2. Decide where the harness lives. Write it in the system's language when it must call internal code or reuse the system's types and fixtures. A black-box harness that drives the agent over HTTP, a command line or MCP can be in either language, so reuse the team's existing harness instead of adding a second one.
3. Define each scenario with: id, title, goal, input, preconditions, expected and prohibited outcomes, expected tools and approvals, budgets, scoring, threshold owner and version, and evidence. Keep datasets free of secrets and private data unless their use is explicitly approved.
4. Measure the outcome (correctness, usability, grounding and provenance, policy compliance, failure handling, latency, cost) and the process (intent, tool choice, arguments, use of tool output, scope, termination, recovery).
5. Cover successful and ambiguous tasks, conflicting instructions, missing dependencies, invalid or malformed input and tool results, timeouts and cancellation, authentication failures, prompt injection and exfiltration, approval bypass, budget exhaustion, duplicate requests, partial completion, recovery and rollback, and cross-user or cross-tenant memory.
6. Keep deterministic assertions, statistical evidence, model judgment and human adjudication separate. Version prompts, tools, models and datasets, and prevent test-set leakage. Label a threshold without an owner as draft, and require human adjudication for subjective or consequential decisions.
7. Run the cheapest evidence first: deterministic checks against mocks, then recorded fixtures, then live providers only with authorization. Repeat nondeterministic cases and report the variance, not one run.
8. Tell a failed task from a failed evaluator: check the harness, fixtures and judge before blaming the agent.

### Where Python and TypeScript differ for evaluation

| Concern | Python | TypeScript |
|---|---|---|
| Test runner | pytest, with fixtures in `conftest.py` and parametrized cases | Vitest or Jest with `test.each` tables; Playwright Test for outcomes visible in a browser |
| Checking structured output | type hints are not enforced at runtime, so validate with a schema library such as Pydantic | types are erased at compile time, so validate with a schema library such as Zod |
| Async cases | need an async plugin such as pytest-asyncio | native, but a missing `await` lets the test finish before the assertion runs |
| Repeatable randomness | `random.seed` and library seeds | `Math.random` cannot be seeded; use a seeded generator |
| Running cases concurrently | `asyncio.gather` bounded by a semaphore | `Promise.all` bounded by a limiter such as p-limit |
| Large integers and IDs | `int` is exact at any size | `number` is exact only up to 2^53 − 1; compare large IDs as strings |

## Output

An evaluation plan and results: scenario failures, scoring provenance, dataset, prompt, tool and model versions, budgets and cost, human-review gaps, and a release recommendation for the owner to decide.

## Validation

Record the exact commands run, their results, and the evidence that was unavailable. A draft, a static check or a local mock does not establish live behavior. A result counts only for the versions and the task distribution it was measured on.

## Failure handling and escalation

- No approved judge, or data the policy forbids sending: stop that step and propose a deterministic or local check instead.
- A threshold without an owner: label it draft and ask who owns it.
- Correctness judged only by a model: add a deterministic or human check.
- A benchmark result stretched beyond its tasks: state the scope it actually covers.
- A missing input or approval: stop only the dependent operation and continue the useful authorized work.

## Permissions and guardrails

Write only fixtures, rubrics and reports inside the assignment. Run no cost-bearing evaluation without scoped authorization. Never send sensitive fixtures to an unapproved judge. Never treat an agent's completion narrative as proof. A specialist cannot approve its own work or expand its assignment.

## Connection to the pack

This skill ships unchanged in the Python and TypeScript Distinguished Engineer packs, so whichever pack is installed last leaves the same skill in place, and either pack can evaluate a system in either language. The agent-evaluation-engineer specialist and the evaluate-agent prompt use it. Installed on its own, the skill still works and the guardrails above still apply. Installed with a pack, it follows that pack's always-on contract instruction for approval levels, handoffs and the completion report.
