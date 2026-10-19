# Native interfaces first

Implements C03 from #32/#45. Decision: D-060.

Code Conductor shows the next step, its scope and its evidence, then hands you to the
native surface that owns that step. It does not rebuild those surfaces.

| Concern | Native owner | What Code Conductor does |
|---|---|---|
| Diffs and commits | VS Code Source Control / Git | Records each agent worktree (`RunManifest.worktrees`); **Review in Source Control** opens it in the built-in Git view. If the Git extension is unavailable, it opens the folder in a new window. |
| Sign-in | Each provider's official client | Shows the official sign-in command and documentation link from the packaged capabilities; never asks for, stores, copies or forwards credentials. |
| Approvals before actions | Your interactive terminal | `ccon run --execute` asks before each action ([`APPROVALS.md`](APPROVALS.md)). A refused or missing approval becomes a next action to re-run interactively. |
| Pull requests and review | GitHub | Shows `ccon pr` for **you** to run: it previews the branch and scans exactly the commits it would push, and `--create` asks before pushing that commit and opening the draft. Merge stays a GitHub decision under branch protection and review. |
| Deployment approval | Native pipeline environments | No deployment connector exists yet; any future one must use native environment protection plus a C02 `deployment` approval. |
| Unsupported automation | You, in the official client | `ccon handoff` prints the exact assignment prompt for a manual run. |

## Next actions

`ccon next [--run <runId>] [--json]` reads a stored run, from the latest run by default, and
lists what to do next. The same list appears in `ccon run` output and in the VS Code
**Runs** view. Each run shows its decision and first step; click a run to choose a step.

- **Review changes**: the agent worktree, with `git status` and `git diff <base>`
  commands. It is offered only for existing worktrees inside the Code Conductor worktree
  root after symlinks are resolved, so a path outside that root is never opened, and
  `ccon import` rejects manifests that carry worktree records.
- **Check Git configuration**: replaces the review step when the run stopped because Git
  configuration or history files changed. Source Control, `git status` or `git diff`
  would run Git under that configuration, so only `git config --list --show-origin` is
  offered until you have restored it.
- **Approve in an interactive terminal / You declined**: shows the exact `ccon run ...
  --execute` command to start a new run. A refused **commit** instead points to the
  changes kept uncommitted in the worktree: review and commit them yourself, because a new
  run would start the provider again. A refused gate run says the gates did not run.
- **Validate harness**: sign in through the official client, then run
  `ccon harness-smoke <harness> --mode <read|modify>`.
- **Review on GitHub**: the Copilot/GitHub gatekeeper is a GitHub platform step.
- **Complete manually**: `ccon handoff --run <runId> --assignment <id>`. It prints only the
  prompt on stdout and the guidance on stderr. Pasting the prompt into a client is your own
  disclosure decision. On a terminal, control and format characters in the prompt are
  replaced; redirect stdout for the exact bytes. For an assignment that changes files, work
  in an isolated branch or worktree. The command is shown only for plain run and
  assignment identifiers. To keep the outcome with Code Conductor's evidence, record it as
  a RunManifest file and bring it in with `ccon import`.
- **Fix validation / Resolve findings**: links to the gate and finding evidence.
- **Open a draft pull request**: shown only when the run is `ready` and the builder
  committed changes.

Run records can be imported, so their text is untrusted. `ccon next`, `ccon handoff` and the
VS Code views print each value on one line, with control, bidirectional and zero-width
characters replaced. A record therefore cannot rewrite the terminal or add a step or a
command line. Commands are built by Code Conductor from argument vectors and quoted for
the shell you paste into: POSIX shells, or PowerShell on Windows (shown as `PS>`).
cmd.exe is not a supported paste target, because it does not treat single quotes as quoting.
A command with a value that cannot be shown exactly is left out, and the step says so.
`ccon next --json` includes each command's exact `argv`.

The extension shows a command in a dialog and copies it only when you choose **Copy**. It
never runs commands for you. The only
commands it starts on your click are the read-only `ccon handoff` and `ccon next`, in a VS
Code task terminal. Opening Source Control and the official sign-in documentation are the only other
operations.

## Sign-in guidance

`ccon doctor` and the **Connections** view show the official sign-in route for each client.
The links were verified against the vendors' official documentation on 2026-10-16:

| Client | Sign-in | Official documentation |
|---|---|---|
| GitHub CLI / Copilot | `gh auth login` | https://cli.github.com/manual/gh_auth_login |
| Claude Code | `claude auth login` (`claude auth status` shows the result) | https://code.claude.com/docs/en/authentication |
| OpenAI Codex | `codex login` (Sign in with ChatGPT for subscription access) | https://learn.chatgpt.com/docs/auth |
| Kiro CLI | `kiro-cli login` | https://kiro.dev/docs/getting-started/authentication/ |
| Google Antigravity | inside Antigravity itself | — |
| Perplexity | its own app or browser; research stays manual | — |

Installed or detected never means signed in, healthy or trusted. Those states stay
separate (#34), and execution additionally needs workstation trust and per-action approval.
Code Conductor does not imply session portability between clients.

## Not covered here

The VS Code **Runs** quick pick and the Source Control hand-off still need validation on
the owner's workstation (#4). Automated tests cover the next-action model, the native
operation mapping and the sign-in hint filtering.
