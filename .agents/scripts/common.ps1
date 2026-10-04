#Requires -Version 7.0
# Shared primitives; dot-source only from the Harness entry points.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Initialize-Harness {
    param([string]$RepoRoot)
    if (-not (Get-Module -ListAvailable -Name powershell-yaml)) {
        throw "Missing module 'powershell-yaml'. Run: Install-Module powershell-yaml -RequiredVersion 0.4.12 -Scope CurrentUser"
    }
    Import-Module powershell-yaml -RequiredVersion 0.4.12 -ErrorAction Stop
    $root = [IO.Path]::GetFullPath($RepoRoot)
    if (-not [IO.Directory]::Exists($root)) { throw 'Repository root does not exist' }
    # Reject links/junctions at every ancestor, including the supplied root.
    $ancestor = Get-Item -LiteralPath $root
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked repository root is not supported' }
        $ancestor = $ancestor.Parent
    }
    return $root
}

function Resolve-HarnessPath {
    param([string]$Root, [string]$Path, [switch]$AllowMissing)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Empty artifact path' }
    if ($Path.Split([char[]]'\/') -contains '..') { throw 'Parent traversal is not an artifact reference' }
    $full = [IO.Path]::GetFullPath($Path, $Root)
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $comparison)) { throw 'Artifact path escapes repository' }
    $relative = [IO.Path]::GetRelativePath($Root, $full)
    $part = $Root
    foreach ($segment in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
        $part = Join-Path $part $segment
        if (Test-Path -LiteralPath $part) {
            if ((Get-Item -LiteralPath $part).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked artifact path is not supported' }
        }
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $full)) { throw "Missing artifact: $relative" }
    return $full
}

function Read-HarnessYaml {
    param([string]$Path)
    $value = ConvertFrom-Yaml -Yaml ([IO.File]::ReadAllText($Path)) -Ordered
    if ($value -isnot [Collections.IDictionary]) { throw 'YAML artifact must be a mapping' }
    return $value
}

function Read-HarnessFrontmatter {
    param([string]$Path)
    $raw = [IO.File]::ReadAllText($Path)
    $match = [regex]::Match($raw, '\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)', 'Singleline')
    if (-not $match.Success) { throw 'Missing artifact frontmatter' }
    $value = ConvertFrom-Yaml -Yaml $match.Groups[1].Value -Ordered
    if ($value -isnot [Collections.IDictionary]) { throw 'Frontmatter must be a mapping' }
    return $value
}

function Get-HarnessValue {
    param($Map, [string]$Key)
    if ($Map -is [Collections.IDictionary] -and $Map.Contains($Key)) { return $Map[$Key] }
    return $null
}

function Assert-HarnessDate {
    param([string]$Value, [switch]$Timestamp)
    $date = [datetime]::MinValue
    $formats = if ($Timestamp) { @("yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'") } else { @('yyyy-MM-dd') }
    if (-not [datetime]::TryParseExact($Value, [string[]]$formats, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None, [ref]$date)) { throw 'Invalid calendar date or timestamp' }
}

function Get-HarnessSkills {
    param([string]$Root)
    $directory = Resolve-HarnessPath $Root '.agents/skills'
    $skills = @(Get-ChildItem -LiteralPath $directory -Directory)
    if ($skills.Count -eq 0) { throw 'No skills found' }
    foreach ($skill in $skills) {
        $path = Resolve-HarnessPath $Root ".agents/skills/$($skill.Name)/SKILL.md"
        $fm = Read-HarnessFrontmatter $path
        $metadata = Get-HarnessValue $fm 'metadata'
        if ($metadata -isnot [Collections.IDictionary]) { throw 'Missing skill metadata mapping' }
        if ((Get-HarnessValue $fm 'name') -cne $skill.Name -or $skill.Name -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $skill.Name.Length -ge 64) { throw 'Invalid skill identity' }
        if ([string]::IsNullOrWhiteSpace((Get-HarnessValue $fm 'description'))) { throw 'Missing skill description' }
        if ((Get-HarnessValue $metadata 'version') -notmatch '^\d+\.\d+\.\d+$') { throw 'Missing skill version' }
        if ((Get-HarnessValue $metadata 'snapshotPath') -cne ".agents/cold-start/snapshots/$($skill.Name).snapshot.md") { throw 'Invalid snapshot reference' }
        if ((Get-HarnessValue $metadata 'driftStatus') -ne 'inactive' -or $metadata.Contains('driftPolicy') -or $metadata.Contains('driftPolicyPath')) { throw 'Skill drift activation needs a separate reviewed implementation' }
        [pscustomobject]@{ Name = $skill.Name; Path = $path; Metadata = $metadata }
    }
}

