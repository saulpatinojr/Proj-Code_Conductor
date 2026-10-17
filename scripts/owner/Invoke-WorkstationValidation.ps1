<#
.SYNOPSIS
    Collects the workstation evidence of docs/WORKSTATION-VALIDATION.md section 13 for #4.

.DESCRIPTION
    Runs, in this order, the checks that need no judgement, and writes a Markdown report
    that holds the section 13 checklist. The items only you can judge are left unchecked
    for you to complete before posting it.

    1. The process check (section 10): no process may name the installed extension's
       folder. Run this right after a warm start of VS Code; this check comes before the
       script starts ccon itself.
    2. OS, VS Code version and workspace kind (local, WSL, SSH or container).
    3. With -PackageDirectory, the release files: SHA256SUMS, and each file's attestation
       pinned to the Release workflow, tag and commit (docs/RELEASE.md).
    4. Provider and tool versions (section 4).
    5. ccon doctor on -Repository.
    6. With -Smoke, ccon harness-smoke read, then modify only after read passes, for each
       client named. Smoke tests run the real clients on your subscriptions. Kiro also
       needs -AckKiroPolicy, after you have read Kiro's current subscription and automation
       terms.
    7. The compress boundary (ADR 0007): reads on Linux and WSL, refuses on Windows and macOS.

    The report keeps no repository content, and your home folder, email addresses and
    token-like strings are replaced. Read it before you post it.

.PARAMETER CconPath
    The extension's dist/ccon.js. Found among the installed VS Code extensions when omitted.

.PARAMETER Repository
    The repository to run Doctor in. Defaults to the current folder.

.PARAMETER Smoke
    The clients to smoke-test: claude, codex, kiro.

.PARAMETER AckKiroPolicy
    You have read Kiro's current subscription and automation terms and they allow this use.

.PARAMETER PackageDirectory
    The folder holding the downloaded release files and SHA256SUMS.

.PARAMETER SourceCommit
    The commit the release notes name. Needed with -PackageDirectory.

.PARAMETER GitHubRepository
    The repository that published the release, as owner/name.

.PARAMETER OutFile
    Where to write the report. Defaults to a file in your temporary folder.

.EXAMPLE
    .\scripts\owner\Invoke-WorkstationValidation.ps1

.EXAMPLE
    .\scripts\owner\Invoke-WorkstationValidation.ps1 -Smoke claude,codex,kiro -AckKiroPolicy -PackageDirectory ~\Downloads\v0.2.0 -SourceCommit 0123456789abcdef0123456789abcdef01234567
#>
#Requires -Version 5.1
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive owner script: progress is for the console, results go to the pipeline.')]
[CmdletBinding()]
param(
    [string] $CconPath,
    [string] $Repository = (Get-Location).Path,
    [ValidateSet('claude', 'codex', 'kiro')]
    [string[]] $Smoke = @(),
    [switch] $AckKiroPolicy,
    [string] $PackageDirectory,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string] $SourceCommit,
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$')]
    [string] $GitHubRepository = 'saulpatinojr/Proj-Code_Conductor',
    [string] $OutFile = (Join-Path ([System.IO.Path]::GetTempPath()) ("code-conductor-workstation-{0}.md" -f (Get-Date -Format 'yyyyMMdd-HHmmss')))
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OwnerTools.psm1') -Force

$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$onLinux = (-not $onWindows) -and [bool](Get-Variable -Name IsLinux -ValueOnly -ErrorAction SilentlyContinue)
if ($PackageDirectory -and -not $SourceCommit) { throw '-PackageDirectory needs -SourceCommit: the full commit the release notes name.' }
$Repository = (Resolve-Path -LiteralPath $Repository).ProviderPath

