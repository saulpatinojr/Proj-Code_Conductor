# Agent Evaluation in TypeScript and JavaScript

Use what the repository already runs. The tools below are common choices, not requirements; check the pinned versions before relying on an API.

## Runner and cases

- Vitest or Jest runs the deterministic checks. Load scenarios from a JSONL or JSON dataset and feed them through `test.each`, with the scenario id in the test name so failures name the case.
- Every async test must `await` or return its promises. Without the `await`, the test can finish before the assertion runs and pass falsely. Turn on the `@typescript-eslint/no-floating-promises` lint rule, and use `expect.assertions(n)` where a case must reach a set number of assertions.
- Module mocks (`vi.mock` in Vitest, `jest.mock` in Jest) behave differently under ES modules and CommonJS. Check which module system the package uses before writing mocks.
- Property-based checks with fast-check suit tool-argument validators and parsers. Snapshot tests suit prompt templates; review every snapshot change rather than updating them all at once.
- Outcomes that a user sees in a browser belong to Playwright Test; see the playwright-validation skill.

## Evaluation frameworks seen in TypeScript repositories

promptfoo, a Node.js command-line tool configured in YAML, Evalite, which builds on Vitest, and autoevals are common. Each brings its own dataset and scorer model. Adopt one only with approval, and keep its model-judged scores separate from the unit-test results.

## Checking structured output

TypeScript types are erased when the code is compiled and check nothing at runtime. Validate every model or tool output that the agent acts on: for example `Schema.safeParse(value)` with Zod, deriving the static type from the schema with `z.infer` so the two cannot drift. Assert on the validation error for malformed cases rather than only on success.

## Reproducibility

- `Math.random()` cannot be seeded. For repeatable synthetic data use a seeded generator library, and record the seed in the report. fast-check prints the seed of a failing run so it can be replayed.
- Record the model name and version, temperature and other sampling settings for every live run. Providers can still return different outputs for identical requests, so repeat cases and report the spread.

## Concurrency and limits

- Bound concurrent provider calls with a limiter such as p-limit around `Promise.all`. Use `Promise.allSettled` when one failed case must not discard the others' results.
- Give every case a deadline with `AbortSignal.timeout(ms)` and pass the signal into the agent and its fetch calls. A `Promise.race` timeout without an abort signal leaves the losing work running and spending.
- CPU-heavy scoring, such as large text comparisons or regular expressions on long outputs, blocks the single event loop and slows every concurrent case.

## Numbers and JSON

`number` represents integers exactly only up to 2^53 − 1 (`Number.MAX_SAFE_INTEGER`). Compare large identifiers, such as 64-bit IDs, as strings or `bigint`, not as parsed numbers; `JSON.parse` silently rounds them.
