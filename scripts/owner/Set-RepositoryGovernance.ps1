<#
.SYNOPSIS
    Applies the repository settings in docs/REPOSITORY-GOVERNANCE.md (#3), then reads them
    back and checks them.

.DESCRIPTION
    Uses your own gh sign-in, which needs admin access to the repository. -WhatIf prints
    each request instead of sending it.

    Running it again puts both rulesets back to this baseline: a change made to them in
    Settings, such as an emergency bypass, is replaced, and the Copilot review rule stays
    only with -CopilotReview. A ruleset made another way for the same refs (the default
    branch, or all tags) is updated in place and keeps its name, rather than duplicated.

    1. Branch ruleset "Protect main" on the default branch:
       - no deletion and no force push;
       - a pull request with 0 approvals (GitHub does not let you approve your own) and
         every conversation resolved;
       - the required checks below, reported by GitHub Actions, on an up-to-date branch;
       - with -CopilotReview, a Copilot review of each pull request.
    2. Tag ruleset "Protect tags" on all tags: only repository admins may create, move or
       delete a tag.
    3. Head branches are deleted after merge, and pull requests offer to update their branch.
    4. Secret scanning, push protection and private vulnerability reporting are on.
    5. Workflows get a read-only token by default and may not create or approve pull requests.
    Steps 3 to 5 send only the settings that differ from what is set now.
    6. The settings are read back, checked, and written to a Markdown file for #3:
       the rules in effect on the default branch, each ruleset's bypass list, and the
       repository, security and Actions settings.

.PARAMETER Repository
    The repository, as owner/name.

.PARAMETER CopilotReview
    Ask Copilot to review each pull request automatically. It needs a Copilot plan that
    includes code review, and it does not review drafts.

.PARAMETER MergeMethods
    The merge methods to allow (merge, squash, rebase). Left as they are when omitted.

.PARAMETER EvidencePath
    Where to write the read-back. Defaults to a file in your temporary folder.

.PARAMETER PostEvidence
    Also post the read-back to issue #3 as a comment.

.EXAMPLE
    .\scripts\owner\Set-RepositoryGovernance.ps1 -WhatIf

.EXAMPLE
    .\scripts\owner\Set-RepositoryGovernance.ps1 -MergeMethods squash,merge -PostEvidence
#>
#Requires -Version 5.1
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive owner script: progress is for the console, results go to the pipeline.')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$')]
    [string] $Repository = 'saulpatinojr/Proj-Code_Conductor',
    [switch] $CopilotReview,
    [ValidateSet('merge', 'squash', 'rebase')]
    [string[]] $MergeMethods,
    [string] $EvidencePath = (Join-Path ([System.IO.Path]::GetTempPath()) 'code-conductor-governance.md'),
    [switch] $PostEvidence
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OwnerTools.psm1') -Force
$EvidencePath = Resolve-OwnerPath -Path $EvidencePath -SessionState $ExecutionContext.SessionState

# The "Required checks" table of docs/REPOSITORY-GOVERNANCE.md; tests/scripts/owner-scripts.test.ts
# keeps the two the same.
$RequiredChecks = @('quality', 'audit', 'lockfile', 'VSIX packaging preflight', 'dependency-review', 'Analyze javascript-typescript', 'Analyze actions')
# The GitHub Actions app. With it, a check of the same name from another app, or a commit
# status, cannot stand in for the real one.
$GitHubActionsAppId = 15368
# The built-in Repository admin role in a ruleset's bypass list (maintain is 2, write is 4).
$RepositoryAdminRoleId = 5

