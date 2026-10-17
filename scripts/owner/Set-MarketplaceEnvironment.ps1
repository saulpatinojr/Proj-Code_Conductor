<#
.SYNOPSIS
    Prepares the GitHub side of Marketplace publishing (#14, docs/RELEASE.md).

.DESCRIPTION
    Uses your own gh sign-in, which needs admin access to the repository. Running it again
    changes nothing that is already in place.

    1. Sets the VSCE_PUBLISHER repository variable that the Release workflow packages with.
    2. Creates or updates the "marketplace" deployment environment: you (or -Reviewer) must
       approve each deployment, and only tags matching v* may deploy.

    It stores no credential. Creating the Marketplace publisher, and the Microsoft Entra ID
    workload identity a publish job would sign in with, stay with you (listed at the end).

.PARAMETER Publisher
    The Marketplace publisher ID (not its display name).

.PARAMETER Repository
    The repository, as owner/name.

.PARAMETER Reviewer
    The GitHub login that approves deployments. Defaults to the signed-in gh account.

.EXAMPLE
    .\scripts\owner\Set-MarketplaceEnvironment.ps1 -Publisher my-publisher -WhatIf
#>
#Requires -Version 5.1
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive owner script: progress is for the console, results go to the pipeline.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # The same rule as scripts/package-vscode.mjs.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*$')]
    [string] $Publisher,
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$')]
    [string] $Repository = 'saulpatinojr/Proj-Code_Conductor',
    [ValidatePattern('^[A-Za-z0-9-]+$')]
    [string] $Reviewer
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OwnerTools.psm1') -Force

$Environment = 'marketplace'
$null = Assert-GhRepository -Repository $Repository -Permission admin
$user = if ($Reviewer) { Invoke-GhApi -Endpoint "users/$Reviewer" } else { Invoke-GhApi -Endpoint 'user' }

if ($PSCmdlet.ShouldProcess($Repository, "Set the VSCE_PUBLISHER variable to $Publisher")) {
    $null = Invoke-Gh -ArgumentList @('variable', 'set', 'VSCE_PUBLISHER', '--repo', $Repository, '--body', $Publisher)
    Write-Host "Done: VSCE_PUBLISHER is $Publisher"
}

$body = [ordered]@{
    wait_timer               = 0
    # You push the tag and you approve it: with self-review prevented, a single owner could
    # never approve a deployment.
    prevent_self_review      = $false
    reviewers                = @([ordered]@{ type = 'User'; id = $user.id })
    deployment_branch_policy = [ordered]@{ protected_branches = $false; custom_branch_policies = $true }
}
if ($PSCmdlet.ShouldProcess($Repository, "Create or update the $Environment environment, approved by $($user.login)")) {
    $null = Invoke-GhApi -Method PUT -Endpoint "repos/$Repository/environments/$Environment" -Body $body
    Write-Host "Done: $Environment environment, approved by $($user.login)"
} elseif ($WhatIfPreference) {
    Write-Host (ConvertTo-Json -InputObject $body -Depth 10)
}

$policies = @()
if (-not $WhatIfPreference) {
    $policies = @((Invoke-GhApi -Endpoint "repos/$Repository/environments/$Environment/deployment-branch-policies?per_page=100").branch_policies)
}
$tagPolicy = @($policies | Where-Object { $_.name -eq 'v*' -and $_.PSObject.Properties['type'] -and $_.type -eq 'tag' })
if (-not $tagPolicy.Count -and $PSCmdlet.ShouldProcess($Repository, "Allow only v* tags to deploy to $Environment")) {
    $null = Invoke-GhApi -Method POST -Endpoint "repos/$Repository/environments/$Environment/deployment-branch-policies" -Body ([ordered]@{ name = 'v*'; type = 'tag' })
    Write-Host "Done: only v* tags may deploy to $Environment"
}
$others = @($policies | Where-Object { -not ($_.name -eq 'v*' -and $_.PSObject.Properties['type'] -and $_.type -eq 'tag') })
foreach ($policy in $others) {
    Write-Warning "The $Environment environment also lets '$($policy.name)' deploy. Remove it in Settings > Environments unless you meant it."
}

Write-Host @"

Still yours (docs/RELEASE.md, "Publishing to the Marketplace"):
  - Create the publisher '$Publisher' if it does not exist: https://marketplace.visualstudio.com/manage
  - The tag ruleset from Set-RepositoryGovernance.ps1 must be in place before the first release.
  - A publish job is not in the Release workflow yet. When it is added, it signs in with a
    Microsoft Entra ID workload identity (vsce publish --azure-credential), not a personal
    access token; Azure DevOps retires global personal access tokens on 2026-12-01.
"@
