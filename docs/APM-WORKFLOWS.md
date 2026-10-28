# Optional APM workflows

APM remains optional. Basic handoffs require no package install. The supported
version is 0.33.0, coordinated with Agent Packs (ADR 0015 / D-077).

## Available cockpit actions

- **Inspect Pack Provenance:** local metadata only, with source-file SHA-256 hashes.
  A supported reference names the reviewed `hybridcloudworks/Proj-AgentPacks`
  distribution mirror and a full commit. The source remains
  `saulpatinojr/Proj-Agent_Packs`.
- **Audit Packs:** explicitly starts `ccon apm-audit .` in the selected trusted
  workspace. The CLI checks the version, then calls the existing bounded native
  audit. Failures remain failures; partial output and timeout diagnostics stay in
  the terminal. This command installs nothing and grants no runtime authority.
- **Preview Pack Projections:** select one or both reviewed public TypeScript/
  GitHub engineer packs and compare staged Codex projections. Requires trusted
  local Linux, APM 0.33.0 and bubblewrap. Downloads occur only on request; the
  selected repository remains unchanged. Available without existing APM metadata
  through the command palette.

CLI equivalent:

```sh
ccon apm-preview --repo /absolute/repository --packs typescript-distinguished-engineer-pack
```

Use both catalog names separated by a comma to compare both packs. Terminal JSON
contains exact before/after text and SHA-256 hashes, operations and conflicts,
the source pins, lock digests and a digest of the comparison. `audit` describes
the disposable staged project only. Unmanaged, modified, shared or unsafe local
instructions block replacement/removal candidates. This result is explicitly
`selected-pack-projections-only`: no manifest/lock merging, other-target cleanup,
deployment or installation approval is implied.

Materialization uses a write-isolated native sandbox with scripts/executable
grants denied. It is not a confidential-read or network sandbox. An APM executable
inside the hidden home may be unavailable; unsupported hosts/namespace setup fail
explicitly. No prerequisite is installed automatically. See [ADR 0017](adr/0017-write-isolated-pack-projection-preview.md).

## On-demand catalog discovery

`ccon apm-catalog --repo /absolute/repository` fetches the canonical mirror's
catalog and release tags explicitly. Each candidate records its virtual package,
declared version and immutable full commit; packs sharing a commit stay distinct.
`locallyPresent` marks exact source-associated versions whose recorded projections
are present as regular files. It does not verify their contents or establish an
audit pass. Missing/incomplete local metadata leaves versions visible with a
diagnostic. Consumers can hide present versions and offer other releases.

Pass `--select '<id>'` using a returned compound ID to refetch authoritative
membership and check the selected package's name, version and declared targets
at its exact commit. The response includes catalog/package manifest hashes;
targets remain publisher claims and runtime eligibility remains unverified.
Discovery is bounded to 1,000 tags, 1 MiB per HTTP response and 15 seconds per
operation; a truncated version list is explicitly incomplete. Public GitHub rate
limits and proxy/TLS failures remain visible. Requests use configured proxy and
TLS trust without collecting client credentials or following returned URLs.

This CLI foundation starts no APM/provider process and writes no project files.
It does not extend the fixed two-pack projection preview, install a selected
release, or expose the planned +/−/Save controls yet.

Inventory states mean only:

| State | Evidence |
|---|---|
| declared | Reviewed pinned reference exists in apm.yml; no matching lock entry. |
| locked | GitHub host, mirror identity, virtual package path and full commit match. |
| mismatch | A candidate lock entry exists but its source or commit differs. |
| unsupported | Reference is outside the reviewed pinned mirror format. |

A locked entry is not an audit pass, authentication, trust or permission to run
providers, hooks or MCP servers. Recorded projection paths are inventory; they
are not a proposed installation diff. Static inventory audit state is unknown.

Reads are limited to 1 MiB per metadata file and 1,000 dependencies/projection
paths per list. Symlinked metadata, malformed shapes, unsupported lock formats,
unsafe projection paths and ambiguous source associations fail visibly. Parser
errors do not echo source snippets. Refresh or reopening provenance regenerates
its read-only virtual document; nothing writes into the repository.

## Remaining installation workflow (#142)

The first fixed-catalog Codex projection comparison is available; complete
installation diffs including metadata/local source/all targets, digest-bound
installation approval, audit evidence tied to the actual deployment, and safe
update/removal are still required. Existing APM owns resolution and lock generation;
Code Conductor must not hand-edit the lock or overwrite human instructions.

The official 0.33.0 CLI advertises `install --dry-run`, `--only apm`, `--target`,
`--no-trust-bin` and `--root`. Before exposing installation, validate their actual
semantics using disposable repositories, conflict fixtures, hook/MCP boundaries
and exact generated diffs. A package preview must not invoke a provider, start an
MCP server or execute package hooks. A summary of package names alone is not an
exact projection preview.

Official references:

- [APM 0.33.0 source](https://github.com/microsoft/apm/tree/v0.33.0)
- [APM CLI reference](https://microsoft.github.io/apm/reference/cli-commands/)
- [APM governance](https://microsoft.github.io/apm/enterprise/governance/)
