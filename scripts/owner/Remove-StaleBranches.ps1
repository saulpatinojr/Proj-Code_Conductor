<#
.SYNOPSIS
    Lists the repository's branches other than the default one and deletes those you confirm.

.DESCRIPTION
    The "Branch cleanup" step of docs/REPOSITORY-GOVERNANCE.md. For each branch it shows
    why it may be stale: merged through a pull request, holding no commit the default
    branch lacks, or holding commits that were never merged. Branches with an open pull
    request, protected branches and those named in -Keep are kept without asking.

    Every deletion asks first (answer A to delete all the listed ones); -WhatIf only lists.
    The output gives each deleted branch's commit and the command that restores it.

.PARAMETER Repository
    The repository, as owner/name.

.PARAMETER Keep
    Branch names to keep without asking.

.PARAMETER IncludeLocal
    Also delete each deleted branch, and its remote-tracking ref, from the clone you run
    this in, so that a later push does not create the branch again.

.EXAMPLE
    .\scripts\owner\Remove-StaleBranches.ps1 -WhatIf

.EXAMPLE
    .\scripts\owner\Remove-StaleBranches.ps1 -IncludeLocal
#>
#Requires -Version 5.1
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive owner script: progress is for the console, results go to the pipeline.')]
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$')]
    [string] $Repository = 'saulpatinojr/Proj-Code_Conductor',
    [string[]] $Keep = @(),
    [switch] $IncludeLocal
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OwnerTools.psm1') -Force

function ConvertTo-RefPath([string] $Name) { ($Name -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/' }

$repo = Assert-GhRepository -Repository $Repository -Permission push
$owner = $Repository.Split('/')[0]
$default = $repo.default_branch

if ($IncludeLocal) {
    $origin = Invoke-Native -FilePath 'git' -ArgumentList @('remote', 'get-url', 'origin')
    $url = ($origin.Output -join '').Trim()
    if ($origin.ExitCode -ne 0 -or $url -notmatch ('[:/]' + [regex]::Escape($Repository) + '(\.git)?/?$')) {
        throw "-IncludeLocal needs a clone of $Repository as the current folder; origin is '$url'."
    }
    $current = ((Invoke-Native -FilePath 'git' -ArgumentList @('branch', '--show-current')).Output -join '').Trim()
}

$deleted = New-Object System.Collections.Generic.List[object]
foreach ($branch in @(Get-GhList -Endpoint "repos/$Repository/branches")) {
    $name = $branch.name
    $sha = $branch.commit.sha
    if ($name -eq $default -or $Keep -contains $name) { continue }
    if ($branch.protected) { Write-Host "Keep $name ($($sha.Substring(0, 7))): protected"; continue }

    $head = [uri]::EscapeDataString("${owner}:$name")
    $pulls = @(Get-GhList -Endpoint "repos/$Repository/pulls?state=all&head=$head")
    $open = @($pulls | Where-Object { $_.state -eq 'open' })
    if ($open.Count) { Write-Host "Keep $name ($($sha.Substring(0, 7))): open pull request #$($open[0].number)"; continue }

    $merged = @($pulls | Where-Object { $_.merged_at -and $_.head.sha -eq $sha })
    $compare = Invoke-GhApi -Endpoint "repos/$Repository/compare/$(ConvertTo-RefPath $default)...$sha"
    $reason = if ($merged.Count) { "merged in #$($merged[0].number)" }
    elseif ($compare.ahead_by -eq 0) { "no commit that $default lacks" }
    else {
        $closed = @($pulls | ForEach-Object { "#$($_.number)" })
        "$($compare.ahead_by) commit(s) not on $default; " + $(if ($closed.Count) { "closed unmerged: $($closed -join ', ')" } else { 'no pull request' })
    }

    if ($PSCmdlet.ShouldProcess("$name ($reason)", 'Delete the branch on GitHub')) {
        $null = Invoke-GhApi -Method DELETE -Endpoint "repos/$Repository/git/refs/heads/$(ConvertTo-RefPath $name)"
        $restore = "gh api repos/$Repository/git/refs -f ref=refs/heads/$name -f sha=$sha"
        $deleted.Add([pscustomobject]@{ Branch = $name; Commit = $sha; Reason = $reason; Restore = $restore })
        Write-Host "Deleted $name ($reason). To restore it: $restore"

        if ($IncludeLocal) {
            if ((Invoke-Native -FilePath 'git' -ArgumentList @('show-ref', '--verify', '--quiet', "refs/remotes/origin/$name")).ExitCode -eq 0) {
                $null = Invoke-Native -FilePath 'git' -ArgumentList @('branch', '--delete', '--remotes', "origin/$name")
            }
            if ((Invoke-Native -FilePath 'git' -ArgumentList @('show-ref', '--verify', '--quiet', "refs/heads/$name")).ExitCode -ne 0) { continue }
            if ($name -eq $current) { Write-Host "Kept the local ${name}: it is checked out here."; continue }
            if ($PSCmdlet.ShouldProcess("local branch $name", 'Delete')) {
                $result = Invoke-Native -FilePath 'git' -ArgumentList @('branch', '-D', '--', $name)
                if ($result.ExitCode -ne 0) { throw "git branch -D $name failed: $($result.Errors -join ' ')" }
                Write-Host "Deleted the local $name."
            }
        }
    }
}
$deleted
