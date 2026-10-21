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
    # The program itself, by path: a profile's function or alias of the same name never runs.
    $program = Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $program) { throw "$FilePath was not found on PATH." }
    # Under ErrorActionPreference Stop, Windows PowerShell 5.1 stops at the first line a
    # program writes to standard error, so this sorts the two streams itself.
    $ErrorActionPreference = 'Continue'
    $out = New-Object System.Collections.Generic.List[string]
    $err = New-Object System.Collections.Generic.List[string]
    # PowerShell decodes a program's output with the console encoding, an OEM code page on
    # Windows; gh and git write UTF-8. A host without a console cannot change it.
    $encoding = $null
    try { $encoding = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $encoding = $null }
    $code = $null
    try {
        & $program.Path @ArgumentList 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $err.Add($_.ToString()) } else { $out.Add([string]$_) }
        }
        $code = $LASTEXITCODE
    } finally {
        if ($encoding) { try { [Console]::OutputEncoding = $encoding } catch { $encoding = $null } }
    }
    [pscustomobject]@{ ExitCode = $code; Output = $out.ToArray(); Errors = $err.ToArray() }
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
        throw "gh $($ArgumentList -join ' ') failed (exit $($result.ExitCode)): $message"
    }
    $result.Output -join "`n"
}

function Get-ConductorFolder {
    <#
    .SYNOPSIS
        Returns a folder under the one place Code Conductor writes: $env:CODE_CONDUCTOR_HOME, or .code-conductor in your home folder.
    .DESCRIPTION
        Creates the folder when it is missing. Reports and short-lived files go here, never the operating system's temporary folder.
    #>
    param([Parameter(Mandatory = $true)][string] $Subfolder)
    $base = if ($env:CODE_CONDUCTOR_HOME) { $env:CODE_CONDUCTOR_HOME } else { Join-Path $HOME '.code-conductor' }
    $path = Join-Path $base $Subfolder
    $null = New-Item -ItemType Directory -Path $path -Force
    return (Resolve-Path -LiteralPath $path).ProviderPath
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
            $inputFile = Join-Path (Get-ConductorFolder 'tmp') ("ccon-owner-{0}.json" -f [guid]::NewGuid().ToString('N'))
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
        # As written, with forward slashes, escaped in JSON, and as WSL sees a Windows folder.
        $forms = @($folder.Replace('\', '\\'), $folder, $folder.Replace('\', '/'))
        if ($folder -match '^([A-Za-z]):\\(.+)$') { $forms += "/mnt/$($Matches[1].ToLowerInvariant())/$($Matches[2].Replace('\', '/'))" }
        foreach ($form in $forms) { $result = [regex]::Replace($result, [regex]::Escape($form), '~', 'IgnoreCase') }
    }
    $result = [regex]::Replace($result, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]')
    $result = [regex]::Replace($result, '(AccountKey|SharedAccessSignature|sig)=[^;&\s"]+', '$1=[redacted]')
    $tokens = @(
        'gh[pousr]_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}', 'glpat-[A-Za-z0-9_-]{20,}', 'sk-[A-Za-z0-9_-]{20,}',
        'xox[abprs]-[A-Za-z0-9-]{10,}', 'AKIA[0-9A-Z]{16}', 'AIza[0-9A-Za-z_-]{35}', 'npm_[A-Za-z0-9]{36}',
        'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    )
    [regex]::Replace($result, '(' + ($tokens -join '|') + ')', '[redacted]')
}

function Resolve-OwnerPath {
    <#
    .SYNOPSIS
        Makes a path absolute against the current PowerShell location, expanding ~.
    .DESCRIPTION
        File methods in .NET, and programs, resolve a relative path against the process's
        own folder, which is not always PowerShell's location.
    #>
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)] $SessionState)
    $full = $SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    # Windows PowerShell 5.1 passes "C:\a b\" to a program as C:\a b" (the backslash escapes the quote).
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
    $full
}

Export-ModuleMember -Function Invoke-Native, Invoke-Gh, Get-ConductorFolder, Write-Utf8File, Invoke-GhApi, Get-GhList, Assert-GhRepository, Protect-EvidenceText, Resolve-OwnerPath