function Set-Ruleset {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)] $Body)
    $all = @(Get-GhList -Endpoint "repos/$Repository/rulesets?includes_parents=false")
    $matching = @($all | Where-Object { $_.name -eq $Body.name -and $_.target -eq $Body.target })
    if (-not $matching.Count) {
        # One made another way (for example in Settings) for the same refs is updated, not duplicated.
        $refs = $Body.conditions.ref_name.include[0]
        $matching = @($all | Where-Object { $_.target -eq $Body.target } | ForEach-Object { Invoke-GhApi -Endpoint "repos/$Repository/rulesets/$($_.id)" } |
            Where-Object { @($_.conditions.ref_name.include) -contains $refs })
        if ($matching.Count -eq 1) { $Body.name = $matching[0].name }
    }
    if ($matching.Count -gt 1) { throw "$Repository has $($matching.Count) $($Body.target) rulesets for the same refs ($(@($matching | ForEach-Object { "'$($_.name)'" }) -join ', ')). Merge them into one, then run this again." }
    $action = if ($matching.Count) { "Update $($Body.target) ruleset '$($Body.name)' (id $($matching[0].id))" } else { "Create $($Body.target) ruleset '$($Body.name)'" }
    if ($PSCmdlet.ShouldProcess($Repository, $action)) {
        if ($matching.Count) { $null = Invoke-GhApi -Method PUT -Endpoint "repos/$Repository/rulesets/$($matching[0].id)" -Body $Body }
        else { $null = Invoke-GhApi -Method POST -Endpoint "repos/$Repository/rulesets" -Body $Body }
        Write-Host "Done: $action"
    } elseif ($WhatIfPreference) {
        Write-Host (ConvertTo-Json -InputObject $Body -Depth 20)
    }
}

function Send-Setting {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)][string] $Action, [Parameter(Mandatory = $true)][bool] $Needed, [Parameter(Mandatory = $true)][string] $Method, [Parameter(Mandatory = $true)][string] $Endpoint, $Body)
    if (-not $Needed) { Write-Host "Already in place: $Action"; return }
    if ($PSCmdlet.ShouldProcess($Repository, $Action)) {
        $null = Invoke-GhApi -Method $Method -Endpoint $Endpoint -Body $Body
        Write-Host "Done: $Action"
    } elseif ($WhatIfPreference -and $null -ne $Body) {
        Write-Host "$Method $Endpoint $(ConvertTo-Json -InputObject $Body -Depth 20 -Compress)"
    }
}

$repo = Assert-GhRepository -Repository $Repository -Permission admin

# 1. The default branch.
$mainRules = @(
    @{ type = 'deletion' },
    @{ type = 'non_fast_forward' },
    @{ type = 'pull_request'; parameters = [ordered]@{
            required_approving_review_count   = 0
            dismiss_stale_reviews_on_push     = $false
            require_code_owner_review         = $false
            require_last_push_approval        = $false
            required_review_thread_resolution = $true
        }
    },
    @{ type = 'required_status_checks'; parameters = [ordered]@{
            strict_required_status_checks_policy = $true
            do_not_enforce_on_create             = $false
            required_status_checks               = @($RequiredChecks | ForEach-Object { [ordered]@{ context = $_; integration_id = $GitHubActionsAppId } })
        }
    }
)
if ($CopilotReview) {
    $mainRules += @{ type = 'copilot_code_review'; parameters = [ordered]@{ review_on_push = $false; review_draft_pull_requests = $false } }
}
Set-Ruleset -Body ([ordered]@{
        name          = 'Protect main'
        target        = 'branch'
        enforcement   = 'active'
        bypass_actors = @()
        conditions    = @{ ref_name = [ordered]@{ include = @('~DEFAULT_BRANCH'); exclude = @() } }
        rules         = $mainRules
    })

# 2. Every tag, not only v*: a tag can carry another ref's name, such as origin/main (RELEASE.md).
Set-Ruleset -Body ([ordered]@{
        name          = 'Protect tags'
        target        = 'tag'
        enforcement   = 'active'
        bypass_actors = @([ordered]@{ actor_id = $RepositoryAdminRoleId; actor_type = 'RepositoryRole'; bypass_mode = 'always' })
        conditions    = @{ ref_name = [ordered]@{ include = @('~ALL'); exclude = @() } }
        rules         = @(
            @{ type = 'creation' },
            # No parameters: update_allows_fetch_and_merge is for branches, and GitHub drops it here.
            @{ type = 'update' },
            @{ type = 'deletion' }
        )
    })

# 3-5. Repository settings, each sent only when it differs from what is set now.
$wanted = [ordered]@{ delete_branch_on_merge = $true; allow_update_branch = $true }
if ($MergeMethods) {
    $wanted.allow_merge_commit = $MergeMethods -contains 'merge'
    $wanted.allow_squash_merge = $MergeMethods -contains 'squash'
    $wanted.allow_rebase_merge = $MergeMethods -contains 'rebase'
}
$general = [ordered]@{}
foreach ($key in @($wanted.Keys)) { if ($repo.$key -ne $wanted[$key]) { $general[$key] = $wanted[$key] } }
Send-Setting -Action 'Delete head branches after merge, offer branch updates' -Needed ($general.Count -gt 0) -Method PATCH -Endpoint "repos/$Repository" -Body $general

