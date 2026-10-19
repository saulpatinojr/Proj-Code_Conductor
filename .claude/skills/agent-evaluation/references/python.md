# Agent Evaluation in Python

Use what the repository already runs. The tools below are common choices, not requirements; check the pinned versions before relying on an API.

## Runner and cases

- pytest runs the deterministic checks. Load scenarios from a JSONL or YAML dataset and feed them through `@pytest.mark.parametrize`, with the scenario id as the test id so failures name the case.
- Put shared fixtures (fake tools, recorded responses, budgets) in `conftest.py`. Give each test its own state; a fixture that mutates shared state makes results depend on test order.
- Async agents need an async plugin: pytest-asyncio, or the AnyIO plugin if the code uses AnyIO. Match the plugin's event-loop scope to how the agent creates its clients, or tests fail with "attached to a different loop" errors.
- Property-based checks with Hypothesis suit tool-argument validators and parsers. Snapshot files, for example with syrupy, suit prompt templates; review every snapshot change rather than accepting all of them.

## Evaluation frameworks seen in Python repositories

Inspect (`inspect-ai`), DeepEval, Ragas for retrieval metrics, and autoevals are common. Each brings its own dataset and scorer model. Adopt one only with approval, and keep its model-judged scores separate from the pytest results.

## Checking structured output

Type hints check nothing when the program runs. Validate every model or tool output that the agent acts on: for example `Model.model_validate_json(raw)` with Pydantic, in strict mode when coercion would hide a defect. Assert on the validation error for malformed cases rather than only on success.

## Reproducibility

- Seed `random`, and the libraries that keep their own generators such as NumPy, and record the seeds in the report.
- Record the model name and version, temperature and other sampling settings for every live run. Providers can still return different outputs for identical requests, so repeat cases and report the spread.

## Concurrency and limits

- Bound concurrent provider calls with `asyncio.Semaphore` around `asyncio.gather`, or use `asyncio.TaskGroup`, which cancels the remaining tasks when one fails.
- Give every case a deadline with `asyncio.timeout()`, and let `asyncio.CancelledError` propagate; swallowing it hides cancellation bugs that the evaluation should find.
- A blocking call inside async code, such as a synchronous HTTP client, stalls every concurrent case. Run blocking work through `asyncio.to_thread`.

## Mocks and recorded fixtures

Replace providers and tools with fakes through `unittest.mock` or the HTTP mocking library the repository already uses. Recorded responses must be scrubbed of secrets and personal data before they are committed.
