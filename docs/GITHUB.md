# GitHub pull requests and checks

Implements I03 from #35/#32. Decision: D-064.

GitHub is the native review gate. Code Conductor reads its state and, only when you ask
and approve, prepares a draft pull request. It never merges, approves, re-runs checks,
or changes repository settings. Authentication stays with the official clients: your
own Git credentials for the push and `gh auth` for the GitHub CLI. No webhook server or
token is stored by Code Conductor.

## Inspect a pull request

```sh
ccon github-gate [--repo <dir>] [--pr <number|url|branch>] [--json]
```

Read-only. It runs `gh pr view --json …` for the current branch's pull request, or the
one named with `--pr`, and summarizes:

- checks on the head commit (check runs and commit statuses), with failed and pending
  names and their native links;
- the review decision, and approvals given on an earlier commit than the current head;
- the merge state GitHub reports (for example `BLOCKED` by branch protection).

It exits `0` only when every signal is green: open, explicitly not a draft, all checks
passed, review decision `APPROVED`, no stale approval, and merge state `CLEAN` or
`HAS_HOOKS`. `UNSTABLE` ("mergeable with non-passing commit status") does not pass, and
neither does a draft state `gh` did not report: missing data never counts as passing.
Even then, merging remains your decision in GitHub.

## Prepare a draft pull request

```sh
ccon pr [--run <runId>] [--assignment <id>] [--base main] [--remote origin] [--title <text>]
ccon pr … --create
```

Without `--create`, `ccon pr` previews and changes nothing. It runs no Git at all for a run
that stopped because Git configuration changed, or that has no outcome yet. It uses only
worktree records on a `cc/` branch under the Code Conductor root. The preview covers the agent
branch of the latest run (or `--run`), the exact commit, commit count and changed files,
the push destination, the GitHub repository, and the generated title and body. The body
holds the run, task, local decision, approvals, assignment table, gates, unverified
checks and reported risks. It never includes prompts or file contents. The preview ends
with the text's SHA-256, which the `--create` approval repeats. If a run has several
completed agent worktrees, choose one with `--assignment`; only a completed assignment
can be opened.

The body is published to everyone who can read the repository, so:

- credential-looking strings that agents reported (in risks or unverified checks, for
  example) are replaced with `[redacted <kind>]`, and the preview says how many;
- everything agents wrote is shown as code, where GitHub renders no @-mentions, issue
  references, closing keywords (`Closes #1`), links or images.

The preview runs no Git command that enters a repository nested in the worktree
([`WORKTREES.md`](WORKTREES.md#nested-repositories)).

With `--create`, in an interactive terminal:

1. It shows the same preview. Code Conductor refuses outright in any of these cases:
   - the branch has no commits since its base;
   - the remote is not a GitHub URL;
   - the remote does not push to exactly one URL. A push goes to every push URL of a
     remote (or every URL when it has none), so all of them are listed;
   - that push URL names a different repository or host than the fetch URL, where the
     pull request is opened. The same repository in another form (`git@github.com:` or
     other letter case) is fine;
   - the base commit is not on a branch of the remote as of your last fetch. The push
     would also publish it and any unpushed commits before it, which the preview does
     not list or scan. Push them yourself first. This reads your remote-tracking
     branches, which anything that can write the repository's refs can also create;
   - any commit since the base touched a sensitive path, even one removed again;
   - any file version, or any file or directory name, in those commits adds a
     credential-looking string, or is past the credential-scan budget
     ([`WORKTREES.md`](WORKTREES.md#commits)).

   Findings are reported as path, line and kind, never the value.
2. It asks for a `context_disclosure` approval addressed to `github:<host/owner/repo>`.
   The approval is bound to the remote, the exact push URL (shown without credentials,
   query or fragment; bound by digest), the fetch URL, the branch, exact head commit,
   base, commit list, file list, title and body. If your Git configuration rewrites the
   push destination (`url.*.pushInsteadOf`), both URLs are shown.
3. It rebuilds the request and requires the same digest, so a branch or push URL that
   changed while you were reading is refused (`changed`). It reads the push URL once
   more right before pushing.
4. It pushes exactly the approved commit, `git push --no-follow-tags
   --no-recurse-submodules <remote> <sha>:refs/heads/<branch>`, and nothing else: no
   tags, even with `push.followTags`, and no submodules. Only the HTTPS and SSH
   transports are allowed (`GIT_ALLOW_PROTOCOL`), so no remote helper, local or `ext::`
   transport runs. The push is never forced, so a remote branch with other history is
   rejected, and repository hooks such as `pre-push` do not run.
5. It opens the draft with `gh pr create --draft --repo <host/owner/repo> --head <branch>`,
   run from a private temporary directory that also holds the body. `gh` and `git` are
   found on absolute `PATH` entries only, never in the agent worktree. The run counts
   as created only when `gh` prints a pull request URL in that repository.

Approval, push and pull-request events, including a refused push, a `gh` failure and an
unconfirmed URL, are appended to the run's `events.jsonl`. If the push succeeds but `gh`
fails, the branch stays pushed and the command to open the draft yourself is printed. `ccon next` still shows the manual `git push` / `gh pr create`
commands for people who prefer to run them themselves.

## Not covered

- Fork workflows, where you push to a fork and open the pull request against upstream,
  need the manual commands for now, and so does a remote whose push and fetch URLs name
  different hosts (for example an SSH host alias for pushes only).
- Code Conductor checks Git configuration while a run is in progress. It does not detect
  changes a process left running after the run makes later; such a process can change
  any of your configuration, which is outside what Code Conductor contains
  ([`APPROVALS.md`](APPROVALS.md)).
- GitHub Enterprise Server works when `gh` is authenticated to that host. It is not
  validated on a real instance here.
- Copilot code review, required reviewers and environment protection are configured in
  GitHub. Code Conductor reports their outcome, it does not request or bypass them.
