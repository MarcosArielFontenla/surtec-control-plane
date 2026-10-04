#Requires -Version 7.0
param(
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$TaskClasses = '', [string]$ExtraArtifacts = ''
)
. "$PSScriptRoot/common.ps1"
try {
    $root = Initialize-Harness $RepoRoot
    $manifest = Read-HarnessYaml (Resolve-HarnessPath $root '.agents/cold-start/budget-manifest.yaml')
    if ($manifest.version -ne 1 -or $manifest.budgetLines -ne 500 -or $manifest.loadMode -ne 'full-skills') { throw 'Unsupported context manifest contract' }
    if (($manifest.alwaysLoad -join ',') -cne 'AGENTS.md,.agents/policies/project.md,.agents/orchestration/ROUTING.md') { throw 'Manifest must count mandatory primer, policy and routing' }
    $names = @($manifest.taskClasses | ForEach-Object { $_.name })
    if (@($names | Select-Object -Unique).Count -ne $names.Count -or $names.Count -eq 0) { throw 'Duplicate or missing task classes' }
    $routing = [IO.File]::ReadAllText((Resolve-HarnessPath $root '.agents/orchestration/ROUTING.md'))
    $routes = @([regex]::Matches($routing, '(?m)^\| ([a-z]+(?:-[a-z]+)+) \|') | ForEach-Object { $_.Groups[1].Value })
    if ((($names | Sort-Object) -join ',') -cne (($routes | Sort-Object) -join ',')) { throw 'Routing and manifest class names differ' }
    foreach ($profile in $manifest.taskClasses) {
        $row = [regex]::Match($routing, '(?m)^\| ' + [regex]::Escape($profile.name) + ' \|.*$').Value
        $required = @([regex]::Matches($row, '`((?:\.agents/|docs/)[^`]+\.(?:md|ya?ml))`') | ForEach-Object { $_.Groups[1].Value })
        if ($row -match 'All three domain skills') { $required += @(Get-HarnessSkills $root | ForEach-Object { ".agents/skills/$($_.Name)/SKILL.md" }) }
        if ($row -match 'State and dashboard skills') { $required += @('.agents/skills/file-state-contracts/SKILL.md', '.agents/skills/local-dashboard-validation/SKILL.md') }
        foreach ($path in $required) { if (@($profile.artifacts) -cnotcontains $path) { throw 'Manifest omits a required routed artifact' } }
        if (@($profile.artifacts | Where-Object { $_ -match '\.snapshot\.md$' }).Count) { throw 'Snapshots cannot replace full skills in a declared route' }
    }
    $requested = @($(if ($TaskClasses) { $TaskClasses.Split(',') | ForEach-Object { $_.Trim() } }))
    foreach ($name in $requested) { if ($names -cnotcontains $name) { throw 'Unknown selected task class' } }
    $profiles = if ($requested.Count) { @(@{ name = 'selected-union'; artifacts = @($manifest.taskClasses | Where-Object { $requested -ccontains $_.name } | ForEach-Object { $_.artifacts }) }) } else { @($manifest.taskClasses) }
    foreach ($profile in $profiles) {
        $paths = @($manifest.alwaysLoad) + @($profile.artifacts)
        if ($ExtraArtifacts) { $paths += @($ExtraArtifacts.Split(',') | ForEach-Object { $_.Trim() }) }
        $unique = [Collections.Generic.HashSet[string]]::new($(if ($IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal }))
        $total = 0
        foreach ($path in $paths) {
            if ($path -notmatch '^(AGENTS\.md|\.agents/|docs/|lib/|runner/|scripts/|dashboard/|schemas/)') { throw 'Context artifact is outside the documented source namespaces' }
            $full = Resolve-HarnessPath $root $path
            if ($unique.Add($full)) { $total += [IO.File]::ReadAllLines($full).Count }
        }
        if ($total -gt $manifest.budgetLines) { throw "Context budget exceeded for $($profile.name): $total/500; decompose without skipping mandatory reads" }
        Write-Output "[OK] context $($profile.name): $total/500"
    }
    exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
