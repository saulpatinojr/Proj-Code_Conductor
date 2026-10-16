# Authentication and Billing Boundaries

## Principle

Code Conductor coordinates official clients; it does not impersonate them, steal session state, or centralize consumer OAuth tokens.

## Subscription-first policy

Separately billed model APIs are disabled by default. Prefer each user's existing subscription-backed official client when supported.

| Lane | Preferred auth | Preferred billing path | Conductor behavior |
|---|---|---|---|
| GitHub / Copilot | GitHub/VS Code official sign-in | GitHub Copilot subscription | Use GitHub-native PR/review/Actions capabilities; never store GitHub OAuth tokens in Conductor state. |
| Claude Code | Claude subscription sign-in | Claude Max | Use official Claude Code CLI. Detect conflicting API-key environment variables and warn before execution. |
| Codex | ChatGPT sign-in in Codex | ChatGPT Business | Use official Codex CLI/client. Do not assume ChatGPT subscription grants general OpenAI API billing. |
| Kiro CLI | Kiro official authentication | Kiro Pro | Use Kiro CLI as Spec Lead and supported headless worker lane. Validate exact installed CLI auth/headless behavior before unattended use. |
| Google / Antigravity | Google official sign-in/keyring | Google AI Pro | Use official Google execution lane. Do not reuse browser cookies or export consumer session credentials. |
| Perplexity Pro | Perplexity consumer sign-in | Perplexity Pro | Human-in-the-loop research only. |
| Perplexity MCP/API | Official API key | separately billed API | Disabled by default; enable only through explicit policy/consent. |

**Moving Perplexity from manual to automated research** is an explicit, separately
billed step:

1. Create a Perplexity API key in its own console. Your Pro sign-in is never used for
   automation.
2. Allow separately billed APIs in the repository's policy.
3. Select the server with `cc mcp --allow-api` and configure it in your native client.

Until then, research assignments stay manual (`cc handoff`, then `cc import`). Results keep
their source URLs (`Evidence.uri`) and the billing channel they ran on.
| Azure MCP/CLI | Microsoft Entra/Azure Identity | cloud account/IAM | Use user/service identity and RBAC; cloud writes remain policy-gated. |
| AWS MCP/CLI | Official AWS identity/OAuth/IAM | cloud account/IAM | Use AWS permissions as source of authority; cloud writes remain policy-gated. |
| Google Cloud MCP/CLI | Google Cloud IAM | cloud account/IAM | Use IAM as authority; enable only project-required toolsets. |

## Credential storage

Code Conductor MAY store:

- non-secret provider/harness IDs
- authentication status (`authenticated`, `not_authenticated`, `unknown`)
- credential source category (`subscription`, `api`, `cloud_iam`)
- billing mode category
- last health-check timestamp

Code Conductor MUST NOT store:

- OAuth access tokens
- refresh tokens
- API key values
- browser cookies/session tokens
- SSH private keys
- cloud secret keys
- plaintext passwords

## `cc doctor` checks

`cc doctor` should inspect the environment without revealing values:

```text
GitHub/Copilot       authenticated / unavailable / unknown
Claude Code          subscription / api-key-conflict / unavailable
Codex                subscription / api / unavailable
Kiro                 subscription / headless-ready / unavailable
Antigravity          authenticated / unavailable / unknown
Perplexity           manual-pro / paid-api-enabled / disabled
Azure                authenticated / unavailable
AWS                  authenticated / unavailable
GCP                  authenticated / unavailable
```

## Client states before a provider starts

