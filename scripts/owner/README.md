# Owner scripts

PowerShell scripts for the steps only the repository owner can take. They run with your
own `gh` sign-in, store no credential, and work in Windows PowerShell 5.1 and PowerShell 7.
Each one that changes something takes `-WhatIf`, and `Get-Help <script> -Full` documents it.

| Script | For | What it does |
|---|---|---|
| `Set-RepositoryGovernance.ps1` | #3 | Applies the rulesets for `main` and all tags, and the branch, security and Actions settings of [`REPOSITORY-GOVERNANCE.md`](../../docs/REPOSITORY-GOVERNANCE.md). Then reads them back, checks them, and writes the read-back for #3 (`-PostEvidence` posts it). |
| `Remove-StaleBranches.ps1` | Branch cleanup | Shows each branch other than `main` with the reason it may be stale. Deletes the ones you confirm, and prints the command that restores each. |
| `Set-MarketplaceEnvironment.ps1` | #14 | Sets `VSCE_PUBLISHER` and creates the `marketplace` environment: you approve each deployment, and only `v*` tags may deploy ([`RELEASE.md`](../../docs/RELEASE.md#publishing-to-the-marketplace-owner-setup-not-automated-yet)). |
| `Invoke-WorkstationValidation.ps1` | #4, #9, #10, #18, #41 | Collects the evidence of [`WORKSTATION-VALIDATION.md`](../../docs/WORKSTATION-VALIDATION.md) section 13 that needs no judgement into a checklist you complete and post. |

## Running them

From a clone of this repository, signed in as the owner (`gh auth status`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Set-RepositoryGovernance.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Set-RepositoryGovernance.ps1 -PostEvidence

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Remove-StaleBranches.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Remove-StaleBranches.ps1 -IncludeLocal

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Set-MarketplaceEnvironment.ps1 -Publisher <publisher-id> -WhatIf

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\owner\Invoke-WorkstationValidation.ps1 -Smoke claude,codex
```

`-ExecutionPolicy Bypass` applies to that one process and changes no setting. Use `pwsh`
instead of `powershell` for PowerShell 7.

- **Smoke tests use your subscriptions.** `Invoke-WorkstationValidation.ps1 -Smoke` runs
  each named client for real. Kiro also needs `-AckKiroPolicy`, after you have read
  Kiro's current subscription and automation terms.
- **Ask before deleting.** `Remove-StaleBranches.ps1` asks before each deletion.
- **Required checks apply at once.** After `Set-RepositoryGovernance.ps1`, every pull
  request into `main`, including those already open, needs its required checks green on
  an up-to-date branch.

`tests/scripts/owner-scripts.test.ts` runs the scripts against a model of GitHub
(`tests/scripts/fake-gh.mjs`) wherever PowerShell is installed, including CI.
