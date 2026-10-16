# Packaged defaults and bounded preferences

Implements the C01 configuration boundary from #32/#43; related delivery #56.

Canonical defaults stay in this source repository's `config/*.yaml`. The deterministic
`npm run defaults:package` step copies the seven approved documents to the policy package
and VS Code distribution, with a SHA-256 manifest. Generated assets are ignored in Git,
regenerated before typecheck/build and by Vitest global setup for every test entry point
(including watch mode and IDE runners), and included in the VSIX. Customers do not clone
Code Conductor or create an application `config` directory. Runtime readers verify the
packaged manifest. This is artifact consistency/provenance, not a signature or sandbox.

Planner, gate catalog, MCP catalog and VS Code views use packaged defaults, never arbitrary
application files named `config/roles.yaml` or `config/gates.yaml`. Development changes to
canonical config take effect after rebuilding; application config cannot weaken authority.

## Optional preferences

Precedence is packaged policy, then the current user's `~/.code-conductor/config.json`,
then `<workspace>/.code-conductor/config.json`. Neither optional file is created implicitly.
The version-1 schema deliberately supports only:

```json
{
  "version": 1,
  "rolePreferences": { "builder": ["claude", "codex"] },
  "disabledHarnesses": ["antigravity"]
}
```

`rolePreferences` can reorder/narrow the packaged eligible list for a known role.
Workspace preferences are intersected with user restrictions; disabled harnesses accumulate
and cannot be re-enabled by a workspace. Unknown fields, roles/providers, duplicates, wrong
types/versions, symlinks and files larger than 64 KiB fail closed. An empty eligible set does
not silently fall back to an excluded provider. Workspace preferences are repository-authored:
they may reorder providers within the user's allowed set, and at R1 that can place builder and
reviewer on the same provider because packaged policy only requires different-provider
challenge from R2 upward. Caller options can disable workspace
preferences or explicitly choose/disable the user-root input for controlled environments.

These preferences cannot modify risk classes, required roles, reviewer independence,
authority, execution commands, MCP permissions, billing or trust. Schema constraints are
validated in `packages/policy/src/defaults.ts`; they are not arbitrary YAML merges.
Changing provider preferences still does not grant permission to execute or disclose data.
Pre-action authorization is separate (#44), as is workstation trust.

Every runtime document reports its packaged and applicable overlay paths/hashes through
`loadConfiguration`. `cc workspace-validate <folder>` prints that provenance without running
providers, gates, GitHub operations or APM, and works in an unrelated empty folder. The
existing `cc validate` deliberately remains the stricter Code Conductor source-repository
scaffold/config check used by CI. VS Code Validate uses workspace validation.

## Portable gates and optional tools

A generic Node project gets the `npm test` gate; absence of a working test script is a
failure, not a skipped success. The source-specific Code Conductor profile requires both
the exact `@code-conductor/root` package name and its CLI source marker, so a conventional
`packages/cli` monorepo receives only the generic Node gate. When no profile applies, gate
selection returns a blocking `no-applicable-gates` failure with zero commands executed. Terraform and Ansible
profiles remain available. Profiles select validation commands, not authorization to run
untrusted project scripts. An unknown project still needs a suitable validation profile;
no detected gates must not be represented as proof that a change was tested.

APM is optional in both extension and CLI startup diagnostics. Node, Git and GitHub CLI
remain baseline workstation prerequisites. Doctor configuration checks no longer require
the customer's repository to contain Code Conductor development docs or an APM manifest.

## Verification

Tests cover empty unrelated workspaces, ignored malicious legacy config, preference
precedence and restrictions, malformed/oversized/symlink inputs, portable Node gates and
source-to-distribution byte/hash equality. The build asserts essential defaults exist.
A separate disposable distribution smoke test copies only the bundle and defaults and
runs workspace validation outside the source tree. This does not claim native VS Code UI,
provider authentication or real R1/R2 tasks passed on the owner's workstation.

The isolated bundle check exposed a pre-existing ESM/CommonJS builtin-loading failure
(`Dynamic require of "process"`). The build now uses esbuild's JavaScript API with
Node's `createRequire` in its ESM banner, and every normal build executes the isolated
bundle smoke test. Packaging-only file existence assertions could not detect this.

Primary references: https://esbuild.github.io/api/#banner
https://nodejs.org/api/module.html#modulecreaterequirefilename

The same smoke also detected unresolved dynamic AJV/format imports and an unshipped
contract-schema asset. Static dependency imports now allow bundling; the canonical schema
is copied into the distribution. Neither a global AJV install nor source-tree schema files
are required by the installed runtime.
