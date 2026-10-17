# Deterministic gate profiles

Implements I06 from #32/#38. Decision: D-061. Catalog: `config/gates.yaml`, shipped as a
packaged default ([`PACKAGED-DEFAULTS.md`](PACKAGED-DEFAULTS.md)).

The validator role runs deterministic checks against the target repository. Deterministic
evidence outranks model opinion (D-054). The checks are the repository's own scripts, so
they run only after a pre-action approval of the exact command plan
([`APPROVALS.md`](APPROVALS.md)).

## Profiles

| Profile | Selected when | Gates | Prerequisites |
|---|---|---|---|
| `code-conductor` | this source repository (exact package name + CLI source) | typecheck, unit tests, strict repository policy | `npm`, `node_modules`, built CLI |
| `node` | `package.json` (and no more specific profile) | `npm test` | `npm`, `node_modules` |
| `pnpm` | `pnpm-lock.yaml` (replaces `node`) | `pnpm test` | `pnpm`, `node_modules` |
| `yarn` | `yarn.lock` (replaces `node`) | `yarn test` | `yarn`, `node_modules` or `.pnp.cjs` |
| `terraform` | any `*.tf` | `terraform fmt -check -recursive`, `terraform validate` | `terraform`; `.terraform` for validate |
| `terraform-plan` | **only when chosen** | `terraform plan -input=false -lock=false` (advisory) | `terraform`, initialised `.terraform` |
| `ansible` | `ansible.cfg`, `requirements.yml` or `galaxy.yml` | `ansible-lint` | `ansible-lint` |

Choose profiles for a run with `ccon run --gate-profiles terraform,terraform-plan ...`.
Otherwise profiles are detected from repository markers. An unknown name stops the
validator with the list of available profiles. An explicit choice replaces detection,
and the approval summary names any detected profile it leaves out. Readiness never
passes vacuously:
- when nothing applies, it is blocked (`no-applicable-gates`);
- advisory gates alone, for example `--gate-profiles terraform-plan`, never establish it
  (`no-blocking-gate-passed`). Choose a blocking profile too, as in the example above.

## Prerequisites, never installation

Every gate declares what must already be present. A missing tool or missing installed
dependencies make the gate a **blocking failure without executing anything**, advisory
gates included. The evidence names what is missing and what you can do. Code Conductor
never runs `npm ci`, `terraform init` or any other installer for you: install scripts and
provider plugins are repository-chosen code and network fetches that you decide to run.
A gate with unmet prerequisites is listed in the approval summary but is not part of
what runs.

