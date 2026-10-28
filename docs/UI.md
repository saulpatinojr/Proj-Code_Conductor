# VS Code cockpit

Code Conductor v0.1 uses a thin VS Code extension rather than a replacement chat interface.

## Activity Bar views

Three views. Every row either opens the file it comes from, opens a run's summary, performs that run's next action, or shows sign-in guidance; the short label is the gist and the tooltip is the whole story.

- **Runs** — the last 25 runs associated by canonical repository path with the selected workspace, from `~/.code-conductor/runs` (or `CODE_CONDUCTOR_HOME`), newest first, titled by objective with the decision and start time. A run expands into its decision, each assignment (role, client, status, recommendation, blocking findings), each gate, and its next actions; clicking a next action performs it (opens the worktree in Source Control, starts a read-only `ccon` command in a task terminal, or shows the exact command to copy; nothing pushes, signs in or starts a provider from the view, [`NATIVE-INTERFACES.md`](NATIVE-INTERFACES.md)). Clicking the run opens its summary as a read-only Markdown document: decision, assignments, gates, next actions, findings, risks, what the agents did not verify, worktrees and approvals. Title buttons: **Plan a Task**, **Refresh**. With no runs, the view says how a run works and offers **Plan a Task**.
- **Workstation** — what this machine has, from cached discovery: **AI clients** (installed, not found, or manual platform; click for the official sign-in guidance; installed never means signed in or trusted, which **Doctor** checks), **Tools** (required ones in red when missing), **Gate profiles** (each profile's gates and whether they block; click opens `config/gates.yaml`) and **Packs** (APM dependencies, lock, own skills, targets; click opens the file). Title buttons: **Doctor**, **Refresh Local Discovery**. In Restricted Mode it offers Workspace Trust instead.
- **Policy** (collapsed by default) — **Roles** with their stance, preferred clients and the rules rendered into their prompts (click opens `config/roles.yaml`), **Risk classes** (which roles each needs, and which need human approval), **Billing** (subscriptions only, or separately billed API allowed) and the decision register.

## Commands

Refresh local discovery, refresh runs, Doctor, repository validation, task planning (objective and risk class, with each class explained), the decision register, and the internal commands the views use (open run summary, perform next action, open configuration file, sign-in guidance). Execution remains in the Code Conductor CLI and official vendor clients: `ccon run … --execute` runs in a terminal, where each consequential step asks for approval. Terminal output, source control, diffs, GitHub PRs, and native agent sessions stay in their existing VS Code surfaces.

## Deliberate non-features

- no custom multi-model chat window
- no credential entry/storage UI
- no secret display
- no attempt to mirror GitHub's PR UI
- no paid-client execution from extension activation

## Repository selection and refresh

Multi-root workspaces require **Code Conductor: Select Repository** before scoped
commands or run navigation. Foreign, legacy and missing-repository manifests are
excluded from the selected repository; their local records remain available via
the CLI. Repository association is never inferred from an objective.

Extension-launched task completion refreshes Runs and open read-only summaries.
The last task process outcome is shown separately from run readiness. A task
ending without an exit status is unverified/cancelled, never successful.
Configuration links show effective values from the policy loader, including
packaged defaults and allowed preferences, with source paths and SHA-256 hashes.
They create no repository files.

Validation still required: installed VSIX click-through on Windows and Linux,
including task cancellation, open-summary refresh, repository switching and
packaged-default navigation in an unrelated empty repository.

## Execution overview

Runs show the stored assignment dependencies, provider, surface and authority.
The summary includes a dependency table and plain-text evidence references.
Stored tool/test references also appear under **Stored gate evidence** (first 50
per run), opening read-only plain text bound to the selected trusted repository.
The viewer verifies the evidence ID/source/digest against the manifest and reads
only the fixed private capture locations, never evidence-supplied URIs. It shows
manifest gate verdicts; capture-header exit metadata cannot set the verdict.
Modified, missing, duplicate, truncated and legacy combined-digest captures remain
unavailable without deleting their files. See [stored output](GATE-PROFILES.md#stored-output-and-the-summary-mode-94).
Reopening revalidates cached documents. A separate 150 ms coalesced capture watcher
refreshes open evidence documents without rescanning run manifests or polling.
No workflow designer or new scheduler is introduced. Agent-controlled Markdown
is escaped; journal observations cannot create commands or execution authority.

The runtime records `assignment.started` immediately before approved provider
execution and deterministic validation. Existing result and completion events
remain authoritative for outcomes. New event metadata uses version 1; old
manifests and journals remain readable, with absent observations shown honestly.
A recent start is an observation, not a heartbeat. After five minutes without a
result, a one-shot timer changes its display to unknown/stale. No polling or
provider process is used. Local manifest/journal changes trigger a 150 ms
coalesced refresh, including runs initiated outside the extension.

A partial execution with no final decision is incomplete. The cockpit refuses a
green display when results, mandatory human approval or blocking findings
contradict a stored ready claim. New native gate results retain their effective
blocking/advisory policy. A green display requires a passed blocking gate and no
failed or skipped blocking gate; failed advisory gates alone do not override it.
Legacy records remain readable, but unknown blocking policy displays
`human_required` instead of inferring readiness from a name or a passing advisory
check. Gate rows in the summary label this distinction. Recorded approvals are
historical evidence and never authorize a new action.

Run enumeration reads at most the latest 1,000 record directories per refresh
and displays up to 25 matching runs. A visible limit notice explains older-record
lookup. Malformed, oversized and missing-repository records are counted as
unassociated/unavailable, and inaccessible stores show an actionable diagnostic.

## Optional knowledge navigation

**Knowledge** in Workstation, **Browse Knowledge**, and **Related knowledge** on a
run use an explicitly connected existing vault folder. **Connect Knowledge Vault**
stores non-secret connection paths only; it performs no scan. Browsing indexes
on demand and filters metadata to the selected repository. Run navigation matches
only declared run identifiers and copies no private execution content.

**Disconnect Knowledge Vault** forgets the connection; it deletes no notes.
Opening a note rechecks its hash, source/edge states, repository and connection
before navigation. Native editor is the default. An unavailable Obsidian client or
URI-ambiguous filename falls back to the editor. Notes and their source references
never grant execution authority.

Indexing currently supports trusted, local Linux extension hosts only. Windows,
macOS, WSL/SSH/remote and virtual hosts are explicitly unsupported for indexing;
URI unit tests do not establish installed-client validation on those hosts.
See [Obsidian integration](OBSIDIAN-INTEGRATION.md) for schema, limits and evidence.

## Optional pack inspection, preview and audit

**Inspect Pack Provenance** opens a repository-bound, read-only text snapshot of
manifest/lock SHA-256 hashes, declared references, exact locked commits, versions,
targets and recorded projection paths. Matching a reviewed GitHub mirror pin is
shown as locked; absent or foreign/mismatched sources remain declared or mismatch.
Malformed, symlinked and oversized metadata produces a diagnostic.

**Audit Packs** invokes the existing CLI audit only on request in a trusted
workspace. It requires APM 0.33.0, resolves the executable from absolute PATH
entries only, and shows its bounded result in the task terminal. No APM process
starts to populate the view. Audit status remains unknown in the static inventory;
a lock or successful earlier terminal task never grants current integrity,
provider authorization or runtime readiness.

**Preview Pack Projections** selects reviewed public packs and starts an explicit
write-isolated Linux task to download/materialize Codex projections, audit the
staged project and compare exact files/hashes against this repository. It rechecks
trust and repository selection after the picker. The terminal JSON names
conflicts and limits the result to selected pack projections; it does not claim
a complete native installation diff or grant installation approval.

Installation/update/removal and metadata/local-source merging remain separate.
See [APM workflows](APM-WORKFLOWS.md).
