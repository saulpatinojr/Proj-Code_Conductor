# Workstation validation runbook

Code Conductor deliberately separates repository/CI validation from subscription-backed client validation. GitHub Actions must never consume personal paid AI subscriptions. Run these checks on the workstation that will execute agents.

This runbook follows ADR 0008/0009: the workstation is VS Code-centered, startup is lazy, and provider validation is **surface-aware** rather than treating every AI provider as only a CLI.

## 1. Baseline

Use an up-to-date VS Code installation, Git, Node 22+ (24 recommended), GitHub CLI, APM, and the official provider/tool clients required by the repository. On Windows, prefer WSL2 or another supported OS-level containment environment for unattended agent work whenever the harness documents stronger isolation there.

Install Code Conductor from a release `.vsix` ([`INSTALL.md`](INSTALL.md)) after verifying it ([`RELEASE.md`](RELEASE.md#verify-a-package)). For a pull-request build, use the `vsix-preflight-<run>` artifact of the Release preflight workflow instead, which is packaged under a validation-only publisher. The installation must work in an ordinary repository without the Code Conductor source tree or a local `npm run build`. Validation that uses this repository's own build instead must say so in its evidence.

**How commands are written here.** The extension does not put `cc` on `PATH` ([`INSTALL.md`](INSTALL.md#run-cc-commands-yourself)). Every `cc <command>` below means:

```bash
CC="node '<extension folder>/dist/cc.js'"   # for example ~/.vscode/extensions/<publisher>.code-conductor-vscode-<version>
$CC <command>
```

In a development checkout, `node packages/cli/dist/index.js <command>` after `npm run build` is the equivalent.

## 2. Validate native VS Code surfaces

Before testing unattended execution, confirm the human-facing extension surfaces intended for this workstation are installed and usable.

At minimum for the core team, inspect VS Code Extensions / `code --list-extensions` and verify as applicable:

- Claude Code extension;
- Codex IDE extension;
- GitHub Copilot;
- GitHub Pull Requests / repository integration;
- Code Conductor development/release extension;
- repository-specific deterministic tool extensions such as Terraform, Ansible, PowerShell, Kubernetes, or cloud tooling.

Do not mark a provider healthy merely because an extension is installed. Open the provider's native panel/command once and confirm the expected official sign-in/session surface works.

## 3. Authenticate at vendor boundaries

- GitHub/Copilot: sign in through VS Code/GitHub; verify `gh auth status` for GitHub CLI operations.
- Claude: sign in through the official Claude Code VS Code/CLI flow using the intended subscription. Avoid unintended `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` overrides when subscription-first behavior is intended.
- Codex: sign in through the official Codex IDE/CLI ChatGPT flow. Keep credentials in the official client/keyring.
- Kiro: authenticate the official Kiro CLI/Kiro account flow. Code Conductor's preferred Kiro integration is ACP via `kiro-cli acp`; do not assume generic headless execution is the approved automation path. Validate current subscription/policy terms before unattended use.
- Antigravity: sign in using the official Google flow. Code Conductor keeps unattended execution blocked until ADR 0004 is superseded with current evidence.
- Perplexity: consumer Pro login remains manual. Do not create an API key unless separately billed automated research is explicitly enabled.

Code Conductor must not copy, print, or persist vendor OAuth tokens/secret values.

## 4. Inventory provider and deterministic-tool surfaces

Run the commands relevant to the workstation/repository:

```bash
git --version
gh --version
apm --version
claude --version
codex --version
kiro-cli --version
agy --version
terraform version
ansible --version
pwsh --version
```

Then run Doctor from the installed extension, either with **Code Conductor: Doctor** in the Command Palette, or in a terminal:

```bash
$CC doctor .
```

In a development checkout, `npm run cc:doctor` builds and runs the same command.

Missing optional tool commands are not failures when the active repository profile does not require them.

`cc doctor` should evolve under #10/#15 to report, without secrets:

- provider name and official auth boundary;
- available native IDE surface;
- available CLI/headless surface;
- ACP capability where supported;
- MCP capability/profile state;
- manual-only vs automated lane;
- deterministic tool availability;
- installed-version smoke/trust state (trust is bound to the smoke-tested client version; an upgrade needs a new smoke test);
- official sign-in state and billing class (see [`AUTHENTICATION.md`](AUTHENTICATION.md#client-states-before-a-provider-starts));
- billing lane conflicts that can be safely inferred.

## 5. APM validation

```bash
apm targets
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```

If canonical `.apm/` package source or dependencies change, run the approved materialization workflow, inspect the generated projections and `apm.lock.yaml`, commit them, then let CI perform a read-only audit.

Normal warm VS Code startup must **not** reinstall/materialize APM simply because VS Code opened. Fingerprint changes or explicit refresh trigger materialization work.

## 6. Kiro ACP validation

Kiro is a special case because ADR 0009 chooses ACP as the preferred Code Conductor client/harness boundary. The Code Conductor adapter uses the official stable ACP TypeScript SDK over stdio and starts `kiro-cli acp`; it does not restore the older generic `kiro-cli chat --no-interactive` worker path.

First verify the installed CLI exposes ACP:

```bash
kiro-cli acp --help
```

Before consuming Kiro subscription-backed execution, review the current Kiro subscription/automation policy for the installed/current service terms. Code Conductor requires an explicit acknowledgement on the smoke command so this step is not silently skipped:

```bash
cc harness-smoke kiro --mode read --ack-kiro-policy
```

Only after read smoke passes should modify authority be tested in the disposable smoke repository:

```bash
cc harness-smoke kiro --mode modify --ack-kiro-policy
```

Important safety behavior:

- trust is stored specifically as `kiro@acp`; old generic Kiro CLI trust cannot authorize ACP;
- the ACP client advertises no client filesystem or terminal capabilities;
- ACP permission requests are cancelled by default until a narrower Kiro permission mapping is proven safe on the real workstation;
- smoke uses a temporary Git repository and checks actual read-only/modify effects rather than trusting the model's statement;
- a timed-out ACP prompt sends `session/cancel`, tears down the child process, and is not automatically retried;
- no OAuth token or secret value is copied into Code Conductor state.

The repository CI tests the ACP protocol boundary against a deterministic fake ACP agent. CI does **not** authenticate to Kiro or consume Kiro subscription/API usage. Live release evidence still requires the installed Kiro client to validate:

- ACP initialization/capability exchange;
- session creation and cancellation;
- repository working directory handling;
- assistant/session update streaming and structured result mapping;
- Kiro-native MCP/agent/subagent/session behavior required by the assigned task;
- read-only/plan authority behavior;
- isolated modify behavior in the disposable worktree;
- current subscription/policy compliance.

If either smoke fails, do not mark Kiro trusted manually. Keep unattended Kiro execution fail-closed and use the official interactive/native Kiro surface until the failure is understood.

## 7. Claude and Codex surface validation

Validate both the human IDE surface and the machine-facing surface because they provide overlapping but non-identical capabilities.

For Claude:

- open the Claude Code VS Code panel and verify native project context;
- verify native skills/subagents/hooks/MCP/plugins/commands required by the repository remain discoverable;
- verify the standalone `claude` CLI only when Code Conductor will use the CLI surface for the assignment;
- validate read/plan and isolated modify authority separately.

For Codex:

- open the Codex IDE extension and verify editor-context/review behavior;
- verify the standalone `codex` CLI/`codex exec` path only when Code Conductor will use that surface;
- verify relevant skills/plugins/MCP/permissions available to the selected surface;
- validate read-only and isolated modify authority separately.

The existing smoke commands remain useful for current CLI adapters:

```bash
cc harness-smoke codex --mode read
cc harness-smoke claude --mode read
cc harness-smoke codex --mode modify
cc harness-smoke claude --mode modify
```

If a smoke test fails, do not mark the harness trusted manually; inspect the installed client's permissions/sandbox configuration and current official documentation.

## 8. GitHub Gatekeeper validation

Verify:

- repository/PR visibility through GitHub native surfaces;
- GitHub Actions/status inspection;
- Copilot code review can be requested on the test PR;
- material fixes can be followed by a re-review;
- GitHub review evidence can be captured without treating Copilot opinion as a substitute for deterministic gates.

Repository ruleset/branch-protection administration remains tracked separately in issue #3.

## 9. Deterministic engineering-tool validation

For each active project profile, validate only the tools actually required. Examples:

```bash
terraform fmt -check
terraform validate
ansible-lint
pwsh -NoProfile -Command '$PSVersionTable.PSVersion'
```

Use repository-appropriate tests rather than running destructive cloud/deployment commands as a connectivity probe.

Tool/extension presence does not grant write or production authority. Assignment/risk policy controls authority separately.

## 10. First-run and warm-start behavior

### First run

Validate that Code Conductor can discover/inventory the repository, APM state, provider surfaces, deterministic tools, and relevant auth/trust gaps without starting paid AI work unexpectedly.

### Warm start

Restart/reload VS Code and verify that normal startup:

- restores cached non-secret health/run state;
- performs only lightweight fingerprint checks;
- does not start Claude, Codex, Kiro ACP, or MCP servers until needed;
- does not reinstall/materialize APM when inputs are unchanged;
- degrades gracefully if temporarily offline.

### Measure startup (#9)

Use VS Code's own measurement. Do not time it by hand.

1. Run **Developer: Show Running Extensions**. Record Code Conductor's activation time for a first run (new workspace), for a warm start (reload with nothing changed), and for a start after a configuration change.
2. Right after a warm start, confirm that no provider, ACP, MCP or APM process was started:

   ```bash
   pgrep -fl 'claude|codex|kiro-cli|apm' || echo "none started"
   ```

   On Windows, use `Get-Process` instead.
3. Repeat the warm start while offline. The views should show cached state, and no error should block activation.

**Initial budget, to be confirmed by this first baseline:**

- A warm start activates in under 250 ms and starts no child process.
- A first run, or a start after a configuration change, adds only the `PATH` lookups for the tools in the Connections view, about 16 bounded probes.

Record the measured values with the machine, OS and VS Code version. If they exceed the budget, open an issue with them before changing code.

## 11. MCP/reference validation

Activate the minimum profile required for the repository. Confirm:

- authenticated MCPs retain their official IAM/RBAC boundary;
- write-capable tools are not granted globally by default;
- Code Conductor first-party MCP adapters require explicit catalog approval;
- context-optimizer MCP remains experimental until official SDK/current-protocol validation;
- Perplexity automated MCP/API remains disabled unless explicit separately billed policy is enabled.

## 12. First real dry run and dogfood

```bash
$CC run --repo . --risk R1 --objective "Review the Code Conductor foundation"
```

This plans and persists a run but does not launch paid clients unless `--execute` is explicitly supplied.

Only after required surface-specific trust validation passes:

```bash
$CC run --repo . --risk R1 --objective "Implement the approved test task" --execute
```

The run asks in the terminal before each consequential action: starting a provider, disclosing the prompt and repository to it, running gate commands, and committing. Each request is bound to the exact recipient, revision, content and diff ([`APPROVALS.md`](APPROVALS.md)). Validate on the workstation that the prompt appears in the integrated/task terminal, that only the literal `approve` proceeds, and that a denial leaves the run `human_required` with changes preserved.

A modifying agent receives an isolated worktree. Review/validation remains independent, and GitHub PR/merge remains a separate gate.

Then repeat the scenario at R2, with a different-provider challenger, and take it through GitHub:

```bash
$CC run --repo . --risk R2 --objective "<the approved R2 task>" --execute
$CC next                      # the native next steps for the run
$CC pr                        # preview the draft pull request
$CC pr --create               # approve, push the exact commit, open the draft
$CC github-gate --pr <number> # native checks and reviews, read-only
```

Request a Copilot review on the draft, address it, and request a re-review. `github-gate` must report every signal green before a person merges.

## 13. Release evidence to retain

For the v0.1 release candidate, attach non-secret evidence to #4 as a checklist:

- [ ] the package: version, `sha256sum -c SHA256SUMS` and `gh attestation verify` output ([`RELEASE.md`](RELEASE.md#verify-a-package));
- [ ] OS, VS Code version, and whether the workspace is local, WSL, SSH or a container;
- [ ] installed provider and tool versions (section 4);
- [ ] `cc doctor` output, showing installed, signed in, healthy and trusted for each client;
- [ ] `cc harness-smoke` read and modify results for each client and version (Kiro with `--ack-kiro-policy`);
- [ ] measured first-run, warm-start and changed-configuration activation times, and the process check (section 10);
- [ ] the minimum MCP and tool profiles used;
- [ ] the R1 and R2 run IDs, their structured results and their deterministic gates;
- [ ] the worktree and draft pull request: the `cc pr` preview, the PR URL, and `cc github-gate` output before and after re-review;
- [ ] the final readiness decision, and who made it.

Never paste tokens, email addresses, `config.json` contents or `~/.code-conductor/runs` evidence that holds repository content.
