# ADR 0014 — Name the command-line interface `ccon`

- **Status:** Accepted
- **Date:** 2026-10-16
- **Related issues:** #8 (thin VS Code extension and optional CLI), #33 (packaged extension and bundled runtime)
- **Supersedes:** the CLI name `cc` used in D-048 and D-056 to D-066 (not the C compiler in D-066 or the `cc/` branches in D-062); the decisions themselves stand

## Context

The command-line interface has been called `cc` since the foundation (`packages/cli` declared
`"bin": { "cc": "dist/index.js" }`). On most Linux and macOS systems `cc` is the system C
compiler. On the Ubuntu 24.04 build host used for this change, `/usr/bin/cc` resolves to
`/usr/bin/x86_64-linux-gnu-gcc-13` (`cc --version`: GCC 13.3.0). The clash had three costs:

- **It could not go on `PATH`.** Putting Code Conductor's `cc` ahead of the compiler would break
  every build that calls `cc`, so the extension never adds it (D-066). Commands copied from the
  extension name its bundled runtime instead (`node '<extension>/dist/cc.js' …`).
- **Documentation was ambiguous.** `cc run`, `cc doctor` and `cc validate` read like compiler
  invocations, and a person pasting one into a shell where the CLI is not installed runs the
  compiler. The compiler then fails with an unrelated error.
- **A future standalone distribution (D-056) could not use the name.** A package that installs a
  `cc` binary shadows or is shadowed by the compiler.

The CLI is not published (every workspace package is `private`), and no release exists yet, so
no installed users depend on the name. Renaming now costs one change across the tree. After the
first release it would also strand published commands, documentation and muscle memory.

## Decision

1. The command is **`ccon`**. `packages/cli` declares `"bin": { "ccon": "dist/index.js" }`, and
   usage text and messages name it.
2. The runtime bundled in the extension is **`dist/ccon.js`**, in the build, the VSIX `files`
   allowlist, the installed-package smoke, the release preflight and the SBOM check.
3. Next actions offer `ccon …` commands, and the extension rewrites those (and only those) to its
   bundled runtime when it copies them.
4. The repository's npm scripts are `ccon:validate`, `ccon:doctor` and `ccon:plan`.
5. **Unchanged:**
   - the `cc/` namespace of agent branches. Worktree cleanup recognises existing worktrees by it
     (D-062), and it never runs as a command;
   - internal `cc-*` temporary-directory prefixes;
   - accepted ADRs and the wording of earlier decisions. D-068 records that the CLI `cc` in D-048
     and D-056 to D-066 means `ccon`.
6. **No `cc` alias.** An alias would bring the clash back, and there are no users to migrate.

### Alternatives considered

- **`codecon`.** Taken on npm: `codecon@1.0.1` exists and installs its own `codecon` binary, so a
  later standalone package could not use the name without colliding.
- **`code-conductor`.** Unambiguous, but long to type for a command run many times a day.
- **Keep `cc` off `PATH` forever.** This is what D-066 did. It avoids shadowing the compiler but
  leaves every documented command ambiguous, and rules out a standalone CLI.
- **`ccon`.** Short, not a common system command, and `npm view ccon` returned 404 (no such
  package) on 2026-10-16. **Chosen** by the repository owner.

## Consequences

- **Positive:** documented commands no longer read as compiler invocations, and a future
  standalone CLI can install `ccon` on `PATH` without shadowing anything.
- **Migration:** contributors run `npm run ccon:validate` instead of `npm run cc:validate`. Copied
  extension commands name `dist/ccon.js`. Local run records keep working: they store the
  agent-branch names, which are unchanged, and the commands are rebuilt each time `ccon next`
  runs.
- **Compatibility:** the extension and the runtime ship together in one `.vsix`, so they cannot
  disagree about the file name.
- **Security:** no boundary changes. From a next action, the extension still starts only the
  read-only `ccon next` and `ccon handoff` (D-060), and it still puts nothing on `PATH`.
- **Negative:** branch names (`cc/<task>/<role>`) and the command (`ccon`) no longer share a
  prefix. This is accepted to keep existing worktrees recognised.

## Validation

- `npm ci --ignore-scripts`, `npm run typecheck`, `tsc -b --force` and `npm test` (452 tests;
  the same count as before the rename, with the expectations updated).
- `node packages/cli/dist/index.js validate .`, plus a stable `package-lock.json` after
  regeneration with npm 11.19.1 (only the workspace's `bin` entry changes).
- The packaged `.vsix` holds the same 18 files, with `extension/dist/ccon.js`, and the
  installed-package smoke (`scripts/smoke-vscode-bundle.mjs --extension`) passes.
- `cc --version` on the build host reports GCC 13.3.0 at `/usr/bin/cc`.
- `npm view ccon` returns 404, and `npm view codecon` reports version 1.0.1 with a `codecon` bin
  (both 2026-10-16).
