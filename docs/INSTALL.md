# Install, update and uninstall

Implements I01 from #33/#32. Code Conductor ships as one VS Code extension (a `.vsix`).
The extension carries:

- the `cc` runtime, bundled into a single file;
- the packaged defaults ([`PACKAGED-DEFAULTS.md`](PACKAGED-DEFAULTS.md));
- the contract schema.

It works in any repository without cloning or building Code Conductor. There is no hosted
backend: everything runs, and is stored, on the machine where your workspace lives.

## Prerequisites

| Requirement | Why |
|---|---|
| VS Code 1.105 or later | The extension's `engines.vscode`. |
| Node.js 22 or later on `PATH` | The extension runs its bundled runtime with `node`. |
| Git | Agent worktrees, diffs and commits. |
| GitHub CLI (`gh`) | Startup diagnostics, the GitHub gate and draft pull requests ([`GITHUB.md`](GITHUB.md)). |
| The official clients you want to use (Claude Code, Codex, Kiro), installed and signed in | Each provider runs through its own client ([`AUTHENTICATION.md`](AUTHENTICATION.md#client-states-before-a-provider-starts)). |

APM is needed only for repositories that package agent packs
([`APM-EXECUTION.md`](APM-EXECUTION.md)). Terraform, Ansible and package managers are
needed only by the gate profiles that use them ([`GATE-PROFILES.md`](GATE-PROFILES.md)).

## Compatibility

- **Windows, macOS and Linux.** Providers and gate commands run in their own process
  group on POSIX only ([`APPROVALS.md`](APPROVALS.md)).
- **Remote workspaces** (SSH, WSL, Dev Containers, Codespaces): the extension runs on the
  workspace host (`extensionKind: workspace`), so install Node.js, Git and the clients
  there.
- **Untrusted workspaces:** discovery and execution stay off until you grant Workspace
  Trust ([`VSCODE-EXECUTION.md`](VSCODE-EXECUTION.md)).
- **Virtual workspaces** (no local file system) are not supported.

## Install

From a release `.vsix`:

```sh
code --install-extension code-conductor-<version>.vsix
```

You can also use the Extensions view: open its `…` menu and choose **Install from
VSIX…**. Then open any repository, trust it, and run **Code Conductor: Doctor**. Doctor
shows each client's installed, signed-in, healthy and trusted state, and what to do next.

The extension is not on the Marketplace yet. CI packages it under a validation-only
publisher on every pull request.

## Run `cc` commands yourself

The extension does not put `cc` on your `PATH`. On most Linux and macOS systems `cc` is
the C compiler, which must not be shadowed. Commands the extension copies for you
already name its bundled runtime:

```sh
node '<extension folder>/dist/cc.js' worktrees --remove-clean
```

The extension folder is in VS Code's extensions directory (for example
`~/.vscode/extensions/<publisher>.code-conductor-vscode-<version>`). Command lines shown
elsewhere in these docs as `cc <command>` mean the same thing.

## Update

Install the newer `.vsix` the same way; VS Code replaces the installed version. Your local
evidence and settings stay. Workstation trust is bound to each provider client's version,
not the extension's. After you upgrade a client, run its smoke tests again.

## Uninstall

```sh
code --uninstall-extension <publisher>.code-conductor-vscode
```

You can also uninstall from the Extensions view.

Uninstalling removes the extension only. Code Conductor never uploads anything, and it
leaves your data where it is:

- `~/.code-conductor/` (or `$CODE_CONDUCTOR_HOME`):
  - `runs/`: manifests, events, approvals and handoff packets;
  - `worktrees/`: agent worktrees;
  - `workstation.json`: smoke-test trust;
  - `config.json`: your preferences.
- `cc/…` branches in your repositories, which hold any agent commits.
- VS Code's per-workspace state for the extension: a non-secret discovery cache.

To remove everything, do this **before** uninstalling:

1. Run `worktrees --remove-clean`. Review and remove any other worktrees with
   `git worktree remove`.
2. Delete the `cc/…` branches you no longer need with `git branch -D`.
3. Delete `~/.code-conductor/`.

Code Conductor stores no credentials. Sign-in state stays in each official client and is
removed through that client (for example `claude auth logout`, `codex logout` or
`kiro-cli logout`).

## Validation

CI's release preflight checks the package itself:

1. It packages the `.vsix` and unpacks it outside the checkout, as VS Code installs it.
2. It requires the package to hold exactly the files a release ships: the two bundles,
   the defaults, the schema, the icon, the manifest, the README, the changelog and the
   licence.
3. It runs the bundled runtime from that copy against an unrelated empty folder, with a
   fresh home and no `node_modules`. The runtime must validate its packaged defaults,
   report the packaged version, and leave the folder untouched.

To run the same check locally:

```sh
VSCE_PUBLISHER=code-conductor-validation npm run package:vscode
unzip -q release/code-conductor-*.vsix -d /tmp/vsix-install
node scripts/smoke-vscode-bundle.mjs --extension /tmp/vsix-install/extension
```

Installing into VS Code itself on a clean machine (Windows, macOS, Linux and remote)
remains owner workstation validation (#4).
