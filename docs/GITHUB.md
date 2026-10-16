# GitHub pull requests and checks

Implements I03 from #35/#32. Decision: D-064.

GitHub is the native review gate. Code Conductor reads its state and, only when you ask
and approve, prepares a draft pull request. It never merges, approves, re-runs checks,
or changes repository settings. Authentication stays with the official clients: your
own Git credentials for the push and `gh auth` for the GitHub CLI. No webhook server or
token is stored by Code Conductor.

## Inspect a pull request

```sh
cc github-gate [--repo <dir>] [--pr <number|url|branch>] [--json]
```

Read-only. It runs `gh pr view --json …` for the current branch's pull request, or the
one named with `--pr`, and summarizes:

- checks on the head commit (check runs and commit statuses), with failed and pending
  names and their native links;
- the review decision, and approvals given on an earlier commit than the current head;
- the merge state GitHub reports (for example `BLOCKED` by branch protection).

It exits `0` only when every signal is green: open, not a draft, all checks passed,
review decision `APPROVED`, no stale approval, mergeable. Missing data never counts as
passing. Even then, merging remains your decision in GitHub.

## Prepare a draft pull request

```sh
cc pr [--run <runId>] [--assignment <id>] [--base main] [--remote origin] [--title <text>]
cc pr … --create
```

Without `--create`, `cc pr` previews and changes nothing. It runs no Git at all for a run
that stopped because Git configuration changed, or that has no outcome yet. It uses only
worktree records on a `cc/` branch under the Code Conductor root. The preview covers the agent
branch of the latest run (or `--run`), the exact commit, commit count and changed files,
the push destination, the GitHub repository, and the generated title and body. The body
holds the run, task, local decision, approvals, assignment table, gates, unverified
checks and reported risks. It never includes prompts or file contents. If a run has
several completed agent worktrees, choose one with `--assignment`.

With `--create`, in an interactive terminal:

1. Code Conductor refuses outright in any of these cases:
   - the branch has no commits since its base;
   - the remote is not a GitHub URL;
   - any commit since the base touched a sensitive path, even one removed again;
   - any file version in those commits adds a credential-looking string, or is past the
     credential-scan budget ([`WORKTREES.md`](WORKTREES.md#commits)).

   Findings are reported as path, line and kind, never the value.
2. It asks for a `context_disclosure` approval addressed to `github:<host/owner/repo>`.
   The approval is bound to the remote, push and fetch URLs (credentials removed), the
   branch, exact head commit, base, commit list, file list, title and body. If your Git
   configuration rewrites the push destination (`url.*.pushInsteadOf`), both URLs are
   shown.
3. It rebuilds the request and requires the same digest, so a branch that moved while
   you were reading is refused (`changed`).
4. It pushes exactly the approved commit, `git push <remote> <sha>:refs/heads/<branch>`.
   The push is never forced, so a remote branch with other history is rejected, and
   repository hooks such as `pre-push` do not run.
5. It opens the draft with `gh pr create --draft --repo <host/owner/repo> --head <branch>`.
   The body is passed through a private temporary file.

Approval, push and pull-request events are appended to the run's `events.jsonl`. If the
push succeeds but `gh` fails, the branch stays pushed and the command to open the draft
yourself is printed. `cc next` still shows the manual `git push` / `gh pr create`
commands for people who prefer to run them themselves.

## Not covered

- Fork workflows, where you push to a fork and open the pull request against upstream,
  need the manual commands for now.
- GitHub Enterprise Server works when `gh` is authenticated to that host. It is not
  validated on a real instance here.
- Copilot code review, required reviewers and environment protection are configured in
  GitHub. Code Conductor reports their outcome, it does not request or bypass them.
