# Agent control environment: a network-restricted container as the only place agents run

> **Status: stored for reference, not scheduled.** The owner decided on 2026-10-19 to keep
> this plan and not implement it. Nothing below is approved work. The decision numbers it
> proposes (D-073, D-074) were later taken by D-073 (Codex `exec` arguments), D-074
> (Windows `npm` gates) and D-075 (fail-closed merge decision); if the plan is ever
> activated, it takes the next free decision and ADR numbers at that time.

## Context

The owner asked whether all agentic traffic can be sandboxed in a container that VS Code
connects into, with the container's only network path being outbound to the internet,
narrowed later with explicit "pinholes". The owner's host is Windows 11 with Docker
Desktop; the Codex, Claude Code and Kiro clients are installed natively today and the
2026-10-19 Doctor run finds all three.

Assessment in one paragraph: yes, and it is the right direction for Code Conductor
specifically. Today Code Conductor's own isolation is containment, not a boundary
(`packages/core/src/processes.ts:6-12`: POSIX process groups; `SECURITY.md:30`: worktrees
are not a security sandbox; provider environments are scrubbed of billing variables,
`packages/adapters/src/index.ts:147-157`). A Linux container adds the missing boundary
(filesystem, network, host and LAN), and it also turns on two things that are off on
native Windows: POSIX process-group cleanup and `ccon compress` file reads (ADR 0007,
D-070). The repository already points this way in prose (`docs/BOOTSTRAP.md:24`,
`docs/ARCHITECTURE.md:314`, `docs/INSTALL.md:31-33`) without a concrete artifact. The
container is the containment layer; Code Conductor's approvals, commit scans, worktrees
and no-self-merge rules stay the policy layer. Neither replaces the other.

Owner decisions taken on 2026-10-19 (AskUserQuestion):

| Decision                   | Choice                                                       |
| -------------------------- | ------------------------------------------------------------ |
| Where it runs first        | Docker Desktop on this PC, VS Code **Dev Containers** attach; same image later on a remote host over SSH |
| Egress                     | **Allowlist only** (provider APIs, GitHub, npm, VS Code server), default deny, pinholes added deliberately |
| Workspace                  | Repositories cloned **inside a named volume**; nothing from the host is mounted |
| Codex inside the container | **Container is the boundary**: Code Conductor verifies it runs inside the approved image, then passes `--sandbox danger-full-access`, records that in evidence, and enforces reviewer read-only itself |

