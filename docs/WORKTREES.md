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
- **New credential-looking strings** in changed files: private keys (including PGP) and
  AWS, GitHub, GitLab, npm, Slack, Google, Anthropic, OpenAI, Perplexity, Hugging Face,
  Stripe and Azure storage key formats. Every changed file is read in full, whether text,
  binary or UTF-16 (with a byte-order mark), and whatever its name. Compressed content
  (archives, `.docx`, gzip) is not unpacked, and UTF-16 without a byte-order mark is not
  decoded. Findings are reported
  as `path:line kind`, never by value, and values the base revision already had at the
  same path are not reported. A refusal leaves the changes uncommitted in the worktree
  for you to review. If a finding is a false positive, commit it yourself after review.
- **Content it could not scan.** One scan reads at most 64 MiB. Files past that budget are
  named, and Code Conductor refuses to commit them rather than pass them unscanned.

The same checks cover commits the agent made itself. Every path any of them touched is
checked, and every file version they introduced is scanned, so a credential that a later
commit removed is still found: its content stays in history. Their commit messages and
author fields are scanned too, because a push publishes them. Such a branch is blocked,
and Code Conductor commits nothing on top. There is no commit-count limit; history past
the scan budget is blocked too.

GitHub push protection and your secret scanning service remain the native, authoritative
checks. This local scan stops an agent's credential from being committed in the first
place.

## Retention and cleanup

Worktrees and branches are **kept** by default, so agent work is never silently
discarded.

- `cc worktrees [--run <runId>]` lists recorded worktrees with their branch, base and run:
  `CLEAN` when removing it loses nothing, otherwise `KEEP` and the reason.
- `cc worktrees --remove-clean` removes only `CLEAN` worktrees. **Branches, and so the
  agent's commits, are kept.** Delete a branch yourself with Git once it is merged or no
  longer needed.
- `cc run --cleanup-worktrees` applies the same rule at the end of a run. Kept worktrees
  are reported in the run's events, and cleanup never hides or changes the run's outcome.

A worktree is clean only when all of the following hold:

- it is a linked worktree under the Code Conductor root, after resolving symlinks;
- it has exactly its own `cc/` agent branch checked out, so no commit in it is left
  reachable from no branch (a detached HEAD or another branch keeps it);
- its content matches that branch's head exactly. This is compared by content, not by
  `git status` alone, so an edit hidden from Git's stat cache keeps the worktree.

Removal uses `git worktree remove`. That also deletes ignored files in the worktree, such
as a local `.env` or build output. It removes only that worktree's own registration and
never prunes other worktrees, including your own whose directory is temporarily missing.

**When no Git runs at all.** Checking or removing a worktree runs Git in it, including any
clean filters its configuration defines. So nothing is checked or removed in two cases:

- **The run stopped because Git configuration or history files changed.** `cc worktrees`
  prints `INSPECT` and the `git -C <path> config --list --show-origin` command to start
  with. A run with `--cleanup-worktrees` keeps the worktree.
- **The run has no recorded outcome**, because it is still running or was interrupted.
  `cc worktrees` prints `ACTIVE`.

A worktree that was never used, because its start was not approved, is removed together
with its empty branch, unless Git configuration had already changed.

## Provider environment

Provider clients run in an isolated process group (see [`APPROVALS.md`](APPROVALS.md)).
They get your environment minus the following.

**Separately billed API credentials** (`subscription_first`,
`allow_separately_billed_api: false`):

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`,
  `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN` and
  `AWS_BEARER_TOKEN_BEDROCK`;
- `OPENAI_API_KEY` and `CODEX_API_KEY`;
- `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `PERPLEXITY_API_KEY`.

**Variables that select a separately billed provider, endpoint or credential source:**

- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `CLAUDE_CODE_USE_MANTLE` and `CLAUDE_CODE_USE_ANTHROPIC_AWS`;
- `ANTHROPIC_BASE_URL`;
- `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_ORGANIZATION_ID`.

Claude Code ranks all of these above a subscription `/login`
([authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)).

**Git's repository-local variables** (`GIT_DIR`, `GIT_INDEX_FILE`, ...), so a client's own
Git commands cannot be redirected to another repository.

`cc doctor` warns when any of the billing variables is set in your shell.

Kept on purpose:

- **Subscription credentials**, such as `CLAUDE_CODE_OAUTH_TOKEN`.
- **`KIRO_API_KEY`.** Kiro draws its usage from the subscription's credits, and a browser
  sign-in takes precedence over it
  ([Kiro authentication](https://kiro.dev/docs/getting-started/authentication/)).

**Not affected:** credentials a client reads from its own configuration, such as Claude
Code's `apiKeyHelper`, a settings-file `env` block, or an active Anthropic profile file. So
are other credentials in your environment, such as `GH_TOKEN`, cloud SDK credentials and
`SSH_AUTH_SOCK`. Check which method a client actually uses with its own status command,
for example `claude auth status`. Subscription sign-in state stays in each official
client.
