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
edit, and the repository's own index and files are not changed. A sparse-checkout
(skip-worktree) path keeps its HEAD content only while it is absent from disk; a file that
is present is hashed like any other, so setting that index bit cannot hide an edit. Paths
outside Git can be approved, but their content cannot be bound (`unversioned`).

## How a decision is checked

For each action the runtime builds the requests, asks the approver, then rebuilds the
requests and requires identical digests before acting. The action does not run when:

- no approver is available, for example a non-interactive process (`missing`);
- the person declines (`denied`);
- the decision arrives more than 15 minutes after the request was built (`expired`);
- anything bound changed while the request waited, such as a new commit, an edited
  file, a different prompt or recipient (`changed`).

Commits are exact, and there is no unapproved commit path. Code Conductor re-hashes the
worktree and refuses if it no longer equals the approved tree, or if the branch moved from
the approved HEAD. Otherwise it creates the commit from the approved tree object itself
(`git commit-tree` plus a compare-and-swap `update-ref`). No staging step, stat cache or
hook can change what is committed, and changes made only in Git's index (for example
force-adding an ignored file) are never committed. Whether a commit is needed at all is
decided by content, not `git status`. An agent edit that preserves size and mtime still
needs an approved commit, and so do new folders or untracked files hidden by
`status.showUntrackedFiles=no`. The displayed file list, the sensitive-path check and the
bound tree all come from the same snapshot. Every Code Conductor Git call ignores replace
refs (`--no-replace-objects`), so a `refs/replace/*` entry cannot make the listed files
differ from the tree that is committed, and submodule pointer changes are listed even when
`.gitmodules` says to ignore them. Code Conductor's commits use its own identity, even
when `GIT_AUTHOR_*` or `GIT_COMMITTER_*` variables are inherited, and are not signed with
your key.

Code Conductor never runs repository Git hooks (`pre-commit`, `post-checkout`, a
husky-style `core.hooksPath`, and so on) or a configured `core.fsmonitor` from its own Git
operations. Every call points `core.hooksPath` at an existing non-directory, under which
no hook can exist: `/dev/null` on POSIX, and the running executable on Windows. A hooks
path in a shared temporary directory would not be safe, because its name is visible in
process arguments and could be created by another process or user. Hooks and fsmonitor
are repository-controlled programs, so running them would be unapproved local execution.

Git configuration defines further programs that Code Conductor's own `git add` runs
(clean and process filters), and grafts or a shallow file change which history Git
reports. Code Conductor therefore takes a digest of the effective configuration of every
scope, includes followed, and of `info/attributes`, `info/grafts`, `shallow` and
`objects/info/alternates` before each provider starts. It checks the digest again before
a retry, after the provider finishes, and right before committing. If anything changed,
Code Conductor stops the run without running further Git operations under configuration
it has not seen. The assignment and every later one are `blocked`, the run is
`human_required`, and agent changes stay uncommitted. Only the digest is kept, because
configuration can hold credentials. Tools an agent runs can change shared configuration
legitimately, for example `husky` setting `core.hooksPath` during `npm install`. Those runs
stop too, because the change also affects your own checkout.

Commits the agent makes itself happen under its own sandbox, not through an approval
here. Code Conductor names them in the commit approval, the result's risks and its
evidence, and checks every path any of them touched, including paths a later commit
removed again, because their content stays in history. A sensitive path in that history
blocks the assignment, and Code Conductor commits nothing on top. Agent-made commits
always make the run `human_required`.

Every decision is single-use. Nothing reads approval records back as
authority, so a stored record cannot approve a later action, and `cc import` rejects
manifests that carry approval records.

A refused provider start removes the fresh, unused agent worktree. A refused commit
leaves the agent's changes uncommitted in its worktree for review in native Source
Control. The affected assignment is `blocked`, dependent assignments do not run, and the
run's merge decision is `human_required`.

On POSIX, provider clients run in their own session and process group, without a
controlling terminal. They cannot open `/dev/tty` or inject keystrokes into the approval
prompt. Processes they leave in their group are terminated when they exit, or when Code
Conductor exits or is interrupted. A client that ignores `SIGTERM` after its timeout is
killed after five seconds. If a descendant keeps the client's output pipes open after the
client exits, Code Conductor stops reading after five seconds rather than wait for it.

This is containment, not a security boundary. A process running as you can start its own
session to leave the group. It can also write to your terminal through `/proc`, for
example to print text that looks like part of a prompt. Approval integrity does not depend
on containment. What is committed is re-hashed and compared with the approved tree and
HEAD. Gate commands, however, run
on the validation worktree as it is on disk, so a process that outlived its client could
change files between approval and execution (see below). Windows has no process-group
isolation: only the client process itself is terminated.

## Using it

`cc run --execute` prompts in the invoking terminal on stderr. Stdout keeps the JSON
result. The prompt shows the action, recipient, repository, revision, every bound value and
the approval digest, then asks you to type a six-character confirmation code derived from
exactly those requests. Input typed before the prompt appeared, such as while a provider
was running, therefore cannot answer it. Any other answer, end of input or Ctrl-C denies.
Displayed values are printed on one line with control, bidirectional-override, zero-width
and line-separator characters replaced. Other non-ASCII characters are shown as
`\u{...}` escapes, so look-alike letters cannot disguise a path or recipient. Long values
are truncated with a visible marker; the full value is still bound by the digest. A commit
summary starts with the number of changed files and the number that can change what later
runs. Those files are listed first: CI, Git hooks and hook managers, scripts and
executables, dependencies and package-manager settings, Git behaviour files, and agent,
editor or dev-container configuration such as `AGENTS.md`, `.claude/`, `.mcp.json` and
`.vscode/`. So even a truncated summary says how many such files are behind the cut.
Repository content therefore cannot rewrite or reorder what you approve. If a summary is
truncated, review the full diff before approving. If the approver itself fails, the action is refused (`missing`) and the run
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
- Commits an agent makes itself are not approved here, only reported and checked for
  sensitive paths (see above). Their content is not scanned for secrets yet; that is
  tracked under #36.
- Gate commands run in the validation worktree as it is on disk. The approval binds
  tracked and untracked non-ignored content, but not ignored files the agent wrote,
  working trees of nested repositories or submodules (only their commit pointers),
  symlink targets outside the tree, or differences Git normalises on `add` (`text`/`eol`,
  `ident`, configured clean filters). Running gates in a fresh checkout of the approved
  commit would close this, but needs project bootstrap such as dependency installation;
  it is tracked under #38.
- Computing working-tree identity runs `git add`, so clean/process filters configured in
  your Git config (for example Git LFS) run as they would on any `git add`. A repository's
  `.gitattributes` can select a configured filter but cannot define a new filter program,
  and a provider that defines one stops the run (see above). The check runs at fixed
  points. A process that outlived its client and changes configuration between a check
  and the Git operation after it is not detected.
- `core.hooksPath` disables Git's hook directory. If a future Git release adds hooks
  defined directly in configuration, re-check this boundary before upgrading.
- Not bound: the environment variables a provider process inherits (`cc doctor` warns
  about API-key variables that would bypass subscription billing), and ignored files such
  as `.env`, which a provider with repository access may still be able to read. Keep
  secrets out of repositories you hand to an agent.
- The terminal prompt in VS Code's task terminal still needs owner-workstation
  validation (#4).