$security = [ordered]@{}
$current = if ($repo.PSObject.Properties['security_and_analysis']) { $repo.security_and_analysis } else { $null }
foreach ($feature in @('secret_scanning', 'secret_scanning_push_protection')) {
    $status = if ($current -and $current.PSObject.Properties[$feature]) { $current.$feature.status } else { $null }
    if ($status -ne 'enabled') { $security[$feature] = @{ status = 'enabled' } }
}
Send-Setting -Action 'Turn on secret scanning and push protection' -Needed ($security.Count -gt 0) -Method PATCH -Endpoint "repos/$Repository" -Body @{ security_and_analysis = $security }

$reporting = Invoke-GhApi -Endpoint "repos/$Repository/private-vulnerability-reporting"
Send-Setting -Action 'Turn on private vulnerability reporting' -Needed (-not $reporting.enabled) -Method PUT -Endpoint "repos/$Repository/private-vulnerability-reporting"

$workflow = Invoke-GhApi -Endpoint "repos/$Repository/actions/permissions/workflow"
Send-Setting -Action 'Make the default workflow token read-only' -Needed ($workflow.default_workflow_permissions -ne 'read' -or [bool]$workflow.can_approve_pull_request_reviews) -Method PUT -Endpoint "repos/$Repository/actions/permissions/workflow" -Body ([ordered]@{
        default_workflow_permissions     = 'read'
        can_approve_pull_request_reviews = $false
    })

# 6. Read back and check.
$rulesets = @(Get-GhList -Endpoint "repos/$Repository/rulesets?includes_parents=false")
$details = @($rulesets | ForEach-Object { Invoke-GhApi -Endpoint "repos/$Repository/rulesets/$($_.id)" })
$branch = [uri]::EscapeDataString($repo.default_branch)
$effective = @(Get-GhList -Endpoint "repos/$Repository/rules/branches/$branch")
$settings = Invoke-GhApi -Endpoint "repos/$Repository"
$reporting = Invoke-GhApi -Endpoint "repos/$Repository/private-vulnerability-reporting"
$workflow = Invoke-GhApi -Endpoint "repos/$Repository/actions/permissions/workflow"

$ruleTypes = @($effective | ForEach-Object { $_.type })
$statusRules = @($effective | Where-Object { $_.type -eq 'required_status_checks' })
$required = @($statusRules | ForEach-Object { $_.parameters.required_status_checks })
$unpinned = @($RequiredChecks | Where-Object {
        $context = $_
        -not @($required | Where-Object { $_.context -eq $context -and $_.PSObject.Properties['integration_id'] -and $_.integration_id -eq $GitHubActionsAppId }).Count
    })