function Find-CconRuntime {
    $roots = foreach ($name in @('.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders')) { Join-Path (Join-Path $HOME $name) 'extensions' }
    $found = foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        # VS Code lists replaced versions here until it deletes their folders.
        $obsolete = @()
        $marker = Join-Path $root '.obsolete'
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            try { $obsolete = @((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $_.Name }) } catch { $obsolete = @() }
        }
        foreach ($folder in @(Get-ChildItem -LiteralPath $root -Directory -Filter '*.code-conductor-vscode-*')) {
            if ($obsolete -contains $folder.Name -or $folder.Name -notmatch '^(?<id>[^.]+\.code-conductor-vscode)-(?<version>\d+\.\d+\.\d+)$') { continue }
            $id = $Matches.id
            $version = [version]$Matches.version
            $runtime = Join-Path (Join-Path $folder.FullName 'dist') 'ccon.js'
            if (Test-Path -LiteralPath $runtime -PathType Leaf) { [pscustomobject]@{ Id = $id; Version = $version; Extension = $folder.FullName; Runtime = $runtime } }
        }
    }
    $found = @($found)
    if (-not $found.Count) { throw 'No installed Code Conductor extension was found. Install the VSIX (docs/INSTALL.md), or pass -CconPath.' }
    $ids = @($found | ForEach-Object { $_.Id } | Select-Object -Unique)
    if ($ids.Count -gt 1) { throw "More than one Code Conductor extension is installed ($($ids -join ', ')). Pass -CconPath with the one to validate." }
    $found | Sort-Object -Property Version -Descending | Select-Object -First 1
}

