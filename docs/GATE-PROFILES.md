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

Choose profiles for a run with `cc run --gate-profiles terraform,terraform-plan ...`.
Otherwise profiles are detected from repository markers. An unknown name stops the
validator with the list of available profiles. When nothing applies, readiness is blocked
(`no-applicable-gates`); it never passes vacuously.

## Prerequisites, never installation

Every gate declares what must already be present. A missing tool (looked up on `PATH`
without running a shell or `which`) or missing installed dependencies make the gate a
**blocking failure without executing anything**. The evidence names what is missing and
what you can do. Code Conductor never runs `npm ci`, `terraform init` or any other
installer for you: install scripts and provider plugins are repository-chosen code and
network fetches that you decide to run. A gate with unmet prerequisites is listed in the
approval summary but is not part of what runs.

## Bounded, isolated execution

Gate commands run without a shell, in their own session and process group on POSIX. They
have no controlling terminal, so they cannot draw over an approval prompt. Each gate has
a timeout (default 10 minutes). On timeout, Code Conductor terminates the whole process
group, then kills it if it does not exit. Any process the gate leaves behind is also
terminated when it finishes. At most 4 MiB of output is captured per stream; truncation
is stated in the evidence, and the evidence hash covers what was captured.

## Validation, plan review and apply stay separate

- `terraform` validates formatting and configuration without credentials or a backend.
- `terraform-plan` is explicit and advisory. A plan needs real provider credentials and
  backend state, so it is evidence for human review, not a pass/fail gate, and it is never
  detected automatically.
- Nothing applies changes. The planner refuses any gate that runs `terraform`/`tofu`
  `apply`, `destroy`, `import`, `taint`, `untaint`, `state`, `force-unlock`, `workspace`,
  `login` or `logout`, or that passes an auto-approve flag. `cc validate` rejects such
  gates in the catalog (`gates.infrastructure_change`, `gates.auto_approve`), and gate
  commands must be plain executable names. Production apply belongs to a native pipeline
  with environment protection and its own approval (#32 deployment boundary, C02
  `deployment` action).

## Not covered here

- Gates run in the validation worktree as it exists on disk. A fresh checkout of exactly
  the approved commit would need project bootstrap (dependency installation) and is
  deferred. The approval binding's limits are listed in [`APPROVALS.md`](APPROVALS.md).
- Further ecosystems (Python, Go, Rust, PowerShell, Kubernetes/Helm) can be added as
  profiles with the same prerequisite and safety rules when a real repository needs them
  (#15).