The one technical snag that drives the design: Code Conductor launches Codex with
`--sandbox read-only|workspace-write` (`packages/adapters/src/index.ts:225`), which on
Linux is bwrap plus seccomp. OpenAI's current guidance
(https://learn.chatgpt.com/docs/agent-approvals-security, "OS-level sandbox") says that
sandbox may not work under Docker's default namespace/seccomp restrictions and that,
when the container is the intended boundary, Codex should run with
`--sandbox danger-full-access` inside it. Changing what the adapter passes alters a
declared safety mode (`config/capabilities.yaml:117-120`) and therefore needs an ADR and
decision entries (D-034).

What the container does and does not buy (goes verbatim into the docs):

- It protects the **workstation, its files, its credential stores and the LAN** from
  anything an agent does, including prompt-injection-driven actions. Nothing on `C:\` is
  reachable; `host.docker.internal`, RFC1918, link-local and CGNAT ranges are denied.
- It does **not** prevent exfiltration through the endpoints that are allowed: the
  Anthropic, OpenAI, Kiro and GitHub endpoints are bidirectional by nature. Both vendors
  say so in their container docs (Anthropic: "do not prevent a malicious project from
  exfiltrating anything accessible inside the container, including the Claude Code
  credentials"; OpenAI: the same for Codex credentials).
- It does **not** limit what the credentials inside can do elsewhere: scope them (GitHub
  via `gh auth login` with minimal scopes or a fine-grained token limited to the repos
  being worked, HTTPS only, no SSH keys mounted).
- A hosted control plane remains deferred (D-072). This is a local container; it runs no
  service, holds no shared database and brokers no identity.

## Architecture (recommended)

```
Windows 11 host ── VS Code (UI only) ──Dev Containers attach──┐
                                                               ▼
  Docker Desktop (WSL2 VM)                                     │
  ┌──────────────────────────────── network: cc-internal (--internal, no gateway) ─┐
  │  agent container (non-root "conductor")                                       │
  │   • VS Code Server + Code Conductor extension (runtime at dist/ccon.js)        │
  │   • claude, codex, kiro-cli, gh, git, node, apm, terraform …                   │
  │   • volumes: workspace (repos), ~/.code-conductor, ~/.claude, ~/.codex, kiro   │
  │   • HTTPS_PROXY/HTTP_PROXY/NO_PROXY → egress proxy; no other route exists      │
  │                                                                               │
  │  egress proxy container (dual-homed: cc-internal + default bridge)            │
  │   • HTTP CONNECT allowlist from containers/control-environment/allowlist.txt  │
  │   • denies everything else, logs denials with the host name                   │
  └───────────────────────────────────────────────────────────────────────────────┘
                              ▼ only allowlisted hosts, 443
                           internet
```

Why a proxy sidecar on an internal network rather than iptables inside the agent
container (Anthropic's reference `init-firewall.sh`): the agent container then needs no
`NET_ADMIN`/`NET_RAW`, the deny is structural (no default route at all) rather than a
rule set a root process could alter, pinholes are one line in a text file, denials are
visible in one log, and the same proxy serves a remote host later. Trade-off: every
client must honour `HTTPS_PROXY` (Claude Code, Codex, Kiro, gh, git, npm and the VS Code
Server all do; verify in the smoke step) and the allowlist is by host name, not IP.

Connection model: Dev Containers now (no sshd, no keys, port forwarding handled, device
code sign-ins work). The same Dockerfile and compose file run on a remote Linux host
later with VS Code Remote-SSH to that host and Dev Containers on top, which is the
owner's "tunnel" picture without an sshd inside the agent container.

## Deliverables in this repository

New directory `containers/control-environment/` (not `.devcontainer/` at the repository
root: this environment is for any repository the owner works on, and a root
`.devcontainer` would prompt every contributor of this repository):

- `Dockerfile`: pinned base image by digest (Debian/Ubuntu LTS), Node 24, git, gh,
  Python for apm, terraform and the other deterministic tools Doctor inventories,
  `claude`, `codex`, `kiro-cli` installed at pinned versions, non-root user, no sshd,
  `/etc/claude-code/managed-settings.json`, environment markers (see ADR).
- `devcontainer.json`: `dockerComposeFile`, `service: agent`, `remoteUser`, named
  volumes (`workspace`, `conductor-home`, `claude-config`, `codex-home`, `kiro-state`),
  `containerEnv` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CODE_CONDUCTOR_HOME`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, proxy
  variables), no `runArgs` capabilities, `postCreateCommand` that installs the
  Code Conductor `.vsix` from the workspace volume if present.
- `compose.yaml`: `agent` on `cc-internal` only; `egress` on `cc-internal` and the
  default network; `cc-internal` declared `internal: true`; resource limits
  (`mem_limit`, `pids_limit`, `cpus`); `security_opt: no-new-privileges`; read-only
  root filesystem with explicit writable paths; no docker socket; no host mounts.
- `allowlist.txt`: one host per line, grouped by purpose, each group with the vendor
  page it was taken from and a "verify current list" note: Anthropic (Claude Code
  network requirements page), OpenAI/ChatGPT (auth and API hosts), Kiro
  (https://kiro.dev/docs/privacy-and-security/firewalls), GitHub (web, API, codeload,
  objects), npm registry, VS Code Server download and Marketplace, Microsoft Learn MCP.
- `egress/`: proxy image or configuration (a small allowlisting CONNECT proxy; choose
  one that logs denials by host) and `check-egress.sh` that asserts a LAN address and a
  non-listed host are refused and a listed host connects.
- `README.md`: build, first start, sign-in inside the container, how to add a pinhole,
  how to run the same image on a remote host.

Documentation and policy:

- `docs/adr/0015-agent-control-environment.md` (outline below).
- `docs/DECISIONS.md`: D-073 (control environment is the recommended execution host;
  what it is and is not), D-074 (Codex sandbox inside the verified environment; what
  Code Conductor enforces instead), plus a V- row once CI builds the image.
- `docs/CONTROL-ENVIRONMENT.md`: the runbook; `docs/README.md` index entry.
- `docs/WORKSTATION-VALIDATION.md` §1 (make the container the preferred Windows setup,
  state exactly what it buys), §4 (Doctor inside the container shows the environment
  line), §13 (record the image digest and allowlist hash as evidence).
- `docs/INSTALL.md`, `docs/BOOTSTRAP.md`, `SECURITY.md` ("security boundaries": the
  container is the boundary for workstation and LAN; worktrees still are not).
- `CHANGELOG.md`, `docs/STATUS.md`.

Code (small, policy-driven):

- `packages/adapters/src/index.ts` `argsFor`: for `codex`, when the runtime has verified
  the control environment, pass `--sandbox danger-full-access` in both modes; otherwise
  unchanged. The verification is a function in `packages/workstation` (or `core`) that
  requires all of: the image marker file `/etc/code-conductor/control-environment`
  (written by the Dockerfile, holds the image name and digest), `/.dockerenv`, and the
  `CODE_CONDUCTOR_CONTROL_ENVIRONMENT` variable; it returns the environment identity
  (image digest) or undefined.
