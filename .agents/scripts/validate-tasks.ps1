#Requires -Version 7.0
param([string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent), [string]$TasksPath = '')
. "$PSScriptRoot/common.ps1"
try {
    $root = Initialize-Harness $RepoRoot
    $files = @($(if ($TasksPath) { Resolve-HarnessPath $root $TasksPath } else { Get-ChildItem -LiteralPath (Resolve-HarnessPath $root '.agents/specs') -Recurse -File -Filter '*.tasks.md' | ForEach-Object { $_.FullName } }))
    foreach ($file in $files) {
        $file = Resolve-HarnessPath $root $file
        if ([IO.Path]::GetRelativePath($root, $file).Replace('\', '/') -notmatch '^\.agents/specs/.+\.tasks\.md$') { throw 'Tasks must be in the active specs namespace' }
        $fm = Read-HarnessFrontmatter $file
        foreach ($key in @('spec', 'feature', 'status', 'createdAt', 'reviewedBy', 'approvedAt')) { if (-not $fm.Contains($key)) { throw 'Missing tasks metadata' } }
        if ($fm.status -cnotin @('draft', 'approved', 'in_progress', 'done') -or [string]::IsNullOrWhiteSpace($fm.feature) -or $fm.feature -eq 'placeholder') { throw 'Invalid tasks identity/status' }
        Assert-HarnessDate $fm.createdAt
        if ($fm.spec -notmatch '^\.agents/specs/.+\.spec\.yaml$') { throw 'Tasks reference must name an active spec' }
        $spec = Assert-HarnessSpec $root (Resolve-HarnessPath $root $fm.spec)
        if ($fm.status -ne 'draft') {
            if ($spec.designContract.status -ne 'approved' -or [string]::IsNullOrWhiteSpace($fm.reviewedBy)) { throw 'Tasks lack reviewed spec/metadata' }
            Assert-HarnessDate $fm.approvedAt -Timestamp
        }
        $raw = [IO.File]::ReadAllText($file)
        $markers = [regex]::Matches($raw, '\[NEEDS CLARIFICATION', 'IgnoreCase').Count
        if ($markers -gt 5 -or ($fm.status -ne 'draft' -and $markers -gt 0)) { throw 'Unresolved tasks clarification markers' }
        $checks = @($spec.designContract.acceptanceChecks | ForEach-Object { $_.id })
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $mapped = @(); $parallelIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $targetOwners = @{}
        foreach ($line in [IO.File]::ReadAllLines($file)) {
            if ($line -match '^## Phase ') { $mapped = @() }
            if ($line -match '^<!-- maps to: ([a-zA-Z0-9,_-]+) -->$') {
                $mapped = @($Matches[1].Split(','))
                foreach ($id in $mapped) { if ($checks -cnotcontains $id) { throw 'Tasks map to an unknown acceptance check' } }
            }
            if ($line -match '^- \[([ x])\] (T\d{3}) (.+) -> (.+)$') {
                $complete = $Matches[1] -eq 'x'; $id = $Matches[2]; $body = $Matches[3]; $targets = $Matches[4]
                if ($mapped.Count -eq 0 -or $seen.Contains($id)) { throw 'Tasks require unique ids and a phase acceptance mapping' }
                $dependencies = [regex]::Match($body, '\(depends: ([T0-9, ]+)\)')
                if ($dependencies.Success) {
                    foreach ($dependency in $dependencies.Groups[1].Value.Split(',').Trim()) { if (-not $seen.Contains($dependency) -or $parallelIds.Contains($dependency)) { throw 'Task dependency is missing, cyclic, out of order or targets a parallel task' } }
                }
                [void]$seen.Add($id)
                $parallel = $body -match '\[P\]'
                if ($parallel -and $dependencies.Success) { throw 'Parallel tasks cannot have dependency edges' }
                if ($parallel) { [void]$parallelIds.Add($id) }
                foreach ($target in $targets.Split(',').Trim()) {
                    $full = Resolve-HarnessPath $root $target -AllowMissing
                    if ($targetOwners.ContainsKey($full) -and ($parallel -or $targetOwners[$full])) { throw 'Parallel tasks must be independent with disjoint targets' }
                    $targetOwners[$full] = $parallel
                }
                if ($fm.status -eq 'done' -and -not $complete) { throw 'Done tasks contain unfinished work' }
            } elseif ($line -match '^- \[[ x]\]') { throw 'Malformed task; use stable id, description and concrete target paths' }
        }
        if ($seen.Count -eq 0) { throw 'No concrete tasks found' }
        Write-Output '[OK] tasks structure/references; done status still requires fresh executable evidence and human review'
    }
    Write-Output "[OK] active tasks: $($files.Count)"
    exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
