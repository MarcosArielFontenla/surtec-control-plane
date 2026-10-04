#Requires -Version 7.0
param(
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [switch]$Check, [switch]$Scaffold, [string]$SkillName = '', [string]$OutputPath = ''
)
. "$PSScriptRoot/common.ps1"
try {
    $root = Initialize-Harness $RepoRoot
    if ($Check.IsPresent -eq $Scaffold.IsPresent) { throw 'Select exactly one of -Check or -Scaffold' }
    $skills = @(Get-HarnessSkills $root)
    if ($Scaffold -and [string]::IsNullOrWhiteSpace($SkillName)) { throw '-Scaffold requires one explicit -SkillName' }
    if ($Check -and ($SkillName -or $OutputPath)) { throw '-Check validates all declared snapshots without overrides' }
    $selected = @($skills | Where-Object { -not $SkillName -or $_.Name -ceq $SkillName })
    if ($selected.Count -eq 0) { throw 'Unknown skill name' }
    foreach ($skill in $selected) {
        $version = $skill.Metadata.version
        if ($skill.Metadata.snapshotVersion -cne $version) { throw 'Skill snapshotVersion does not match version' }
        $hash = (Get-FileHash -LiteralPath $skill.Path -Algorithm SHA256).Hash.ToLowerInvariant()
        $relative = if ($OutputPath) { $OutputPath } else { $skill.Metadata.snapshotPath }
        if ($relative -notmatch '^\.agents/cold-start/[a-zA-Z0-9._/-]+\.snapshot\.md$') { throw 'Scaffold path must be inside the cold-start namespace' }
        $path = Resolve-HarnessPath $root $relative -AllowMissing:$Scaffold
        if ($Check) {
            $fm = Read-HarnessFrontmatter $path
            Assert-HarnessDate (Get-HarnessValue $fm 'authoredAt')
            if ((Get-HarnessValue $fm 'sourceSkill') -cne $skill.Name -or (Get-HarnessValue $fm 'sourcePath') -cne ".agents/skills/$($skill.Name)/SKILL.md") { throw 'Snapshot source identity mismatch' }
            if ((Get-HarnessValue $fm 'sourceVersion') -cne $version -or (Get-HarnessValue $fm 'sourceHash') -cne $hash) { throw 'Snapshot version/hash is stale' }
            $raw = [IO.File]::ReadAllText($path)
            if ([IO.File]::ReadAllLines($path).Count -gt 25 -or $raw -match '\[TODO:|<!--\s*AGENT:') { throw 'Snapshot is oversized or has unfinished scaffold content' }
            Write-Output "[OK] snapshot $($skill.Name)"
        } else {
            if (Test-Path -LiteralPath $path) { throw 'Scaffold refuses to overwrite an existing artifact; use a new draft path' }
            $source = ".agents/skills/$($skill.Name)/SKILL.md"
            $body = @('---', "sourceSkill: $($skill.Name)", "sourcePath: $source", "sourceVersion: `"$version`"", "sourceHash: `"$hash`"", "authoredAt: `"$([datetime]::UtcNow.ToString('yyyy-MM-dd'))`"", '---', '', "# $($skill.Name) — Supplemental Snapshot", '', 'Read the complete source skill; this summary grants no authority.', '', '## Must', '', '[TODO: compress the reviewed operational rules]', '', '## Never', '', '[TODO: compress the reviewed prohibitions]', '', 'Key check: [TODO: reference the actual verification command]') -join "`n"
            [IO.Directory]::CreateDirectory((Split-Path $path)) | Out-Null
            $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($body + "`n"); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            Write-Output '[SCAFFOLD] Draft created; review/fill before replacing the canonical snapshot'
        }
    }
    exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
