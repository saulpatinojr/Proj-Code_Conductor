# Installed VSIX smoke — Linux, 2026-10-28

## Evidence and scope

VS Code **1.105.1**, commit `7d842fb85a0275a4a8e4d7e040d2625abbf7f084`,
Linux x64, official stable archive from Microsoft's update service. The
`code-conductor-test.code-conductor-vscode` 0.1.2 VSIX was built from source
`76b903a`, installed with the native VS Code CLI in a clean profile/extensions
folder, and exercised through the real extension test host under Xvfb.
No source-development copy of Code Conductor was loaded. The separate development
extension was an empty test-driver stub. No Marketplace publication occurred.

Eight assertions passed twice (initial probe and reusable runner):

- The installed packaged extension activated.
- Every contributed command was registered.
- Configuration navigation opened actual effective packaged roles, read-only,
  with SHA-256 provenance.
- Pack inspection opened the absent/optional APM state correctly.
- A private fixture for the selected repository opened in the native run summary.
- An already-open native summary updated after stored evidence changed/refreshed.
- The bundled runtime completed a real VS Code `ProcessExecution` validation task
  with exit code zero.
- The unrelated empty workspace remained empty.

The reusable run completed at `2026-10-28T09:16:46Z`. Bundle SHA-256:

| File | SHA-256 |
|---|---|
| extension.js | `2181889abef66bc97a4d23305b40be4f1b7687e59df2fbdb04007dd3347ecc28` |
| ccon.js | `b725286c140c47c8f0feda50d78f284e282bb8500bd773e429fc5d624a15be88` |

After integrating merged PR #149 (`8c4ab4f`, product source `86b22ab`), the VSIX
was rebuilt, reinstalled and all eight native checks passed again at
`2026-10-28T09:26:38Z`. The extension bundle hash is unchanged; the updated runtime
hash is `397c0123d5ebb5a270072bd09cb974085640fff2f313a3cdc283f12230f09dd1`.
The integrated full suite passed **72 files, 649 tests / 33 skipped**; repository
validation, standalone bundle/default smoke and VSIX packaging passed again.

This is native extension-host command/virtual-document/task evidence, not an
exhaustive mouse/keyboard walkthrough. The launch explicitly trusts a disposable
empty fixture (`--disable-workspace-trust`); it does not establish Restricted Mode
behavior. Mocked Restricted Mode/scope/failed/cancelled-task coverage remains
separate. No Windows run, real Obsidian client, APM installation, paid provider,
MCP activation, PR action or release was exercised. Windows and full accessibility/
click-through acceptance remain outstanding.

## Repeat against an installed VSIX

The current runner additionally tests manifest-bound capture recovery and native
evidence-document invalidation. See the [12-check evidence retest](2026-10-28-evidence-recovery-smoke.md).

Use an existing native VS Code installation and a disposable empty repository,
profile, extensions folder and Code Conductor home. On headless Linux provide an
X display (this run used Xvfb); do not run this against a customer work folder.
The runner refuses nonempty workspaces and private state inside the workspace.
No test-only npm dependency or product source changes are required.

1. Build/package with a test publisher and install the VSIX using the native CLI:

   ```sh
   VSCE_PUBLISHER=code-conductor-test npm run package:vscode
   /path/to/code --user-data-dir /absolute/smoke/profile \
     --extensions-dir /absolute/smoke/extensions \
     --install-extension /absolute/repository/release/code-conductor-0.1.2.vsix
   ```

2. Create `/absolute/smoke/empty-repository`, `/absolute/smoke/conductor-home`,
   and a separate empty test-driver extension folder. Its `package.json` is:

   ```json
   {"name":"code-conductor-smoke-driver","version":"0.0.0","publisher":"local","engines":{"vscode":"^1.105.0"},"main":"index.cjs"}
   ```

   Its `index.cjs` contains `exports.activate = () => {};`.

3. Run the native extension test host. On Linux select the display as appropriate;
   Windows users can supply the equivalent paths/environment in PowerShell.

   ```sh
   CODE_CONDUCTOR_HOME=/absolute/smoke/conductor-home /path/to/code \
     --disable-gpu --disable-workspace-trust --skip-welcome --skip-release-notes \
     --disable-updates --disable-telemetry \
     --user-data-dir /absolute/smoke/profile \
     --extensions-dir /absolute/smoke/extensions \
     --extensionDevelopmentPath=/absolute/smoke/test-driver \
     --extensionTestsPath=/absolute/repository/scripts/vscode-desktop-smoke.cjs \
     /absolute/smoke/empty-repository
   ```

The runner writes an owner-private report with version, bundle hashes and checks
under the disposable Code Conductor home's `reports/`. It deletes only its own
unique private run fixture in `finally`, preserving the workspace and other runs.
When testing a different test publisher, set `CC_SMOKE_EXTENSION_ID` to its exact
installed extension ID. Never count a failed/absent report as a pass. Remove the
disposable profile/home/extensions folders when their evidence is no longer needed.

Official references:

- https://code.visualstudio.com/api/working-with-extensions/testing-extension
- https://code.visualstudio.com/docs/configure/command-line
