# Playwright in Python

Verified against the Playwright for Python documentation on 2026-10-18. Check the repository's pinned `playwright` and `pytest-playwright` versions before relying on an option.

## Runner and setup

- Playwright for Python has no runner of its own. Tests run under pytest with the `pytest-playwright` plugin, after the browsers are installed with `playwright install`.
- The plugin provides `page` and `context` for each test, `new_context` for tests that need several users, and session fixtures such as `browser`, `browser_name` and `browser_channel`.
- Command-line options choose the run: `--browser chromium|firefox|webkit` (repeatable), `--headed`, `--tracing on|off|retain-on-failure`, `--video on|off|retain-on-failure`, `--screenshot on|off|only-on-failure`, and `--base-url`, which the pytest-base-url plugin provides.
- For async tests install `pytest-playwright-asyncio`, use pytest-asyncio 0.26 or later, and set `asyncio_default_test_loop_scope = session` in the pytest configuration.
- Parallel runs come from pytest-xdist (`-n auto`). Retries come from a plugin such as pytest-rerunfailures; Playwright for Python has no built-in retry setting.

## Writing tests

```python
from playwright.sync_api import Page, expect

def test_sign_in_shows_dashboard(page: Page) -> None:
    page.goto("/sign-in")
    page.get_by_label("Email").fill("test-user@example.test")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Dashboard")).to_be_visible()
```

- Locators and assertions use `snake_case`: `get_by_role`, `get_by_label`, `get_by_test_id`, and `expect(...).to_have_text`, `to_be_visible`, `to_have_url`. `expect` retries until the condition holds or times out, so no sleeps are needed.
- Choose one API per test suite. The sync API (`playwright.sync_api`) cannot run inside a running asyncio event loop, and the async API (`playwright.async_api`) belongs in async tests. The API is not thread-safe, so do not share pages or contexts across threads.
- On Windows, the async API needs asyncio's ProactorEventLoop, because Playwright runs its driver in a subprocess.

## Authentication and context options

- Override the `browser_context_args` fixture, at session scope, to set context options for every test, for example a saved `storage_state` file. The `@pytest.mark.browser_context_args(...)` marker sets them for a single test.
- Save login state with `context.storage_state(path=...)` in a setup fixture. The file holds live cookies: keep it out of version control and out of uploaded artifacts.

## Diagnostics

Open a recorded trace with `playwright show-trace trace.zip`. Traces, videos and screenshots can contain personal data and tokens; redact them before sharing.
