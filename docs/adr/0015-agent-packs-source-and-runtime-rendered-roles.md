# ADR 0015 — Agent Packs is the only pack source; Code Conductor ships roles, not agents

- **Status:** Accepted
- **Date:** 2026-10-19
- **Decided by:** repository owner (explicit direction on 2026-10-19: the packs in Code Conductor are for testing only; the true packs come from the Agent Packs repository through APM, for both products; the difference between the products is runtime and IDE)
- **Related:** ADR 0003, ADR 0011, D-035, D-057, D-058, issues #4, #13, #14
- **Sibling repositories:** [`saulpatinojr/Proj-Agent_Packs`](https://github.com/saulpatinojr/Proj-Agent_Packs), [`saulpatinojr/Proj-Code_Workflow`](https://github.com/saulpatinojr/Proj-Code_Workflow)

## Context

The owner maintains three repositories:

- **Agent Packs** holds the specialists: 20 APM packs (`apm.yml` plus `.apm/`), shared primitives, a validator that installs every pack for six targets on each pull request, and a release workflow that tags `<pack>-v<version>`. It has no runtime.
- **Code Workflow** is the product for a person with no IDE and no runtime: an installer and a generator that copy the packs into each client's profile and write that client's orchestrator from the packs found there. The packs never change; the orchestrator does.
- **Code Conductor** (this repository) is the product for a person in an IDE: the VS Code extension and the bundled runtime that spawn the clients, isolate work in worktrees, bind approvals, run gates and decide readiness. Kiro IDE and Antigravity IDE follow after 1.0.

Until this decision, Code Conductor carried eleven agent files in `.apm/agents/` (`conductor`, `spec-lead`, `researcher`, `builder`, `reviewer`, `challenger`, `security-reviewer`, `validator`, `github-gatekeeper`, `arbiter`, `finalizer`), projected into `.claude/agents/`, `.codex/agents/`, `.github/agents/` and `.kiro/agents/`. A review on 2026-10-19 found:

1. The runtime never read them. The prompt an assignment receives is built in `assignmentPrompt` (`packages/runtime/src/execute.ts`) from the role name, the stance, the authority list and the objective; the role's rules existed only in the agent file. Claude Code starts with `--setting-sources user` (D-065), so the projected project agents were not even loaded. In the first R1 dogfood (#4) the reviewer therefore received no reviewer rules beyond `Role: reviewer. Stance: critical.`
2. Five of the eleven (`builder`, `reviewer`, `security_reviewer`, `spec_lead`, `researcher`) were generic restatements of what the packs' experts already are (reviewers, security reviewers, architects); `validator` is not an agent at all but the `internal-validator` harness. The other five (`conductor`, `arbiter`, `finalizer`, `github_gatekeeper`, `challenger`) are orchestration roles, Manager, Judge and Auditor, whose rules belong to whichever orchestrator runs the work.
3. Code Conductor pinned APM 0.30.0 (D-035) while Agent Packs and the owner's workstation use 0.33.0; the packs target `gemini` where this repository targets `antigravity`. Two products that must install the same packs cannot run different package managers.

## Decision

1. **Agent Packs is the single source of specialist agents, skills, instructions and prompts for both products.** Code Conductor ships no agent files. `.apm/` in this repository holds only Code Conductor's own skills (the protocol, the review skills); any agent file that appears here is a test fixture, never product. Specialists reach a client through an APM install of a pack from Agent Packs, pinned as `apm-policy.yml` requires.
2. **Roles are runtime vocabulary, rendered by the runtime.** `config/roles.yaml` keeps the eleven roles with their authority and gains `instructions`: a short list of one-line rules per role. `assignmentPrompt` renders them after the role line as `Role rules:`, before the handoff block and the result marker, for every client alike. `ccon validate` refuses a rule that is not a non-empty single line of at most 300 characters, or a list longer than 12 (`roles.instructions`), and the runtime refuses the same before any prompt is built, because a line break in a rule could forge the handoff block or the `CC_RESULT_JSON` marker in every assignment. User and workspace preferences can narrow roles as before (C01) and may also set `instructions`, under the same check.
3. **The orchestration roles are shared with Code Workflow as orchestrator content, not as agents.** Code Workflow's orchestrator templates are generated per client from the packs found there; they gain the Manager, Judge and Auditor rules (stance per node, risk class to required nodes, a node never reviews its own output, an arbiter node, a GitHub gatekeeper node). Readiness stays with Code Conductor (ADR 0011): the finalizer's verdict is never generated into Code Workflow.
4. **APM is pinned to the same version in both products, 0.33.0 now.** D-035's rule stands, pinned, deliberately upgraded, but the version is shared with Agent Packs (`tooling/apm-version.txt`); a bump there is a bump here in the same week. Agent Packs' weekly watch workflow is the trigger.
5. **The product boundary is surface, not governance.** A person chooses Code Workflow when they have no IDE and want no runtime, and Code Conductor when they work in VS Code (later Kiro IDE and Antigravity IDE). Governance differences follow from the runtime; they are not what the products are for. ADR 0011's "Best for" wording is read this way from now on.

## Consequences

- The projections `.claude/agents/`, `.codex/agents/`, `.github/agents/` and `.kiro/agents/` are removed, and `apm.lock.yaml` was re-materialized with APM 0.33.0: the lockfile format is unchanged (`lockfile_version: '1'`), only the agent deployments are gone, and `apm audit --ci` passes 31 of 31 checks on the new lock.
- Every spawned agent now receives its role rules. The next R1 run on the owner's workstation (#4) is the live check that the reviewer and builder prompts carry them.
- `ccon agents` and `ccon doctor` still inventory provider-native agents, now expecting pack agents installed in the user profile, which is how Code Workflow places them. Project-scope agent files in a consumer repository are reported as before.
- Issue #13 (legacy corpus migration) becomes a dependency on Agent Packs rather than work in this repository: the corpus is migrated there, with lineage; Code Conductor consumes the result.
- A `dependencies.apm` entry on Agent Packs needs a tag or a commit to pin to; Agent Packs has no tags yet. That is the next step on the Packs side, not a reason to loosen `require_pinned_constraint`.
- `README.md`, `STARTER.md`, `AGENTS.md` section 10, `CONTRIBUTING.md`, the Copilot review skill and `docs/IMPLEMENTATION-PLAN.md` no longer describe `.apm/` as the canonical agent source.

## Validation

- `tests/runtime/handoff.test.ts`: the reviewer's rules are rendered in order between the role line and the harness line, before the handoff block and the result marker; every planned role has rules; a rule with a line break is refused.
- `tests/policy/policy.test.ts`: `roleInstructionsProblem` and `validatePolicyObjects` accept only a short list of one-line strings.
- `apm install` with APM 0.33.0 re-materialized the lock from `.apm/skills` only; `apm audit --ci --policy ./apm-policy.yml --no-fail-fast` passed 31 checks (2026-10-19, owner's workstation). The CI pin moves to 0.33.0 in `apm-audit.yml` and `apm-materialization.yml`; this pull request's APM audit job is the GitHub Actions validation of the pin.
- Live validation of the rendered rules is the next R1 dogfood run under #4.
