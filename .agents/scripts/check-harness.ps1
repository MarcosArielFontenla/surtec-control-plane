#Requires -Version 7.0
param([string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
. "$PSScriptRoot/common.ps1"
try {
    $root = Initialize-Harness $RepoRoot
    $primer = Resolve-HarnessPath $root 'AGENTS.md'
    if ([IO.File]::ReadAllLines($primer).Count -gt 40) { throw 'Session primer exceeds 40 lines' }
    $fm = Read-HarnessFrontmatter $primer
    if ($fm.role -cne 'session-primer' -or $fm.registry -cne '.agents/AGENTS.md') { throw 'Invalid primer/registry identity' }
    $policy = [IO.File]::ReadAllText((Resolve-HarnessPath $root 'docs/architecture/harness-adapters/portability-policy.json')) | ConvertFrom-Json
    if ($policy.version -ne 1 -or @($policy.excludedCoreWords).Count -eq 0) { throw 'Invalid portability policy' }
    $pattern = '\b(?:' + (($policy.excludedCoreWords | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\b'
    $core = Resolve-HarnessPath $root '.agents'
    foreach ($file in Get-ChildItem -LiteralPath $core -Recurse -Force) {
        [void](Resolve-HarnessPath $root $file.FullName)
        if ($file.Name -match $pattern -or (-not $file.PSIsContainer -and [IO.File]::ReadAllText($file.FullName) -match $pattern)) { throw 'Vendor-specific artifact found in portable core' }
    }
    foreach ($path in @('AGENTS.md', '.agents/AGENTS.md', '.agents/policies/project.md', '.agents/orchestration/ROUTING.md')) {
        $raw = [IO.File]::ReadAllText((Resolve-HarnessPath $root $path))
        foreach ($match in [regex]::Matches($raw, '`((?:\.agents/|docs/)[^`]+\.(?:md|ya?ml|json|ps1))`')) {
            [void](Resolve-HarnessPath $root $match.Groups[1].Value)
        }
    }
    [void](Assert-HarnessSpec $root (Resolve-HarnessPath $root '.agents/templates/entity.spec.yaml'))
    foreach ($entry in @('generate-snapshots.ps1', 'validate-budget.ps1', 'validate-spec.ps1', 'validate-tasks.ps1')) {
        $arguments = @{ RepoRoot = $root }
        if ($entry -eq 'generate-snapshots.ps1') { $arguments.Check = $true }
        & "$PSScriptRoot/$entry" @arguments
        if ($LASTEXITCODE -ne 0) { throw "Harness entry point failed: $entry" }
    }
    Write-Output '[OK] Harness structure, snapshots, budgets and prospective contracts'
    exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
