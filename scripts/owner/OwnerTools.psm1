# Helpers shared by the owner scripts in this folder. They run on Windows PowerShell 5.1
# and PowerShell 7, so the files stay ASCII (5.1 reads a file without a byte-order mark as
# the system code page) and avoid syntax newer than 5.1.
Set-StrictMode -Version 3.0

function Invoke-Native {
    <#
    .SYNOPSIS
        Runs a program and returns its exit code, standard output and standard error lines.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [string[]] $ArgumentList = @()
    )
    if (-not (Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue)) {
        throw "$FilePath was not found on PATH."
    }
    # Under ErrorActionPreference Stop, Windows PowerShell 5.1 stops at the first line a
    # program writes to standard error, so this sorts the two streams itself.
    $ErrorActionPreference = 'Continue'
    $out = New-Object System.Collections.Generic.List[string]
    $err = New-Object System.Collections.Generic.List[string]
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $err.Add($_.ToString()) } else { $out.Add([string]$_) }
    }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out.ToArray(); Errors = $err.ToArray() }
}

function Invoke-Gh {
    <#
    .SYNOPSIS
        Runs gh and returns its standard output; throws with gh's own message if it fails.
    #>
    param([Parameter(Mandatory = $true)][string[]] $ArgumentList)
    $result = Invoke-Native -FilePath 'gh' -ArgumentList $ArgumentList
    if ($result.ExitCode -ne 0) {
        $message = ($result.Errors + $result.Output) -join ' '
        throw "gh $($ArgumentList[0]) failed (exit $($result.ExitCode)): $message"
    }
    $result.Output -join "`n"
}

function Write-Utf8File {
    <#
    .SYNOPSIS
        Writes text as UTF-8 without a byte-order mark, which gh and GitHub expect.
    #>
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Invoke-GhApi {
    <#
    .SYNOPSIS
        Calls the GitHub REST API through gh and returns the parsed response, or $null.
    .DESCRIPTION
        A request body goes through a temporary file: Windows PowerShell 5.1 mangles quotes
        in native arguments and re-encodes piped text.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Endpoint,
        [ValidateSet('GET', 'POST', 'PUT', 'PATCH', 'DELETE')][string] $Method = 'GET',
        $Body
    )
    $arguments = @('api', '--hostname', 'github.com', '--method', $Method, '-H', 'Accept: application/vnd.github+json', $Endpoint)
    $inputFile = $null
    try {
        if ($null -ne $Body) {
            $inputFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ccon-owner-{0}.json" -f [guid]::NewGuid().ToString('N'))
            Write-Utf8File -Path $inputFile -Text (ConvertTo-Json -InputObject $Body -Depth 20)
            $arguments += @('--input', $inputFile)
        }
        $text = Invoke-Gh -ArgumentList $arguments
        if ($text.Trim()) { return (ConvertFrom-Json -InputObject $text) }
        return $null
    } finally {
        if ($inputFile) { Remove-Item -LiteralPath $inputFile -Force -ErrorAction SilentlyContinue }
    }
}

function Get-GhList {
    <#
    .SYNOPSIS
        Reads every page of a GitHub list endpoint (one that returns a JSON array).
    #>
    param([Parameter(Mandatory = $true)][string] $Endpoint)
    $separator = if ($Endpoint.Contains('?')) { '&' } else { '?' }
    $items = New-Object System.Collections.Generic.List[object]
    for ($page = 1; $page -le 100; $page++) {
        $batch = @(Invoke-GhApi -Endpoint "$Endpoint${separator}per_page=100&page=$page")
        foreach ($item in $batch) { if ($null -ne $item) { $items.Add($item) } }
        if ($batch.Count -lt 100) { return $items.ToArray() }
    }
    throw "$Endpoint has more than 10,000 entries; nothing was changed."
}

function Assert-GhRepository {
    <#
    .SYNOPSIS
        Checks the gh sign-in and your access to the repository, and returns the repository.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Repository,
        [ValidateSet('admin', 'push')][string] $Permission = 'admin'
    )
    $status = Invoke-Native -FilePath 'gh' -ArgumentList @('auth', 'status', '--hostname', 'github.com')
    if ($status.ExitCode -ne 0) { throw 'gh is not signed in to github.com. Run: gh auth login' }
    $repo = Invoke-GhApi -Endpoint "repos/$Repository"
    if (-not ($repo.PSObject.Properties['permissions'] -and $repo.permissions.$Permission)) {
        throw "Your gh account lacks $Permission access to $Repository. Sign in as the repository owner (gh auth login)."
    }
    $repo
}

function Protect-EvidenceText {
    <#
    .SYNOPSIS
        Removes your home folder, email addresses and token-like strings from evidence text.
    #>
    param([AllowEmptyString()][AllowNull()][string] $Text)
    if (-not $Text) { return $Text }
    $result = $Text
    # Longest first, so a longer form is replaced whole before a shorter one inside it.
    $homes = @($HOME, $env:USERPROFILE) | Where-Object { $_ -and $_.Length -gt 3 } | Select-Object -Unique | Sort-Object -Property Length -Descending
    foreach ($folder in $homes) {
        foreach ($form in @($folder, $folder.Replace('\', '/'))) {
            $result = [regex]::Replace($result, [regex]::Escape($form), '~', 'IgnoreCase')
        }
    }
    $result = [regex]::Replace($result, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]')
    [regex]::Replace($result, '(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})', '[redacted]')
}

Export-ModuleMember -Function Invoke-Native, Invoke-Gh, Write-Utf8File, Invoke-GhApi, Get-GhList, Assert-GhRepository, Protect-EvidenceText
