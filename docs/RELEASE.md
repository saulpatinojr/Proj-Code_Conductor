# Releases

Implements #14. Decision: D-067. A release is one VS Code extension package (`.vsix`, see
[`INSTALL.md`](INSTALL.md)). It is built from a version tag on `main`, tested, given a
software bill of materials (SBOM) and a signed build-provenance attestation, and left as
a **draft** GitHub release for a person to review and publish. Nothing is published to
the Visual Studio Marketplace automatically.

## Prerequisites (repository settings)

The checks below are only as strong as the repository's settings:

- **Tags.** A tag ruleset that limits who may create, move or delete tags. It should
  cover **all** tags, not only `v*`: a tag can carry another ref's name, for example
  `origin/main`.
- **Main.** A branch ruleset on `main` that requires pull requests.

Both are owner settings ([`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md), #3).
Until they are in place, anyone with write access can push to `main` or tag any commit
on it, and a release only shows that the commit was on `main`, not that it was reviewed.

## What the Release workflow does

`.github/workflows/release.yml` runs when a tag `vMAJOR.MINOR.PATCH` is pushed. It has
three jobs, each holding only the access it needs.

**Candidate.** This job runs the repository's code and dependencies, so it can neither
sign nor write:

1. It refuses the tag unless:
   - the tag equals the extension version (`v` + `apps/vscode/package.json` `version`);
   - the tagged commit is on `main` (`refs/remotes/origin/main`, by its full name, so
     that a tag cannot impersonate the branch);
   - the `VSCE_PUBLISHER` repository variable names the Marketplace publisher.
2. It installs the locked dependencies (`npm ci --ignore-scripts`, no dependency cache),
   then runs the dependency audit, typecheck, tests and repository validation.
3. It packages the `.vsix` and runs the same installed-package smoke test as the release
   preflight on every pull request (see [`INSTALL.md`](INSTALL.md#validation)).
4. It writes:
   - the CycloneDX SBOM (`code-conductor-<version>.cdx.json`). This is npm's dependency
     graph of the two bundled workspaces, the extension and the `ccon` runtime, with
     development dependencies marked. The workflow fails if the SBOM does not list
     every package esbuild put in a bundle;
   - `SHA256SUMS` for the package and the SBOM.

**Attest.** This job runs no repository code. It holds the signing permissions
(`id-token`, `attestations: write`). It creates a
[build-provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
for the package and the SBOM with `actions/attest`, signed with a short-lived Sigstore
certificate tied to this workflow run.

**Draft.** This job also runs no repository or dependency code: only the pinned
artifact download, the runner's `gh` and `sha256sum`. Its `contents: write` permission
could do more than create a release, which is why it runs nothing else. It:

1. confirms the tag still points at the commit that was built, because a draft attaches
   to wherever the tag points when it is published;
2. verifies each file's attestation against this workflow, this tag and this commit
   (below);
3. creates a draft release holding the package, the SBOM, `SHA256SUMS` and verification
   notes.

The candidate files are also kept as a workflow artifact for 7 days. A file that carries
an attestation has not been approved: install only what a person published as a
release.

## Cutting a release

1. **Prepare the release in a pull request:**
   - set `version` in `apps/vscode/package.json`;
   - move the `CHANGELOG.md` entries from **Unreleased** to a section for that version.
2. Merge it after review and CI.
3. Tag the merged commit on `main` and push the tag:

   ```sh
   git fetch origin main
   # The full ref name: a tag named origin/main would otherwise take precedence.
   git tag -a v0.2.0 -m "Code Conductor 0.2.0" "$(git rev-parse refs/remotes/origin/main)"
   git push origin v0.2.0
   ```

4. **Review the draft release:**
   - check the workflow run and its attestation;
   - download the package and verify it as below;
   - install it on a clean machine ([`WORKSTATION-VALIDATION.md`](WORKSTATION-VALIDATION.md)).

   Then, just before you publish, confirm the tag still names the commit in the release
   notes. The release attaches to wherever the tag points at that moment:

   ```sh
   git ls-remote origin 'refs/tags/v0.2.0^{}'
   ```

   Publish the draft only if that prints the commit the notes name.

A wrong tag fails before anything is built. Delete it (`git push origin :refs/tags/v0.2.0`)
and tag again.

## Versions

Extension versions are `MAJOR.MINOR.PATCH`. The Marketplace does not support semver
pre-release suffixes, and VS Code updates users to the highest version available. The
VS Code publishing guide therefore recommends an even minor number for releases and an
odd one for pre-releases (for example `0.2.*` and `0.3.*`). Code Conductor follows that
convention. Pre-release packages (`vsce package --pre-release`) are not built yet
([publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
"Pre-release extensions").

`engines.vscode` is the oldest VS Code the extension supports. `@types/vscode` is kept at
that same version, so the extension cannot compile against newer APIs. Packaging (vsce)
refuses newer types, and Dependabot does not raise them. Raise both together, on purpose.

## Verify a package

From the folder holding the downloaded release files:

```sh
sha256sum -c SHA256SUMS
gh attestation verify code-conductor-<version>.vsix --repo saulpatinojr/Proj-Code_Conductor \
  --cert-identity https://github.com/saulpatinojr/Proj-Code_Conductor/.github/workflows/release.yml@refs/tags/v<version> \
  --source-ref refs/tags/v<version> --source-digest <commit> --deny-self-hosted-runners
```

`<commit>` is the commit the release notes name. Check that it is on `main`.

With only `--repo`, `gh attestation verify` accepts a signature from any workflow on any
branch of the repository. The other flags pin it down to:

- the Release workflow, run for this tag (`--cert-identity`, which must match the signing
  certificate exactly);
- this release's tag and commit (`--source-ref`, `--source-digest`);
- a GitHub-hosted runner (`--deny-self-hosted-runners`).

`--cert-identity` is used instead of `--signer-workflow` because some `gh` versions match
the workflow by prefix only. See
[gh attestation verify](https://cli.github.com/manual/gh_attestation_verify). The
Draft job runs the same check before it creates the release. Artifact attestations are
available for public repositories on every current GitHub plan; a private repository
needs GitHub Enterprise Cloud.

## Roll back, deprecate, remove

- **Roll back:**
  - **A `.vsix` release:** install the previous version's package the same way
    (`code --install-extension code-conductor-<older>.vsix`).
  - **From the Marketplace (once published):** right-click the extension in the
    Extensions view, choose **Install Another Version**, then turn off its **Auto
    Update** item
    ([extension marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)).
    An extension installed from a `.vsix` does not auto-update by default.

  Local evidence and settings are not version-specific ([`INSTALL.md`](INSTALL.md#update)).
  After any change of version, run the client smoke tests again only if a client
  changed too.
- **Deprecate:** the Marketplace deprecation flow is requested in the VS Code team's
  [deprecated extensions discussion](https://github.com/microsoft/vscode-discussions/discussions/1).
  VS Code never uninstalls or migrates a deprecated extension by itself. It offers a
  **Migrate** button only when the deprecation names an alternative extension or setting.
- **Unpublish, never remove:** unpublishing keeps statistics and the name. Removing an
  extension reserves its name permanently, even for its publisher.

## Publishing to the Marketplace (owner setup, not automated yet)

Publication needs decisions only the repository owner can make. They are tracked in #14.
Once you have the publisher ID, `scripts/owner/Set-MarketplaceEnvironment.ps1 -Publisher <id>`
does the GitHub side of steps 1 and 3 ([`scripts/owner`](../scripts/owner/README.md)).

1. **Create or choose the Marketplace publisher.** Confirm that the display name is
   available, then set it as the `VSCE_PUBLISHER` repository variable.
2. **Prefer Microsoft Entra ID over a personal access token.** Use workload identity
   federation with `vsce publish --azure-credential`, which needs no long-lived secret.
   Azure DevOps retires global personal access tokens on December 1, 2026
   ([secure automated publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)).
3. **Create a `marketplace` deployment environment.** Make yourself its required
   reviewer, allow only `v*` tags, and keep any publishing credential in that
   environment, not in the repository.
4. Have the tag and branch rulesets from [Prerequisites](#prerequisites-repository-settings)
   in place.

A publish job gated on that environment can then be added to the Release workflow.

## Privacy

Code Conductor sends no telemetry. Everything it records stays on your machine
([`INSTALL.md`](INSTALL.md#uninstall)). Its context-savings figures are local estimates,
not vendor billing or quota data. Provider clients and `gh` talk to their own services
under their own terms.