function Get-SafeCheckInvocation {
    param([string]$Root, [string]$Command)
    # Exact catalog. A spec/config cannot add programs, arguments or shell syntax.
    if ($Command -ceq 'node --version') { return @{ Program = 'node'; Arguments = @('--version') } }
    $scripts = @{
        'pnpm typecheck' = @('typecheck', 'tsc --noEmit')
        'pnpm build' = @('build', 'vite build')
        'pnpm test' = @('test', 'vitest run')
        'pnpm schemas:check' = @('schemas:check', 'node scripts/check-schemas.mjs')
        'pnpm secrets:check' = @('secrets:check', 'node scripts/check-secrets.mjs')
        'pnpm repository:check' = @('repository:check', 'tsx scripts/check-repository-consistency.ts')
        'pnpm evals:check' = @('evals:check', 'tsx scripts/run-evals.ts && tsx scripts/run-outcome-evals.ts')
    }
    if (@($scripts.Keys) -cnotcontains $Command) { throw 'Acceptance command is not in the exact local catalog' }
    $definition = $scripts[$Command]
    $package = [IO.File]::ReadAllText((Resolve-HarnessPath $Root 'package.json')) | ConvertFrom-Json -AsHashtable
    if (-not $package.ContainsKey('scripts') -or $package.scripts[$definition[0]] -cne $definition[1]) { throw 'Package check implementation has changed; review the catalog' }
    if ($package.scripts.ContainsKey("pre$($definition[0])") -or $package.scripts.ContainsKey("post$($definition[0])")) { throw 'Acceptance lifecycle hooks need separate review' }
    return @{ Program = 'pnpm'; Arguments = @($definition[0]) }
}

function Assert-HarnessSpec {
    param([string]$Root, [string]$Path)
    $raw = [IO.File]::ReadAllText($Path)
    $spec = Read-HarnessYaml $Path
    $schema = Resolve-HarnessPath $Root '.agents/contracts/spec.schema.json'
    if (-not (Test-Json -Json ($spec | ConvertTo-Json -Depth 40) -SchemaFile $schema -ErrorAction SilentlyContinue)) { throw 'Spec violates structural schema' }
    $dc = $spec.designContract
    $markers = [regex]::Matches($raw, '\[NEEDS CLARIFICATION', 'IgnoreCase').Count
    if ($markers -gt 5 -or ($dc.status -eq 'approved' -and $markers -gt 0)) { throw 'Unresolved clarification markers' }
    if ($null -ne $dc.approvedAt) { Assert-HarnessDate $dc.approvedAt -Timestamp }
    if ($null -ne $dc.checksWaiver) { Assert-HarnessDate $dc.checksWaiver.date }
    foreach ($answer in @($spec.clarifications)) { Assert-HarnessDate $answer.date }
    $requirements = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($requirement in $spec.requirements) {
        if (-not $requirements.Add($requirement.id)) { throw 'Duplicate requirement id' }
    }
    $checkIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $covered = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($check in @($dc.acceptanceChecks)) {
        if (-not $checkIds.Add($check.id)) { throw 'Duplicate acceptance check id' }
        foreach ($id in $check.requirementIds) {
            if (-not $requirements.Contains($id)) { throw 'Unknown acceptance requirement reference' }
            [void]$covered.Add($id)
        }
        if ($dc.status -eq 'approved' -and $check.command.Trim() -ine 'placeholder') { [void](Get-SafeCheckInvocation $Root $check.command) }
    }
    if ($dc.status -eq 'approved') {
        foreach ($text in @($spec.name, $spec.entity, $spec.purpose, $dc.reviewedBy) + @($spec.domains) + @($spec.requirements | ForEach-Object { $_.description }) + @($dc.acceptanceChecks | ForEach-Object { $_.description })) {
            if ([string]$text -match '^\s*placeholder\s*$') { throw 'Approved spec contains scaffold text' }
        }
        if ($null -eq $dc.checksWaiver -and $covered.Count -ne $requirements.Count) { throw 'Approved requirements lack acceptance coverage' }
    }
    return $spec
}

function Invoke-HarnessCheck {
    param([string]$Root, $Invocation, [int]$TimeoutSeconds)
    $executable = (Get-Command $Invocation.Program -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    # On Windows the package manager is a .cmd shim; execute its JS entry
    # through Node directly, never through cmd.exe or a shell evaluator.
    if ($IsWindows -and $Invocation.Program -eq 'pnpm') {
        $entry = Join-Path (Split-Path $executable) 'node_modules/pnpm/bin/pnpm.cjs'
        if (-not (Test-Path -LiteralPath $entry)) { throw 'Cannot safely resolve package-manager JS entry; install pnpm using its standard npm launcher' }
        $executable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $arguments = @($entry) + $Invocation.Arguments
    } else { $arguments = $Invocation.Arguments }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $executable
    $info.WorkingDirectory = $Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $arguments) { [void]$info.ArgumentList.Add($argument) }
    # Do not expose inherited credentials, package-manager hooks or Node injection.
    $info.Environment.Clear()
    foreach ($name in @('PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $info.Environment[$name] = $value }
    }
    $info.Environment['CI'] = '1'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        # Drain concurrently and discard raw output; surface only exit evidence.
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill($true); $process.WaitForExit(); throw 'Acceptance check timed out; process tree terminated'
        }
        [void]$stdout.GetAwaiter().GetResult(); [void]$stderr.GetAwaiter().GetResult()
        return $process.ExitCode
    } finally { $process.Dispose() }
}
