# The dogfood fixture repository

Code Conductor's own quick test runs ("dogfood" runs) use a tiny separate repository, so a
practice run never touches this one. This page says what it is, where it lives, how to use
it, and how to rebuild it from scratch if it is ever deleted.

| | |
|---|---|
| Repository | [`saulpatinojr/Proj-Code_Conductor_Fixture`](https://github.com/saulpatinojr/Proj-Code_Conductor_Fixture) |
| Former name | `cc-dogfood-fixture` (renamed 2026-10-21 to follow the `Proj-<Product>_<Part>` naming of `Proj-Code_Conductor`, `Proj-Code_Workflow` and `Proj-Agent_Packs`) |
| Used by | This repository only: the first-run and dogfood steps in [`WORKSTATION-VALIDATION.md`](WORKSTATION-VALIDATION.md) section 12 and the beta-feedback item in [`STATUS.md`](STATUS.md) |
| Owner action needed | None to use it, but see **Archived?** below |

GitHub keeps redirecting the old name to the new one (web pages and `git` URLs alike) until
someone creates a new repository with the old name, so an old clone keeps working.

## Why it is a separate repository

A run creates an isolated Git worktree on a `cc/<task>/<agent>` branch, and
`ccon pr --create` pushes that branch and opens a draft pull request
([`WORKTREES.md`](WORKTREES.md), [`GITHUB.md`](GITHUB.md)). That needs a repository of its
own: a folder inside this repository cannot be its own Git repository. Pointing practice
runs at this repository instead would mix throwaway branches and pull requests into the real
project.

## What is in it

| File | Purpose |
|---|---|
| `AGENTS.md` | The rules an agent reads: keep every change to one function and one test, add no dependencies |
| `README.md` | Three suggested objectives (below) |
| `math.js` | Three one-line functions: `add`, `subtract`, `multiply` |
| `math.test.js` | Tests for `add` and `subtract` |
| `package.json` | `npm test` runs Node's built-in runner (`node --test`); no dependencies |
| `node_modules/.gitkeep` | An empty file, committed on purpose |

The empty `node_modules/.gitkeep` is deliberate. The Node gate needs a `node_modules` folder
to exist, and Code Conductor never installs dependencies into an agent worktree (D-061), so
the folder is committed empty and the gate's prerequisite is met without installing anything.
Do not remove it.

## How to use it

You need Node.js 22 or newer, Git, and Code Conductor installed ([`INSTALL.md`](INSTALL.md)).

1. Clone it somewhere **outside** `~/.code-conductor`, for example next to your other
   repositories:

   ```bash
   git clone https://github.com/saulpatinojr/Proj-Code_Conductor_Fixture.git
   cd Proj-Code_Conductor_Fixture
   npm test        # should pass in about a second
   ```

2. Run Code Conductor against it. Without `--execute` it only plans and saves the run;
   it does not start any paid client:

   ```bash
   node "$CC_JS" run --repo . --risk R1 --objective "Add a test for multiply() in math.test.js; do not change math.js"
   ```

   Add `--execute` only after the checks in [`WORKSTATION-VALIDATION.md`](WORKSTATION-VALIDATION.md)
   pass. `$CC_JS` is the path to the extension's `ccon.js`, explained in that document.

3. To take a run all the way to a draft pull request, follow section 12 of that document:
   `node "$CC_JS" next`, then `pr`, then `pr --create`.

Suggested objectives, from the fixture's README:

- "Add a test for subtract() with positive, negative and zero operands in math.test.js; do not change math.js" (already done: `math.test.js` now has it)
- "Add a test for multiply() in math.test.js; do not change math.js"
- "Add a divide(a, b) function to math.js that throws on division by zero, with a test"

Everything Code Conductor writes during a run stays under `~/.code-conductor`
([`INSTALL.md`](INSTALL.md)), apart from the `cc/...` branches and Git's own worktree
bookkeeping inside the fixture's repository.

## Archived?

The owner may archive the fixture to keep the account tidy. An archived repository is
read-only: `git push` is refused, so a run can plan and make its worktree but
`ccon pr --create` cannot push its branch or open a pull request.

To use it again, open the repository's **Settings** page, scroll to the **Danger Zone**,
and choose **Unarchive this repository**
([GitHub: archiving repositories](https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories)).
Archive it again when you are done.

## Rebuilding it from nothing

If the repository is ever deleted, create a new public repository named
`Proj-Code_Conductor_Fixture` and add these files. Nothing else is needed.

`package.json`

```json
{
  "name": "cc-dogfood-fixture",
  "version": "1.0.0",
  "private": true,
  "description": "A three-file Node project for Code Conductor dogfood runs: no dependencies, Node's built-in test runner, one gate that finishes in a second.",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

`math.js`

```js
export function add(a, b) { return a + b; }
export function subtract(a, b) { return a - b; }
export function multiply(a, b) { return a * b; }
```

`math.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract } from './math.js';

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('subtract handles positive, negative and zero operands', () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(-5, -3), -2);
  assert.equal(subtract(5, -3), 8);
  assert.equal(subtract(-5, 3), -8);
  assert.equal(subtract(5, 0), 5);
  assert.equal(subtract(0, 5), -5);
  assert.equal(subtract(0, 0), 0);
});
```

`AGENTS.md`

```markdown
# Proj-Code_Conductor_Fixture

A tiny Node project used only to exercise Code Conductor runs (R1, R2, gate output modes).

- No dependencies: `npm test` runs Node's built-in test runner (`node --test`).
- `node_modules/.gitkeep` is committed so the Node gate's prerequisite is met without installing anything.
- Keep every change small: one function, one test. The point is the run, not the code.
```

`README.md`: the title, one sentence saying it is a fixture for Code Conductor dogfood runs
(see `AGENTS.md`), and the three suggested objectives above.

`node_modules/.gitkeep`: an empty file.

The text above is a copy of what the repository held on 2026-10-21. The package name inside
the original `package.json` still reads `cc-dogfood-fixture`; the name there does not matter
to Code Conductor.