Tools are resolved without a shell or `which`, from **absolute** `PATH` entries only.
The current directory, empty entries and relative entries are never searched, because
the repository under validation could put a binary there. The resolved absolute file is
what runs. It is shown in the approval summary and the evidence, and bound by the
approval digest. Gate processes also see only the absolute `PATH` entries, so tools a gate
starts itself (npm's `#!/usr/bin/env node`, for example) follow the same rule. On Windows only `.exe` and `.com` files run. Batch shims such as
`npm.cmd`, `pnpm.cmd` or `yarn.cmd` would need `cmd.exe`, so those gates report an
unsupported prerequisite instead of running.

In an agent worktree, installed dependencies, `.terraform` and build output exist only
because something in the run created them, possibly the agent. Git ignores them, so the
approval does not bind them. The approval summary says so.

## Bounded, isolated execution

Gate commands run without a shell, in their own session and process group on POSIX. They
have no controlling terminal, so they cannot draw over an approval prompt.
- **Timeout:** each gate has a timeout (default 10 minutes). On timeout, Code Conductor
  terminates the whole process group, then kills it if it has not exited after five
  seconds.
- **Leftover processes:** processes the gate leaves in its group are killed as soon as
  it exits. If a process that left the group still holds the output pipes, Code
  Conductor stops reading after five seconds.
- **Interruption:** gate groups are reaped when Code Conductor exits or is interrupted
  (Ctrl-C, `SIGTERM`, `SIGHUP`), the same as provider clients.
- **Output:** at most 4 MiB is captured per stream, decoded once so multi-byte characters
  are not split. Truncation is stated in the evidence. The evidence `sha256` covers the
  full, untruncated output: SHA-256 over the digests of all stdout and all stderr bytes.

This is containment, not a security boundary: a process running as you can leave the
group ([`APPROVALS.md`](APPROVALS.md)). Windows has no process-group isolation.

## Validation, plan review and apply stay separate

- `terraform` validates formatting and configuration without credentials or a backend.
- `terraform-plan` is explicit and advisory. A plan needs real provider credentials and
  backend state, so it is evidence for human review, not a pass/fail gate, and it is never
  detected automatically.
- **Planning still runs code.** Terraform reads data sources while planning, and provider
  plugins are executables. Programs the configuration defines, such as an `external`
  data source, therefore run with your environment and cloud credentials, and they can
  have side effects. In an agent worktree, the agent may have written that
  configuration. The approval summary for this gate says so; approve only after
  reviewing the configuration the agent changed.
- No gate applies changes. Every gate tool has a fixed shape, and anything else is
  refused, whatever its spelling:

  | Tool | Allowed |
  |---|---|
  | `npm`, `pnpm`, `yarn` | `test`, or `run <script>`, with nothing else (not `run env`, the package manager's own command) |
  | `node` | a script file the repository holds as the first argument (relative, no `..`, nothing under `node_modules`, a hidden folder such as `.yarn`, or a folder whose name ends in a dot, which Windows drops); no options or inline code |
  | `terraform`, `tofu` | at most one `-chdir=<repository subfolder>`, then `fmt` (only with `-check`; `-recursive`, `-diff`, `-no-color`), `validate` (`-no-color`, `-json`), `plan` (needs `-input=false` and `-lock=false`; may add `-no-color`, `-refresh=false`, `-detailed-exitcode`, `-compact-warnings`) or `version` (`-json`); no paths, no `-out` or `-generate-config-out`, no other flags |
  | `ansible-lint` | `--offline` (required: without it, ansible-lint installs what `requirements.yml` names), then `--nocolor`, `--parseable`, `-p`, `-q`, `--strict`; never `--fix` |

  Shells, wrappers (`env`, `sudo`, `setsid`, `npx`, `pnpx`, `bunx`, `terragrunt`, …),
  other interpreters and package executors are not gate tools, because they could run
  anything; neither are auto-approve flags. Supporting another tool means describing its
  shape in `gateCommandProblem` (`packages/policy`). The rules govern the packaged
  catalog, which only maintainers change; gates themselves still run the repository's
  own scripts, which is why they are approved first. A shape fixes the command line, not
  what the tool reads: a tool still follows the repository's own configuration (an
  `.ansible-lint` file can turn on fixes without `--fix`), and gates inherit your
  environment, so variables you set, such as `TF_CLI_ARGS`, apply to them. Command names are compared
  case-insensitively and without `.exe`/`.cmd` extensions. The planner refuses other
  gates, and `ccon validate` rejects them in the catalog (`gates.tool`, `gates.shape`,
  `gates.infrastructure_change`, `gates.auto_approve`, `gates.command`). Production apply belongs to a native pipeline
  with environment protection and its own approval (#32 deployment boundary, C02
  `deployment` action).

## Not covered here

- Gates run in the validation worktree as it exists on disk, including dependencies the
  run created. A fresh checkout of exactly the approved commit, with dependencies you
  installed yourself, would need project bootstrap and is deferred.
- npm, pnpm and yarn gates do not run on native Windows (batch shims, see above). The approval binding's limits are listed in [`APPROVALS.md`](APPROVALS.md).
- Further ecosystems (Python, Go, Rust, PowerShell, Kubernetes/Helm) can be added as
  profiles with the same prerequisite and safety rules when a real repository needs them
  (#15).