Implements I02 (#34). Decision: D-065. For Codex, Claude Code and Kiro, Code Conductor
tells four states apart, and `cc doctor` reports each one on its own line:

| State | Established by | Without it |
|---|---|---|
| Installed | The client is on `PATH` and reports `--version`. | The assignment waits for a manual handoff. |
| Signed in | The client's own documented status command (below). | The provider is not started. |
| Healthy | The client reports its version and a sign-in state Code Conductor recognises. | `cc doctor` warns. A state it does not recognise also blocks starting. |
| Trusted | `cc harness-smoke <client> --mode read\|modify` passed **for the installed version**. | The provider is not started. |

Official status commands:

| Client | Command | Signed in when | Subscription when | Source |
|---|---|---|---|---|
| Claude Code | `claude auth status` | Exit 0 and `"loggedIn": true` | `authMethod` is `claude.ai` or `oauth_token`. `api_key`, `api_key_helper` and `third_party` are billed separately. | [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Codex | `codex login status` | Exit 0 and `Logged in using …` on stderr | `Logged in using ChatGPT`. An API key or Amazon Bedrock is billed separately. | [`codex-rs/cli/src/login.rs`](https://github.com/openai/codex/blob/main/codex-rs/cli/src/login.rs) |
| Kiro | `kiro-cli whoami` | Exit 0 and `Logged in with …` | Always: every Kiro sign-in draws on the subscription's credits. | [CLI commands](https://kiro.dev/docs/reference/cli-commands/), [authentication](https://kiro.dev/docs/getting-started/authentication/) |

How the checks work:

- **The probes are diagnostics.** They run with no prompt and no repository: in an empty
  private temporary directory, so a repository's own client configuration cannot change
  the answer. They use the provider environment, so a variable Code Conductor removes
  does not count. They have a 15-second timeout and bounded output.
- **The run sees what the probe saw.** Claude Code starts with `--setting-sources user`,
  so a repository's `.claude/settings.json`, `.claude/settings.local.json` and
  `.mcp.json` are not read. Under `claude -p` they would otherwise apply without a trust
  prompt, including an `env` block, `apiKeyHelper` and hooks, which could switch a
  subscription run to the repository's own credential or endpoint after the check
  ([what runs before you trust a folder](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder)).
  Only your user-level and managed settings, `CLAUDE.md`, skills and commands load. The
  repository's own `CLAUDE.md`, project skills and commands are not loaded under this
  flag either; the task prompt asks every run to read `AGENTS.md` and the repository's
  instructions itself
  ([Claude Code features in the Agent SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)).
- **The probe and the run read the same configuration.** A relative `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `HOME` or `USERPROFILE` is made absolute against the directory Code
  Conductor was started in, and an empty one is removed: Claude Code reads an empty
  `CLAUDE_CONFIG_DIR` as the working directory, which for a run is the repository. A
  relative or empty `ANTHROPIC_CONFIG_DIR` or XDG base directory (`XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`) is removed, as Claude Code and the
  XDG specification ignore one.
- **No user configuration from the repository.** A provider is not started when its
  explicit configuration directory (`CLAUDE_CONFIG_DIR` or `ANTHROPIC_CONFIG_DIR` for
  Claude Code, `CODEX_HOME` for Codex) lies inside the repository being run, directly or
  through a symlink, and `cc harness-smoke` refuses the same, since it runs the provider
  for real. The sign-in probe cannot see the hooks, `env` block or credential helper such
  "user" settings could carry. `HOME` is not checked: when a repository is your home
  folder (dotfiles), its `.claude/` is your own user configuration.
- **The same client file throughout.** The version probe, the sign-in probe and the
  launch all run the one file the command resolves to on an absolute `PATH` entry. A
  relative entry such as `node_modules/.bin`, an empty entry, or (on Windows) the working
  directory could otherwise point the launch at a program in the repository.
- **Only three things are kept:** the state, the billing class and the client's short
  name for the method. Email addresses, organisations and the masked key Codex prints
  are not.
- **A provider starts only when all of these hold:**
  - the smoke test passed for its installed version;
  - its client reports a sign-in;
  - for an assignment billed to the subscription (`subscription_first`), that sign-in
    is a subscription.

  Otherwise the assignment is blocked before any worktree is created or approval asked,
  and `cc next` points to the official sign-in. `cc harness-smoke` refuses in the same
  cases, because the smoke test runs the provider for real.
- **Anything not recognised never counts.** That includes a status line or `authMethod`
  that is not documented, a probe that fails or times out, and a version that cannot be
  read.
- **Trust is bound to the client version.** After an upgrade, run the smoke tests
  again. A smoke test on a new version also clears what an older version had passed. A
  client whose version cannot be read is never trusted. A smoke test is not recorded
  when the version changes while it runs.

Results are read the same way. A provider's result is read only from its client's final
message in the documented machine-readable output: Claude Code's `result` field
([headless](https://code.claude.com/docs/en/headless)), and Codex's last `agent_message`
event ([non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)).
Tool and command output can never supply one, and output without that final message
has no result.

Limits:

- **Classification follows the vendors' documented values.** A new method shows as
  unrecognised and blocks until Code Conductor learns it.
- **Codex methods that are not recognised as subscription billing:** access token,
  personal access token and workload identity.
- **Kiro's JSON output shape is not documented** (`whoami --format json` exists), so
  its plain output is read instead. Exit 1 is a general failure, so only one that says
  it is not logged in counts as signed out; any other is unrecognised.
- **Your own Codex configuration can still choose billing.** In `~/.codex/config.toml`,
  `model_provider`, a provider's `env_key` or an `auth` command make `codex exec` bill
  another provider, while `codex login status` reports the stored sign-in only.
  Repository configuration cannot set these keys
  ([config reference](https://developers.openai.com/codex/config-reference)). Leave them
  unset for subscription runs.
- **Repository-supplied Claude Code project settings and MCP servers do not apply to
  runs.** Put what a run needs in your user settings, or hand the assignment off and run
  it in the client yourself.

Potential billing-changing environment variables should trigger warnings, for example API-key variables for AI providers when repository policy is `subscription_first` and `allow_separately_billed_api: false`. Code Conductor also removes these credentials, and the variables that select a separately billed provider or endpoint (such as `CLAUDE_CODE_USE_BEDROCK` or `ANTHROPIC_BASE_URL`), from the environment of the provider clients it starts. The full list, and what it cannot cover (credentials a client reads from its own configuration), is in [`WORKTREES.md`](WORKTREES.md#provider-environment).

The diagnostic MUST print variable names/status only, never secret values.

## API-spend authorization

A task requiring separately billed APIs must carry explicit policy authorization in its `TaskEnvelope`/run policy. The default is deny.

Conceptual form:

```yaml
billing:
  mode: subscription_first
  allow_separately_billed_api: false
  max_api_spend_usd: 0
```

If enabled later, the runtime should log which lane incurred API use and enforce a configured ceiling where technically possible.

## Human approval and cloud credentials

Having valid cloud credentials does not grant an agent permission to perform production changes. Code Conductor authority policy is an additional gate above native IAM/RBAC.

For R4 or otherwise destructive/external production tasks:

1. validate native identity/permissions;
2. prepare plan/diff/evidence;
3. stop before side effect;
4. request explicit human approval;
5. execute only the approved action;
6. record the result in the run manifest.