- `packages/workstation/src/index.ts`: trust records gain `environment` next to
  `clientVersion` (`isTrusted` at :73, `record` at :79); a smoke passed inside the
  container trusts that client only inside the same image digest, and vice versa.
- `packages/runtime/src/execute.ts`: the reviewer/read assignment inside the container
  runs against a read-only checkout (second worktree created read-only, or the existing
  worktree with the Git tree hash compared before and after, failing the assignment if
  it changed), since Codex no longer enforces read-only itself; the approval summary and
  the evidence record name the environment and the sandbox decision.
- `packages/cli/src/index.ts` Doctor: one line `environment: control container <image@digest>`
  or `environment: host`; harness-smoke records the environment.
- `config/capabilities.yaml`: codex `safety` gains `contained_mode:
  danger-full-access-inside-verified-control-environment` with the note; schema and
  `ccon validate` updated if the catalog is schema-checked.
- `scripts/owner/Invoke-WorkstationValidation.ps1` already detects containers
  (`/.dockerenv`, `REMOTE_CONTAINERS`); add the environment marker to the evidence it
  prints. No other change.

CI (`.github/workflows/ci.yml` or a new `control-environment.yml`, pinned actions):

- build the image on `ubuntu-latest` (D-038: no paid client is signed in or run);
- start the compose stack, run `check-egress.sh` (deny LAN, deny unlisted, allow listed:
  use a listed host that answers a TLS handshake quickly, and treat the deny checks as
  the assertions that must never flake because they fail fast);
- inside the agent container run the bundled runtime's `workspace-validate` and
  `doctor` against an empty folder and assert the `environment: control container` line;
- fail if the image contains any credential file patterns or an sshd.

## ADR 0015 outline

- Status Accepted, date, related issues #4, #41, #46 (deferred scope unchanged), #32.
- Context: containment today; owner's requirement; vendor guidance quotes with links.
- Decision: the control environment definition (image, volumes, internal network, proxy
  allowlist, non-root, no host mounts, no docker socket); Dev Containers attach first,
  remote host later; Codex runs `danger-full-access` only when the environment is
  verified, read-only for reviewers is enforced by Code Conductor; trust is bound to
  client version and environment identity; credentials sign in inside the container and
  persist in volumes; scoped GitHub access.
- Consequences: what it protects and does not (the honest list above); Windows native
  remains supported but is no longer the preferred path for unattended runs; `compress`
  and process-group cleanup work inside.
- Alternatives rejected: in-container iptables (capabilities, mutable rules), WSL distro
  (shares host filesystem via automount and host network unless hardened), nested Codex
  sandbox (seccomp relaxation, validation burden, may still fail under Docker Desktop).

## Validation, in order

1. `docker compose build` locally; image digest recorded.
2. Start the stack; `check-egress.sh` passes (LAN and unlisted denied, listed allowed).
3. Dev Containers: Reopen in Container; install the `.vsix` from the workspace volume;
   `ccon doctor` shows `environment: control container <digest>`, all three clients
   found, each `not signed in`.
4. Sign in inside the container: `claude auth login`, `codex login` (device flow if the
   callback does not forward), `kiro-cli login`, `gh auth login` with minimal scopes.
   Doctor shows signed in for all.
5. `harness-smoke` read then modify for claude, codex, kiro (`--ack-kiro-policy`);
   Doctor shows trusted bound to version and environment. A smoke run on the Windows
   host afterwards must show the container trust does not carry over.
6. `ccon compress README.md --root .` reads the file (Linux), the first time this works
   for the owner.
7. R1 dry run, then `run --execute` on a controlled task; `gate.output.recorded` events
   present; `ccon pr` preview and `ccon github-gate`.
8. CI job green; `npm test`, typecheck, `ccon validate` unchanged.
9. Record the §13 evidence on #4 with the image digest and allowlist hash.

## Risks for the owner's eyes

- Allowlist drift: a vendor adds a host and sign-in or a model call fails with a proxy
  denial. The denial log names the host; adding it is a reviewed one-line change.
- Docker Desktop's internal network and proxy behaviour differ slightly from Linux
  Docker; validate the deny checks on the owner's machine, not only in CI.
- Codex full access inside the container widens what a misbehaving Codex run can do to
  the other volumes in the container (other repos, Claude and Kiro credential state).
  Mitigation options in the ADR: one agent container per repository, or mount only the
  active workspace into each run; decide after the first dogfood.
- VS Code Server and extensions update over the network; pin what can be pinned and
  allow only the Microsoft download hosts.