# Native interfaces first

Implements C03 from #32/#45. Decision: D-060.

Code Conductor shows the next step, its scope and its evidence, then hands you to the
native surface that owns that step. It does not rebuild those surfaces.

| Concern | Native owner | What Code Conductor does |
|---|---|---|
| Diffs and commits | VS Code Source Control / Git | Records each agent worktree (`RunManifest.worktrees`); **Review in Source Control** opens it in the built-in Git view. If the Git extension is unavailable, it opens the folder in a new window. |
| Sign-in | Each provider's official client | Shows the official sign-in command and documentation link from the packaged capabilities; never asks for, stores, copies or forwards credentials. |
| Approvals before actions | Your interactive terminal | `cc run --execute` asks before each action ([`APPROVALS.md`](APPROVALS.md)). A refused or missing approval becomes a next action to re-run interactively. |
| Pull requests and review | GitHub | Shows the `git push` and `gh pr create --draft` commands for **you** to run; merge stays a GitHub decision under branch protection and review. |
| Deployment approval | Native pipeline environments | No deployment connector exists yet; any future one must use native environment protection plus a C02 `deployment` approval. |
| Unsupported automation | You, in the official client | `cc handoff` prints the exact assignment prompt for a manual run. |

## Next actions

`cc next [--run <runId>] [--json]` reads a stored run, from the latest run by default, and
lists what to do next. The same list appears in `cc run` output and in the VS Code
**Runs** view. Each run shows its decision and first step; click a run to choose a step.

- **Review changes**: the agent worktree, with `git status` and `git diff <base>`
  commands. It is offered only for worktrees under the Code Conductor worktree root, so a
  path in an imported manifest is never opened.
- **Approve in an interactive terminal / You declined**: shows the exact `cc run ...
  --execute` command to start a new run.
- **Validate harness**: sign in through the official client, then run
  `cc harness-smoke <harness> --mode <read|modify>`.
- **Review on GitHub**: the Copilot/GitHub gatekeeper is a GitHub platform step.
- **Complete manually**: `cc handoff --run <runId> --assignment <id>`. It prints only the
  prompt on stdout and the guidance on stderr. Pasting the prompt into a client is your own
  disclosure decision.
- **Fix validation / Resolve findings**: links to the gate and finding evidence.
- **Open a draft pull request**: shown only when the run is `ready`.

The extension copies commands to the clipboard and never runs them for you. The only
commands it starts on your click are the read-only `cc handoff` and `cc next`, in a VS
Code task terminal. Opening Source Control and official documentation links are the only
other operations.

## Sign-in guidance

`cc doctor` and the **Connections** view show the official sign-in route for each client.
The links were verified against the vendors' official documentation on 2026-10-16:

| Client | Sign-in | Official documentation |
|---|---|---|
| GitHub CLI / Copilot | `gh auth login` | https://cli.github.com/manual/gh_auth_login |
| Claude Code | run `claude`; `/login` inside Claude Code switches accounts | https://code.claude.com/docs/en/authentication |
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