function Get-ExtensionProcess([string] $Folder) {
    $needle = $Folder.TrimEnd('\', '/').Replace('/', '\')
    $all = if ($onWindows) {
        Get-CimInstance -ClassName Win32_Process | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; CommandLine = [string]$_.CommandLine } }
    } else {
        (Invoke-Native -FilePath 'ps' -ArgumentList @('-axo', 'pid=,args=')).Output | ForEach-Object {
            if ($_ -match '^\s*(\d+)\s+(.*)$') { [pscustomobject]@{ Id = [int]$Matches[1]; CommandLine = $Matches[2] } }
        }
    }
    @($all | Where-Object { $_.Id -ne $PID -and $_.CommandLine -and $_.CommandLine.Replace('/', '\').IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Get-FirstLine($Result) { @($Result.Output + $Result.Errors | Where-Object { $_.Trim() }) | Select-Object -First 1 }
function Get-LastLine($Result) { @($Result.Output + $Result.Errors | Where-Object { $_.Trim() }) | Select-Object -Last 1 }

$details = [ordered]@{}

# Node runs the bundled runtime (section 1).
$node = Invoke-Native -FilePath 'node' -ArgumentList @('--version')
if ($node.ExitCode -ne 0 -or (Get-FirstLine $node) -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw "Node 22 or later is needed on PATH (docs/WORKSTATION-VALIDATION.md section 1); found '$(Get-FirstLine $node)'." }

if ($CconPath) {
    $runtime = (Resolve-Path -LiteralPath $CconPath).ProviderPath
    $extension = Split-Path -Parent (Split-Path -Parent $runtime)
    $extensionId = Split-Path -Leaf $extension
} else {
    $installed = Find-CconRuntime
    $runtime = $installed.Runtime
    $extension = $installed.Extension
    $extensionId = "$($installed.Id) $($installed.Version)"
}
Write-Host "Validating $extensionId"

# 1. Before anything here starts ccon.
$processes = @(Get-ExtensionProcess -Folder $extension)
$details['Processes naming the extension folder'] = if ($processes.Count) { @($processes | ForEach-Object { "$($_.Id) $($_.CommandLine)" }) } else { @('none') }

# 2. The machine.
$os = if ($onWindows) { $info = Get-CimInstance -ClassName Win32_OperatingSystem; "$($info.Caption) $($info.Version)" }
else { (Get-FirstLine (Invoke-Native -FilePath 'uname' -ArgumentList @('-srm'))) }
$workspace = if ($env:WSL_DISTRO_NAME) { 'WSL' } elseif ($env:REMOTE_CONTAINERS -or $env:CODESPACES -or (Test-Path -LiteralPath '/.dockerenv')) { 'container' } elseif ($env:SSH_CONNECTION) { 'SSH' } else { 'local' }
$code = if (Get-Command -Name 'code' -CommandType Application -ErrorAction SilentlyContinue) { Get-FirstLine (Invoke-Native -FilePath 'code' -ArgumentList @('--version')) } else { 'code CLI not on PATH' }
$machine = "$os; VS Code $code; workspace $workspace (detected); PowerShell $($PSVersionTable.PSVersion)"

# 3. The release files.
$package = $null
if ($PackageDirectory) {
    $lines = New-Object System.Collections.Generic.List[string]
    $ok = $true
    foreach ($line in @(Get-Content -LiteralPath (Join-Path $PackageDirectory 'SHA256SUMS'))) {
        if (-not $line.Trim()) { continue }
        if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64}) [ *](?<file>[^\\/]+)$') { throw "SHA256SUMS has a line that is not '<hash>  <file name>': $line" }
        $file = $Matches.file
        $expected = $Matches.hash
        $path = Join-Path $PackageDirectory $file
        $hashOk = (Test-Path -LiteralPath $path -PathType Leaf) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -eq $expected
        $lines.Add("sha256 $file : $(if ($hashOk) { 'OK' } else { 'FAILED' })")
        if ($file -notmatch '^code-conductor-(?<version>\d+\.\d+\.\d+)(\.vsix|\.cdx\.json)$') { $ok = $false; $lines.Add("attestation $file : not a release file name"); continue }
        $tag = "v$($Matches.version)"
        $verify = Invoke-Native -FilePath 'gh' -ArgumentList @('attestation', 'verify', $path, '--repo', $GitHubRepository,
            '--cert-identity', "https://github.com/$GitHubRepository/.github/workflows/release.yml@refs/tags/$tag",
            '--source-ref', "refs/tags/$tag", '--source-digest', $SourceCommit, '--deny-self-hosted-runners')
        $lines.Add("attestation $file ($tag) : $(if ($verify.ExitCode -eq 0) { 'verified' } else { "FAILED: $(Get-LastLine $verify)" })")
        $ok = $ok -and $hashOk -and $verify.ExitCode -eq 0
    }
    $onMain = Invoke-Native -FilePath 'gh' -ArgumentList @('api', "repos/$GitHubRepository/compare/$SourceCommit...main", '--jq', '.status')
    $status = Get-FirstLine $onMain
    $lines.Add("commit $SourceCommit on main: $(if ($onMain.ExitCode -eq 0 -and @('ahead', 'identical') -contains $status) { 'yes' } else { "NO ($status)" })")
    $ok = $ok -and $onMain.ExitCode -eq 0 -and @('ahead', 'identical') -contains $status
    $details['Release files'] = $lines.ToArray()
    $package = $ok
}

# 4. Versions.
$tools = [ordered]@{ node = '--version'; git = '--version'; gh = '--version'; apm = '--version'; claude = '--version'; codex = '--version'; 'kiro-cli' = '--version'; agy = '--version'; terraform = 'version'; ansible = '--version'; pwsh = '--version' }
$details['Provider and tool versions'] = @(foreach ($tool in $tools.Keys) {
        if (Get-Command -Name $tool -CommandType Application -ErrorAction SilentlyContinue) { "${tool}: $(Get-FirstLine (Invoke-Native -FilePath $tool -ArgumentList @($tools[$tool])))" }
        else { "${tool}: not found" }
    })

# 5. Doctor.
Write-Host 'Running ccon doctor...'
$doctor = Invoke-Native -FilePath 'node' -ArgumentList @($runtime, 'doctor', $Repository)
$details["ccon doctor (exit $($doctor.ExitCode))"] = @($doctor.Output + $doctor.Errors)

# 6. Smoke tests.
$smokeResults = @(foreach ($client in $Smoke) {
        if ($client -eq 'kiro' -and -not $AckKiroPolicy) {
            [pscustomobject]@{ Client = $client; Mode = 'read'; Outcome = 'not run'; Line = "pass -AckKiroPolicy after reading Kiro's current subscription and automation terms" }
            continue
        }
        foreach ($mode in @('read', 'modify')) {
            $arguments = @($runtime, 'harness-smoke', $client, '--mode', $mode)
            if ($client -eq 'kiro') { $arguments += '--ack-kiro-policy' }
            Write-Host "Running the $client $mode smoke test (up to 3 minutes)..."
            $result = Invoke-Native -FilePath 'node' -ArgumentList $arguments
            [pscustomobject]@{ Client = $client; Mode = $mode; Outcome = $(if ($result.ExitCode -eq 0) { 'pass' } else { 'FAIL' }); Line = "exit $($result.ExitCode): $(Get-LastLine $result)" }
            # Modify only after read passed.
            if ($result.ExitCode -ne 0) { break }
        }
    })
if ($smokeResults.Count) { $details['ccon harness-smoke'] = @($smokeResults | ForEach-Object { "$($_.Client) $($_.Mode) $($_.Outcome), $($_.Line)" }) }

# 7. The compress boundary. Only the outcome is kept, never the prepared content.
$sample = Join-Path $Repository 'README.md'
$compress = 'not checked: the repository has no README.md'
if (Test-Path -LiteralPath $sample -PathType Leaf) {
    $result = Invoke-Native -FilePath 'node' -ArgumentList @($runtime, 'compress', $sample, '--root', $Repository)
    $outcome = if ($result.ExitCode -eq 0) { @($result.Output | Where-Object { $_ -like 'Estimated tokens saved*' }) | Select-Object -First 1 } else { @($result.Errors)[0] }
    $documented = ($result.ExitCode -eq 0) -eq $onLinux
    $compress = "README.md exit $($result.ExitCode), $(if ($documented) { 'as documented' } else { 'NOT as documented' }) for this OS: $outcome"
}
$details['Compress boundary (ADR 0007)'] = @($compress)

# The report.
function Get-Mark([bool] $Done) { if ($Done) { '[x]' } else { '[ ]' } }
$smokeSummary = if ($smokeResults.Count) { ($smokeResults | ForEach-Object { "$($_.Client) $($_.Mode) $($_.Outcome)" }) -join '; ' } else { '*fill in* (run with -Smoke claude,codex,kiro)' }
$smokedAll = -not (@('claude', 'codex', 'kiro') | Where-Object { $client = $_; -not @($smokeResults | Where-Object { $_.Client -eq $client -and $_.Outcome -ne 'not run' }).Count })
$report = New-Object System.Text.StringBuilder
$null = $report.AppendLine('## Workstation validation evidence').AppendLine()
$null = $report.AppendLine("Collected $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm')) UTC by ``scripts/owner/Invoke-WorkstationValidation.ps1`` for $extensionId. Items marked *fill in* are yours.").AppendLine()
$null = $report.AppendLine("- $(Get-Mark ($package -eq $true)) Package, checksums and attestation: $(if ($null -eq $package) { '*fill in* (run with -PackageDirectory and -SourceCommit)' } elseif ($package) { 'verified' } else { 'FAILED, see below' })")
$null = $report.AppendLine("- [x] OS, VS Code and workspace: $machine")
$null = $report.AppendLine('- [x] Provider and tool versions: below')
$null = $report.AppendLine("- [x] ``ccon doctor``: exit $($doctor.ExitCode), below")
$null = $report.AppendLine("- $(Get-Mark $smokedAll) ``ccon harness-smoke`` read and modify: $smokeSummary")
$null = $report.AppendLine("- [ ] Activation times, first run / warm start / changed configuration: *fill in* (Developer: Show Running Extensions). Process check: $(if ($processes.Count) { "$($processes.Count) process(es) named the extension folder, below" } else { 'none named the extension folder' })")
$null = $report.AppendLine('- [ ] Minimum MCP and tool profiles used: *fill in*')
$null = $report.AppendLine('- [ ] R1 and R2 run IDs, structured results and gates: *fill in*')
$null = $report.AppendLine('- [ ] Worktree and draft pull request: `ccon pr` preview, the URL, `ccon github-gate` before and after re-review: *fill in*')
$null = $report.AppendLine('- [ ] Final readiness decision, and who made it: *fill in*')
$null = $report.AppendLine("- [x] Compress boundary: $compress")
foreach ($name in $details.Keys) {
    $null = $report.AppendLine().AppendLine("<details><summary>$name</summary>").AppendLine().AppendLine('```text')
    foreach ($line in @($details[$name])) { $null = $report.AppendLine([string]$line) }
    $null = $report.AppendLine('```').AppendLine().AppendLine('</details>')
}
# One pass over the whole report: machine details appear outside the sections too.
Write-Utf8File -Path $OutFile -Text (Protect-EvidenceText $report.ToString())

Write-Host @"

Report written to $OutFile
Read it, complete the *fill in* items, then post it to #4:
  gh issue comment 4 --repo $GitHubRepository --body-file "$OutFile"
"@
