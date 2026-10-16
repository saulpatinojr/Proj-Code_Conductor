# Pre-action approvals

Implements C02 from #32/#44. Decision: [ADR 0013](adr/0013-pre-action-approvals-bound-to-exact-context.md), D-059.

Code Conductor asks a person **immediately before** each consequential action and binds
the answer to the exact context that action will use. Workstation trust, client
installation, a successful smoke test and a final `ready` decision are not approval.

## What is gated

| Action | When | Bound to |
|---|---|---|
| `local_execution` | before starting a provider client process, including every retry | run, task, assignment, attempt, recipient `provider/harness@surface`, working directory, HEAD revision, working-tree content, exact client argv (prompt redacted), surface, authority, billing channel |
| `context_disclosure` | before sending the task prompt and repository access to a provider, including every retry | attempt, recipient, working directory, HEAD revision, working-tree content, prompt SHA-256 and byte length |
| `local_execution` (gates) | before running the target repository's deterministic gate commands | validation directory, HEAD revision, working-tree content, digest of the exact planned commands |
| `commit` | before Code Conductor commits agent changes | agent worktree, HEAD revision, exact Git tree to be committed, agent branch, base SHA, changed-file list |
| `deployment` | API for native pipeline connectors | recipient pipeline/environment plus deployment-specific bindings |

A provider's start and disclosure requests are shown together and recorded separately.
Each recipient needs its own approval, so approving disclosure to one provider never
approves another. A retry is a new process and a new disclosure, so it is approved again
against the then-current working tree; a refused retry is not started. Repository content
is identified by HEAD plus the Git tree of every tracked file and every untracked
non-ignored file. Code Conductor hashes every file into a temporary index seeded from HEAD
without stat data, so stat-cache settings such as `core.checkStat=minimal` cannot hide an
edit, and the repository's own index and files are not changed. Paths outside Git can be
approved, but their content cannot be bound (`unversioned`).

## How a decision is checked

For each action the runtime builds the requests, asks the approver, then rebuilds the
requests and requires identical digests before acting. The action does not run when:

- no approver is available, for example a non-interactive process (`missing`);
- the person declines (`denied`);
- the decision arrives more than 15 minutes after the request was built (`expired`);
- anything bound changed while the request waited, such as a new commit, an edited
  file, a different prompt or recipient (`changed`).

Commits are exact: Code Conductor re-hashes the worktree, refuses if it no longer equals
the approved tree, and otherwise creates the commit from the approved tree object itself
(`git commit-tree` plus a compare-and-swap `update-ref`). No staging step, stat cache or
hook can change what is committed. Whether a commit is needed at all is decided by content,
not `git status`, so an agent edit that preserves size and mtime still needs an approved
commit. Code Conductor never runs repository Git hooks (`pre-commit`, `post-checkout`, a
husky-style `core.hooksPath`, and so on) or a configured `core.fsmonitor` from its own Git
operations: every call sets `core.hooksPath=/dev/null` (on Windows, a private empty
directory under the per-user temporary directory). A hooks path in a shared temporary
directory would not be safe, because its name is visible in process arguments and could be
created by another process or user. Hooks and fsmonitor are repository-controlled
programs, so running them would be unapproved local execution. Every decision is single-use. Nothing reads approval records back as
authority, so a stored record cannot approve a later action, and `cc import` rejects
manifests that carry approval records.

A refused provider start removes the fresh, unused agent worktree. A refused commit
leaves the agent's changes uncommitted in its worktree for review in native Source
Control. The affected assignment is `blocked`, dependent assignments do not run, and the
run's merge decision is `human_required`.

## Using it

`cc run --execute` prompts in the invoking terminal on stderr. Stdout keeps the JSON
result. The prompt shows the action, recipient, repository, revision, every bound value and
the approval digest, then asks you to type a six-character confirmation code derived from
exactly those requests. Input typed before the prompt appeared, such as while a provider
was running, therefore cannot answer it. Any other answer, end of input or Ctrl-C denies.
Displayed values are printed on one line with control, bidirectional-override, zero-width
and line-separator characters replaced, so repository content cannot rewrite or reorder
the prompt. If the approver itself fails, the action is refused (`missing`) and the run
still completes with `human_required`. Dry runs ask nothing because they execute nothing.
There is intentionally no flag that pre-approves or auto-approves.

`cc harness-smoke` is unchanged: it is itself an explicit, single-action command with a
fixed, documented smoke prompt and remains the trust step that must pass before any
execution is offered.

## Evidence

`RunManifest.approvals` stores one `ApprovalRecord` per request. Each record holds the
request digest, action, run, task, assignment, recipient, revision, status, approver
label, timestamps and the human-readable summary. Prompt text and file contents are not
stored, only their digests and sizes. Each decision is also appended to the run's
`events.jsonl` as `approval.decided`. Both live in the owner-private run store.

## Not covered here

- No deployment connector exists yet. Any future deploy, PR-creation or other external
  side-effect path must call `ApprovalGate.authorize` before dispatch (#35, #32
  deployment boundary). Native environment protection rules remain authoritative.
- Commits an agent makes itself inside its isolated worktree happen under that agent's
  own sandbox. Code Conductor preserves them as evidence; it does not commit them again.
- Not bound: the environment variables a provider process inherits (`cc doctor` warns
  about API-key variables that would bypass subscription billing), and ignored files such
  as `.env`, which a provider with repository access may still be able to read. Keep
  secrets out of repositories you hand to an agent.
- The terminal prompt in VS Code's task terminal still needs owner-workstation
  validation (#4).
