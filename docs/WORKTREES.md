# Agent worktrees and native diff review

Implements I04 from #32/#36. Decision: D-062. It builds on ADR 0005 (preserve agent work),
C02 approvals ([`APPROVALS.md`](APPROVALS.md)) and C03 native review
([`NATIVE-INTERFACES.md`](NATIVE-INTERFACES.md)).

## Isolation

Every modifying assignment gets its own linked Git worktree. It lives under
`~/.code-conductor/worktrees` (or `$CODE_CONDUCTOR_HOME/worktrees`) on a
`cc/<task>/<agent>` branch created from the repository's HEAD. Your checkout, its index
and your branches are never modified. Code Conductor refuses to commit anywhere that is
not its own agent worktree on its own agent branch (#48).

The run manifest records each worktree's path, branch and base (`RunManifest.worktrees`).
`cc next` and the VS Code Runs view open it in native Source Control.

## Commits

Code Conductor commits agent changes only after a commit approval bound to the exact tree.
It commits that tree with its own identity, never signed with your key, and never runs
repository hooks. Before asking, it refuses two kinds of change:

- **Sensitive paths**, such as `.env`, private keys and Terraform state, anywhere in the
  change set.
- **New credential-looking strings** in changed text files up to 1 MiB: private keys and
  AWS, GitHub, Slack, Google, Anthropic, OpenAI, Stripe and Azure storage key formats.
  Findings are reported as `path:line kind`, never by value, and values already present
  in the base revision are not reported. A refusal leaves the changes uncommitted in the
  worktree for you to review. If a finding is a false positive, commit it yourself after
  review.

The same two checks cover commits the agent made itself. Every path any of them touched
is checked, and each commit is scanned against the base, so a credential that a later
commit removed is still found: its content stays in history. Such a branch is blocked,
and Code Conductor commits nothing on top. Histories longer than 20 commits are scanned at
the branch head only, and the result records that limit as a risk.

GitHub push protection and your secret scanning service remain the native, authoritative
checks. This local scan stops an agent's credential from being committed in the first
place.

## Retention and cleanup

Worktrees and branches are **kept** by default, so agent work is never silently
discarded.

- `cc worktrees [--run <runId>]` lists recorded worktrees: clean or dirty, branch, base
  and run.
- `cc worktrees --remove-clean` removes only clean worktrees under the Code Conductor root
  that are on a `cc/` branch. **Branches, and so the agent's commits, are kept.** Delete a
  branch yourself with Git once it is merged or no longer needed.
- `cc run --cleanup-worktrees` applies the same rule at the end of a run. Dirty worktrees
  are retained and reported in the run's events, and cleanup never hides or changes the
  run's outcome.

A worktree that was never used, because its start was not approved, is removed together
with its empty branch.

## Provider environment

Provider clients run in an isolated process group (see [`APPROVALS.md`](APPROVALS.md)).
They get your environment minus:

- **Separately billed API credentials:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `PERPLEXITY_API_KEY` and `KIRO_API_KEY`. A stray key therefore cannot silently switch a
  subscription client to metered billing (`subscription_first`,
  `allow_separately_billed_api: false`). `cc doctor` still warns when such a variable is
  set in your shell.
- **Git's repository-local variables** (`GIT_DIR`, `GIT_INDEX_FILE`, ...), so a client's own
  Git commands cannot be redirected to another repository.

Subscription sign-in state stays in each official client.
