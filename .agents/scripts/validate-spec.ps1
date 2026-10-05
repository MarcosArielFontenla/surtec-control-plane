#Requires -Version 7.0
param(
    [string]$RepoRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$SpecPath = '', [switch]$Run, [switch]$ConfirmExecution,
    [ValidateRange(1, 900)][int]$TimeoutSeconds = 120
)
. "$PSScriptRoot/common.ps1"
try {
    $root = Initialize-Harness $RepoRoot
    if ($Run -and (-not $SpecPath -or -not $ConfirmExecution)) { throw '-Run requires one explicit -SpecPath and -ConfirmExecution after human authorization' }
    if ($ConfirmExecution -and -not $Run) { throw '-ConfirmExecution requires -Run' }
    if ($SpecPath) {
        $path = Resolve-HarnessPath $root $SpecPath
        $relative = [IO.Path]::GetRelativePath($root, $path).Replace('\', '/')
        if ($relative -notmatch '^\.agents/specs/[a-zA-Z0-9._/-]+\.spec\.yaml$') { throw 'Spec path must be in the active spec namespace' }
        $files = @($path)
    } else {
        $directory = Resolve-HarnessPath $root '.agents/specs'
        $files = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter '*.spec.yaml' | ForEach-Object { Resolve-HarnessPath $root $_.FullName })
    }
    # Preflight every document and invocation before starting any check.
    $invocations = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $spec = Assert-HarnessSpec $root $file
        if ($Run) {
            if ($spec.designContract.status -ne 'approved') { throw 'Cannot execute an unapproved spec' }
            $runnable = @($spec.designContract.acceptanceChecks | Where-Object { $_.command.Trim() -ine 'placeholder' })
            if ($runnable.Count -eq 0) { throw 'Spec has no executable acceptance checks; a waiver is not a passing gate' }
            foreach ($check in $runnable) { $invocations.Add(@{ Id = $check.id; Invocation = (Get-SafeCheckInvocation $root $check.command); Expected = $check.expectedExitCode }) }
            if ($null -ne $spec.designContract.checksWaiver) { Write-Output '[WAIVER] Human-only criteria remain separately reported; not an executable pass' }
        }
    }
    foreach ($check in $invocations) {
        $code = Invoke-HarnessCheck $root $check.Invocation $TimeoutSeconds
        if ($code -ne $check.Expected) { throw "Acceptance check $($check.Id) exit $code; expected $($check.Expected)" }
        Write-Output "[OK] acceptance $($check.Id): exit $code"
    }
    Write-Output "[OK] specs: $($files.Count) structurally checked; $($invocations.Count) checks executed"
    exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
