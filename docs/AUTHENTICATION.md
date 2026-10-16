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

Potential billing-changing environment variables should trigger warnings, for example API-key variables for AI providers when repository policy is `subscription_first` and `allow_separately_billed_api: false`. Code Conductor also removes these variables from the environment of the provider clients it starts (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `KIRO_API_KEY`), so subscription clients are not silently switched to metered API billing ([`WORKTREES.md`](WORKTREES.md)).

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