$upToDate = [bool]@($statusRules | Where-Object { $_.parameters.strict_required_status_checks_policy }).Count
$pullRequest = @($effective | Where-Object { $_.type -eq 'pull_request' -and $_.parameters.required_review_thread_resolution -and $_.parameters.required_approving_review_count -eq 0 })
$mainRuleset = @($details | Where-Object { $_.target -eq 'branch' -and $_.enforcement -eq 'active' -and @($_.conditions.ref_name.include) -contains '~DEFAULT_BRANCH' })
$mainBypass = @($mainRuleset | ForEach-Object { @($_.bypass_actors) } | Where-Object { $_ })
$tagRuleset = @($details | Where-Object { $_.target -eq 'tag' -and $_.enforcement -eq 'active' -and @($_.conditions.ref_name.include) -contains '~ALL' })
$tagRules = @($tagRuleset | ForEach-Object { $_.rules } | ForEach-Object { $_.type })
$tagBypass = @($tagRuleset | ForEach-Object { @($_.bypass_actors) } | Where-Object { $_ })
$adminsOnly = $tagBypass.Count -gt 0 -and -not @($tagBypass | Where-Object { -not ($_.actor_type -eq 'RepositoryRole' -and $_.actor_id -eq $RepositoryAdminRoleId) }).Count
$security = if ($settings.PSObject.Properties['security_and_analysis']) { $settings.security_and_analysis } else { $null }
$checks = @(
    [pscustomobject]@{ Check = "$($repo.default_branch): no deletion or force push"; Passed = ($ruleTypes -contains 'deletion') -and ($ruleTypes -contains 'non_fast_forward') },
    [pscustomobject]@{ Check = "$($repo.default_branch): pull request, 0 approvals, resolved conversations"; Passed = $pullRequest.Count -gt 0 },
    [pscustomobject]@{ Check = "$($repo.default_branch): every required check, from GitHub Actions, on an up-to-date branch"; Passed = -not $unpinned.Count -and $upToDate },
    [pscustomobject]@{ Check = "$($repo.default_branch): nobody may bypass"; Passed = $mainRuleset.Count -gt 0 -and -not $mainBypass.Count },
    [pscustomobject]@{ Check = 'All tags: create, move and delete restricted to repository admins'; Passed = ($tagRules -contains 'creation') -and ($tagRules -contains 'update') -and ($tagRules -contains 'deletion') -and $adminsOnly },
    [pscustomobject]@{ Check = 'Head branches deleted after merge, branch updates offered'; Passed = $settings.delete_branch_on_merge -and $settings.allow_update_branch },
    [pscustomobject]@{ Check = 'Secret scanning and push protection'; Passed = ($null -ne $security) -and $security.secret_scanning.status -eq 'enabled' -and $security.secret_scanning_push_protection.status -eq 'enabled' },
    [pscustomobject]@{ Check = 'Private vulnerability reporting'; Passed = [bool]$reporting.enabled },
    [pscustomobject]@{ Check = 'Read-only workflow token, no pull request approval'; Passed = $workflow.default_workflow_permissions -eq 'read' -and -not $workflow.can_approve_pull_request_reviews }
)
if ($CopilotReview) { $checks += [pscustomobject]@{ Check = "$($repo.default_branch): Copilot reviews each pull request"; Passed = $ruleTypes -contains 'copilot_code_review' } }

$report = New-Object System.Text.StringBuilder
$null = $report.AppendLine("## Repository governance read-back ($Repository)").AppendLine()
$null = $report.AppendLine("Read $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC by ``scripts/owner/Set-RepositoryGovernance.ps1``.").AppendLine()
$null = $report.AppendLine('| Check | Result |').AppendLine('|---|---|')
foreach ($check in $checks) { $null = $report.AppendLine("| $($check.Check) | $(if ($check.Passed) { 'pass' } else { 'FAIL' }) |") }
$sections = [ordered]@{ "Rules in effect on $($repo.default_branch)" = $effective }
foreach ($ruleset in $details) { $sections["Ruleset $($ruleset.id): $($ruleset.name)"] = $ruleset }
$sections['Repository settings'] = [ordered]@{
    delete_branch_on_merge = $settings.delete_branch_on_merge
    allow_update_branch    = $settings.allow_update_branch
    allow_merge_commit     = $settings.allow_merge_commit
    allow_squash_merge     = $settings.allow_squash_merge
    allow_rebase_merge     = $settings.allow_rebase_merge
    security_and_analysis  = $security
}
$sections['Private vulnerability reporting'] = $reporting
$sections['Workflow permissions'] = $workflow
foreach ($name in $sections.Keys) {
    $null = $report.AppendLine().AppendLine("<details><summary>$name</summary>").AppendLine().AppendLine('```json')
    $null = $report.AppendLine((ConvertTo-Json -InputObject $sections[$name] -Depth 20)).AppendLine('```').AppendLine().AppendLine('</details>')
}
$checks | Format-Table -AutoSize | Out-String | Write-Host
if ($WhatIfPreference) {
    Write-Host 'That is the current state; nothing was changed.'
    return
}
Write-Utf8File -Path $EvidencePath -Text $report.ToString()
Write-Host "Read-back written to $EvidencePath"
if ($PostEvidence -and $PSCmdlet.ShouldProcess("$Repository issue #3", 'Post the read-back')) {
    $null = Invoke-Gh -ArgumentList @('issue', 'comment', '3', '--repo', $Repository, '--body-file', $EvidencePath)
    Write-Host 'Posted the read-back to #3.'
}
$failed = @($checks | Where-Object { -not $_.Passed })
if ($failed.Count) { throw "$($failed.Count) setting(s) did not read back as expected; see $EvidencePath." }
