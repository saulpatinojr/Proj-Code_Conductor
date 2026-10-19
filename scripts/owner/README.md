# Owner scripts

PowerShell scripts for the steps only the repository owner can take. They run with your
own `gh` sign-in, store no credential, and work in Windows PowerShell 5.1 and PowerShell 7.
The three that change GitHub take `-WhatIf`, and `Get-Help <script> -Full` documents each.

| Script | For | What it does |
|---|---|---|
| `Set-RepositoryGovernance.ps1` | #3 | Applies the rulesets for `main` and all tags, and the branch, security and Actions settings of [`REPOSITORY-GOVERNANCE.md`](../../docs/REPOSITORY-GOVERNANCE.md). Then reads them back, checks them, and writes the read-back for #3 (`-PostEvidence` posts it). |
| `Remove-StaleBranches.ps1` | Branch cleanup | Shows each branch other than `main` with the reason it may be stale. Keeps the head or base of an open pull request. Deletes the ones you confirm, and prints the command that restores each. With `-IncludeLocal`, it deletes a local copy only when GitHub had all of its commits. |
| `Set-MarketplaceEnvironment.ps1` | #14 | Sets `VSCE_PUBLISHER` and creates the `marketplace` environment: you approve each deployment, and only `v*` tags may deploy ([`MARKETPLACE-PUBLISHING.md`](../../docs/MARKETPLACE-PUBLISHING.md), step 2). |
| `Invoke-WorkstationValidation.ps1` | #4, #9, #10, #18, #41 | Collects the evidence of [`WORKSTATION-VALIDATION.md`](../../docs/WORKSTATION-VALIDATION.md) section 13 that needs no judgement into a checklist you complete and post. |

## Running them

From a PowerShell prompt in a clone of this repository, signed in as the owner
(`gh auth status`):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # this window only; changes no setting

.\scripts\owner\Set-RepositoryGovernance.ps1 -WhatIf
.\scripts\owner\Set-RepositoryGovernance.ps1 -PostEvidence

.\scripts\owner\Remove-StaleBranches.ps1 -WhatIf
.\scripts\owner\Remove-StaleBranches.ps1 -IncludeLocal

.\scripts\owner\Set-MarketplaceEnvironment.ps1 -Publisher <publisher-id> -WhatIf

.\scripts\owner\Invoke-WorkstationValidation.ps1 -Smoke claude,codex
```

Run them from the prompt as shown, not with `powershell -File`: `-File` passes
`claude,codex` as one string, not a list.

- **Smoke tests use your subscriptions.** `Invoke-WorkstationValidation.ps1 -Smoke` runs
  each named client for real and records its trust, as `ccon harness-smoke` does. Kiro
  also needs `-AckKiroPolicy`, after you have read Kiro's current subscription and
  automation terms.
- **Ask before deleting.** `Remove-StaleBranches.ps1` asks before each deletion.
- **Required checks apply at once.** After `Set-RepositoryGovernance.ps1`, every pull
  request into `main`, including those already open, needs its required checks green on
  an up-to-date branch.
- **Re-running resets the rulesets.** `Set-RepositoryGovernance.ps1` puts both rulesets
  back to the documented baseline each time, replacing changes made in Settings.
  Pass `-CopilotReview` again to keep Copilot review.

`tests/scripts/owner-scripts.test.ts` runs the scripts against a model of GitHub
(`tests/scripts/fake-gh.mjs`) wherever PowerShell is installed, including CI.
