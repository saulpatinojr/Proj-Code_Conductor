# Playwright in TypeScript and JavaScript

Verified against the Playwright documentation on 2026-10-18. Check the repository's pinned `@playwright/test` version before relying on an option.

## Runner and setup

- Playwright Test is Playwright's own runner, run with `npx playwright test`. A new project is scaffolded with `npm init playwright@latest`, and browsers are installed with `npx playwright install`.
- `playwright.config.ts` holds the run settings: `projects` for browsers and devices, `use` for shared options such as `baseURL` and `trace`, `webServer` to start the app, `retries`, `workers` and `reporter`.
- Built-in features: parallel workers, retries, `--shard=1/4` for splitting across machines, `--ui` for the interactive mode, `npx playwright show-report` for the HTML report, and setup projects that run before dependent projects.
- Record traces in CI with `trace: 'on-first-retry'`, and use the trace viewer rather than videos for CI failures, as Playwright's best practices recommend.

## Writing tests

```typescript
import { test, expect } from '@playwright/test';

test('sign-in shows the dashboard', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('test-user@example.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

- Locators and assertions use `camelCase`: `getByRole`, `getByLabel`, `getByTestId`, and `toHaveText`, `toBeVisible`, `toHaveURL`. Web-first assertions such as `await expect(locator).toBeVisible()` wait for the condition; `expect(await locator.isVisible()).toBe(true)` does not.
- The whole API is asynchronous. A missing `await` lets the test continue, or finish and pass, before the action or assertion runs. Playwright recommends the `@typescript-eslint/no-floating-promises` lint rule; `eslint-plugin-playwright` adds further checks.
- Share setup through fixtures with `test.extend`, not through module-level variables, so parallel workers stay isolated.

## Authentication

Authenticate once in a setup project, save the browser state with `page.context().storageState({ path })` to a file under `playwright/.auth`, and make the testing projects depend on the setup project and use that file as `storageState`. Add `playwright/.auth` to `.gitignore`: the file holds cookies and headers that can impersonate the test account.

## Diagnostics

Open a trace with `npx playwright show-trace trace.zip`, or from the HTML report. Traces, videos and screenshots can contain personal data and tokens; redact them before sharing.
