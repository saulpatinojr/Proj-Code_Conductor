# Releases

Implements #14. Decision: D-067. A release is one VS Code extension package (`.vsix`, see
[`INSTALL.md`](INSTALL.md)). It is built from a version tag on `main`, tested, given a
software bill of materials (SBOM) and a signed build-provenance attestation, and left as
a **draft** GitHub release for a person to review and publish. Nothing is published to
the Visual Studio Marketplace automatically.

## What the Release workflow does

`.github/workflows/release.yml` runs when a tag `vMAJOR.MINOR.PATCH` is pushed. Its first
job holds no write access to repository contents:

1. It refuses the tag unless:
   - the tag equals the extension version (`v` + `apps/vscode/package.json` `version`);
   - the tagged commit is on `main`, so only reviewed, merged code is released;
   - the `VSCE_PUBLISHER` repository variable names the Marketplace publisher.
2. It installs the locked dependencies (`npm ci --ignore-scripts`, no dependency cache),
   then runs the dependency audit, typecheck, tests and repository validation.
3. It packages the `.vsix` and runs the same installed-package smoke test as the release
   preflight on every pull request (see [`INSTALL.md`](INSTALL.md#validation)).
4. It writes:
   - the CycloneDX SBOM (`code-conductor-<version>.cdx.json`). This is npm's dependency
     graph of the two bundled workspaces, the extension and the `cc` runtime, with
     development dependencies marked. The workflow fails if the SBOM does not list
     every package esbuild put in a bundle;
   - `SHA256SUMS` for the package and the SBOM.
5. It creates a [build-provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
   for the package and the SBOM with `actions/attest`. The attestation is signed with a
   short-lived Sigstore certificate tied to this workflow run.

A second job, which may only create releases (`contents: write`), checks the checksums
again and creates a draft release holding the package, the SBOM, `SHA256SUMS` and
verification notes.

## Cutting a release

1. **Prepare the release in a pull request:**
   - set `version` in `apps/vscode/package.json`;
   - move the `CHANGELOG.md` entries from **Unreleased** to a section for that version.
2. Merge it after review and CI.
3. Tag the merged commit on `main` and push the tag:

   ```sh
   git fetch origin main
   git tag -a v0.2.0 -m "Code Conductor 0.2.0" origin/main
   git push origin v0.2.0
   ```

4. **Review the draft release:**
   - check the workflow run and its attestation;
   - download the package and verify it as below;
   - install it on a clean machine ([`WORKSTATION-VALIDATION.md`](WORKSTATION-VALIDATION.md)).

   Then publish the draft.

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
gh attestation verify code-conductor-<version>.vsix --repo saulpatinojr/Proj-Code_Conductor
```

`gh attestation verify` checks the signature and that the package was built by this
repository's Release workflow, and from which commit
([gh attestation verify](https://cli.github.com/manual/gh_attestation_verify)). Artifact
attestations are available for public repositories on every current GitHub plan; a
private repository needs GitHub Enterprise Cloud.

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
  VS Code keeps a deprecated extension installed and offers a migration.
- **Unpublish, never remove:** unpublishing keeps statistics and the name. Removing an
  extension reserves its name permanently, even for its publisher.

## Publishing to the Marketplace (owner setup, not automated yet)

Publication needs decisions only the repository owner can make. They are tracked in #14:

1. **Create or choose the Marketplace publisher.** Confirm that the display name is
   available, then set it as the `VSCE_PUBLISHER` repository variable.
2. **Prefer Microsoft Entra ID over a personal access token.** Use workload identity
   federation with `vsce publish --azure-credential`, which needs no long-lived secret.
   Azure DevOps retires global personal access tokens on December 1, 2026
   ([secure automated publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)).
3. **Create a `marketplace` deployment environment.** Make yourself its required
   reviewer, allow only `v*` tags, and keep any publishing credential in that
   environment, not in the repository.
4. **Protect release tags** with a tag ruleset, so only maintainers can create or move
   `v*` tags.

A publish job gated on that environment can then be added to the Release workflow.

## Privacy

Code Conductor sends no telemetry. Everything it records stays on your machine
([`INSTALL.md`](INSTALL.md#uninstall)). Its context-savings figures are local estimates,
not vendor billing or quota data. Provider clients and `gh` talk to their own services
under their own terms.
