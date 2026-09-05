param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?!0{40}$)[0-9a-f]{40}$')]
    [string]$ExpectedCommit,
    [string]$CandidateDirectory = 'test-results\candidate',
    [switch]$AllowLocalIsolatedTest
)

# This switch is only for an explicitly authorized local isolated test. It is not
# permission to replace an installed Rivloom or to use its application data.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'Preview installation verification requires Windows x64.'
}
if (-not ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') -and -not $AllowLocalIsolatedTest) {
    throw 'Use a GitHub-hosted runner, or explicitly authorize a local isolated test with -AllowLocalIsolatedTest.'
}
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskBase = Join-Path $taskRepository 'test-results'
$taskRoot = Join-Path $taskBase ('preview-install-' + [Guid]::NewGuid().ToString('N'))
$taskInstall = Join-Path $taskRoot 'app'
$taskNode = (Get-Command node.exe -CommandType Application).Source
$taskScript = Join-Path $PSScriptRoot 'preview-install-smoke.ts'
$taskCandidate = if ([IO.Path]::IsPathRooted($CandidateDirectory)) { [IO.Path]::GetFullPath($CandidateDirectory) } else { [IO.Path]::GetFullPath((Join-Path $taskRepository $CandidateDirectory)) }

function Assert-RegularDirectory([string]$Path) {
    $taskItem = Get-Item -LiteralPath $Path -Force
    if (-not $taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Installation verification requires regular directories without links or junctions.'
    }
}
function Assert-NoRivloom {
    if (Get-Process -Name Rivloom -ErrorAction SilentlyContinue) {
        throw 'A Rivloom process is running. This test will not stop it; NSIS also checks the shared executable name.'
    }
}
Assert-RegularDirectory $taskRepository
Assert-RegularDirectory $taskBase
if (-not $taskRoot.StartsWith($taskBase + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $taskRoot)) {
    throw 'Preview test directory must be new and remain within test-results.'
}
if ($taskInstall.Contains('"') -or $taskInstall -match '[\r\n]') { throw 'Unexpected installer path characters.' }
Assert-NoRivloom

# /UPDATE skips bootstrap installation. Require an existing WebView2 runtime so
# this smoke never installs or updates a shared system prerequisite.
$taskWebViewGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$taskWebViewPresent = $false
foreach ($taskHive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($taskView in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($taskHive, $taskView)
        try {
            $taskKey = $taskRegistry.OpenSubKey("Software\Microsoft\EdgeUpdate\Clients\$taskWebViewGuid")
            if ($null -ne $taskKey) {
                try {
                    $taskVersion = [string]$taskKey.GetValue('pv', '')
                    if ($taskVersion -match '^\d+\.\d+\.\d+\.\d+$' -and $taskVersion -ne '0.0.0.0') { $taskWebViewPresent = $true }
                } finally { $taskKey.Dispose() }
            }
        } finally { $taskRegistry.Dispose() }
    }
}
if (-not $taskWebViewPresent) { throw 'An existing WebView2 runtime is required; this smoke will not install it.' }

function Invoke-SmokeNode([string]$Operation) {
    $taskArguments = @($taskScript, $Operation, '--expected-commit', $ExpectedCommit)
    if ($Operation -ne 'uninstalled') { $taskArguments += @('--candidate-directory', $taskCandidate) }
    if ($Operation -ne 'verify') { $taskArguments += @('--root', $taskRoot) }
    $taskOutput = & $taskNode @taskArguments
    if ($LASTEXITCODE -ne 0) { throw "Preview smoke $Operation failed (exit $LASTEXITCODE)." }
    return ($taskOutput -join "`n" | ConvertFrom-Json)
}

# No installation or metadata changes occur before this exact-SHA, profile, PE
# product resource, sidecar and installer-byte verification succeeds.
Push-Location $taskRepository
try { $taskPlan = Invoke-SmokeNode 'verify' } finally { Pop-Location }
$taskReportArtifact = Join-Path $taskCandidate 'preview-install.json'
if (Test-Path -LiteralPath $taskReportArtifact) { throw 'This candidate already has an installation report; use a fresh candidate directory.' }

$taskPreviewProductKey = 'Software\rivloom\Rivloom UI Preview'
$taskPreviewUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom UI Preview'
$taskFormalKeys = @('Software\rivloom\Rivloom', 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom')
$taskViews = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
function Read-Metadata([string]$Key, [Microsoft.Win32.RegistryView]$View) {
    $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $View)
    try {
        $taskKeyHandle = $taskRegistry.OpenSubKey($Key)
        if ($null -eq $taskKeyHandle) { return [ordered]@{ Exists = $false; Values = @() } }
        try {
            if ($taskKeyHandle.SubKeyCount -ne 0) { throw "Unexpected installation metadata subkeys: $Key" }
            $taskValues = @($taskKeyHandle.GetValueNames() | Sort-Object | ForEach-Object {
                [ordered]@{ Name = $_; Kind = $taskKeyHandle.GetValueKind($_).ToString(); Value = $taskKeyHandle.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
            })
            return [ordered]@{ Exists = $true; Values = $taskValues }
        } finally { $taskKeyHandle.Dispose() }
    } finally { $taskRegistry.Dispose() }
}
function Same-Metadata($Left, $Right) {
    return (ConvertTo-Json -Depth 20 -Compress -InputObject $Left) -ceq (ConvertTo-Json -Depth 20 -Compress -InputObject $Right)
}
function Read-Value($Metadata, [string]$Name) {
    return ,@($Metadata.Values | Where-Object { $_.Name -ceq $Name })
}
$taskBefore = @{}
$taskFormalBefore = @{}
$taskVendorBefore = @{}
foreach ($taskView in $taskViews) {
    foreach ($taskKey in @($taskPreviewProductKey, $taskPreviewUninstallKey)) { $taskBefore["$taskView|$taskKey"] = Read-Metadata $taskKey $taskView }
    foreach ($taskKey in $taskFormalKeys) { $taskFormalBefore["$taskView|$taskKey"] = Read-Metadata $taskKey $taskView }
    $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $taskView)
    try {
        $taskVendor = $taskRegistry.OpenSubKey('Software\rivloom')
        $taskVendorBefore[[string]$taskView] = $null -ne $taskVendor
        if ($null -ne $taskVendor) { $taskVendor.Dispose() }
    } finally { $taskRegistry.Dispose() }
}
# NSIS consumes this old value even with /UPDATE and an explicit /D: a changed
# name is deleted relative to the new target. Reject paths before NSIS can use it.
function Assert-SafePreviousBinary($Metadata) {
    $taskOldBinary = Read-Value $Metadata 'MainBinaryName'
    if ($taskOldBinary.Count -gt 0 -and ($taskOldBinary.Count -ne 1 -or $taskOldBinary[0].Kind -ne 'String' -or $taskOldBinary[0].Value -cne 'Rivloom.exe')) {
        throw 'Existing Preview MainBinaryName is not the expected executable; its metadata will not be modified.'
    }
}
foreach ($taskView in $taskViews) { Assert-SafePreviousBinary $taskBefore["$taskView|$taskPreviewUninstallKey"] }
function Assert-FormalUnchanged {
    foreach ($taskView in $taskViews) {
        foreach ($taskKey in $taskFormalKeys) {
            if (-not (Same-Metadata (Read-Metadata $taskKey $taskView) $taskFormalBefore["$taskView|$taskKey"])) {
                throw 'Formal Rivloom installation metadata changed; this test will not write or restore formal keys.'
            }
        }
    }
}

# Check that the unique target does not sit inside an existing installation.
foreach ($taskOriginal in @($taskBefore.Values) + @($taskFormalBefore.Values)) {
    foreach ($taskValue in @($taskOriginal.Values | Where-Object { $_.Name -in @('', 'InstallLocation') })) {
        $taskExisting = ([string]$taskValue.Value).Trim('"').TrimEnd('\')
        if ($taskExisting -and [IO.Path]::IsPathRooted($taskExisting) -and $taskInstall.StartsWith($taskExisting + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The isolated target must not be inside an existing application installation.'
        }
    }
}

function Invoke-IsolatedNSIS([string]$File, [string[]]$Arguments) {
    Assert-NoRivloom
    $taskFileInfo = Get-Item -LiteralPath $File -Force
    if ($taskFileInfo.PSIsContainer -or ($taskFileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'NSIS must be a regular executable file.' }
    if ($File -ceq [string]$taskPlan.installer) {
        if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskPlan.record.artifact.sha256) { throw 'Candidate changed after verification.' }
    } elseif ($File -ceq (Join-Path $taskInstall 'uninstall.exe')) {
        Assert-RegularDirectory $taskInstall
    } else { throw 'Only the verified candidate or its exact isolated uninstaller may run.' }
    $taskProcess = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $taskProcess.WaitForExit(120000)) {
        if (-not $taskProcess.HasExited) {
            & taskkill.exe /PID $taskProcess.Id /T /F | Out-Null
            $taskProcess.WaitForExit(10000) | Out-Null
        }
        throw 'The isolated NSIS process timed out.'
    }
    if ($taskProcess.ExitCode -ne 0) { throw "The isolated NSIS process failed (exit $($taskProcess.ExitCode))." }
}

function Assert-InstalledMetadata {
    $taskExpected = @{
        DisplayName = 'Rivloom UI Preview'; DisplayVersion = [string]$taskPlan.version; Publisher = 'rivloom';
        MainBinaryName = 'Rivloom.exe'; InstallLocation = ('"' + $taskInstall + '"');
        UninstallString = ('"' + (Join-Path $taskInstall 'uninstall.exe') + '"')
    }
    foreach ($taskView in $taskViews) {
        $taskProduct = Read-Metadata $taskPreviewProductKey $taskView
        $taskProductPath = Read-Value $taskProduct ''
        if (-not $taskProduct.Exists -or $taskProductPath.Count -ne 1 -or $taskProductPath[0].Value -cne $taskInstall) { throw 'Preview product metadata did not point to the isolated installation.' }
        $taskUninstall = Read-Metadata $taskPreviewUninstallKey $taskView
        if (-not $taskUninstall.Exists) { throw 'Preview uninstall metadata was not created.' }
        foreach ($taskName in $taskExpected.Keys) {
            $taskActual = Read-Value $taskUninstall $taskName
            if ($taskActual.Count -ne 1 -or $taskActual[0].Kind -ne 'String' -or $taskActual[0].Value -cne $taskExpected[$taskName]) { throw "Preview uninstall metadata mismatch: $taskName" }
        }
    }
    Assert-FormalUnchanged
}

# Metadata snapshots stay in memory; never upload users' existing registry values.
$taskInstalled = @{}
$taskInstallerStarted = $false
$taskUninstallAttempted = $false
$taskUninstalled = $false
$taskFailure = $null
$taskErrors = [Collections.Generic.List[string]]::new()
$taskEnvNames = @('RIVLOOM_PREVIEW_INSTALL_GUARDED', 'RIVLOOM_PREVIEW_INSTALL_ROOT')
$taskOldEnvironment = @{}
foreach ($taskName in $taskEnvNames) { $taskOldEnvironment[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }

function Safe-PartialMetadata([string]$Key, $Current, $Original) {
    if (-not $Current.Exists) { return $taskUninstallAttempted -and $Key -eq $taskPreviewUninstallKey }
    $taskPathName = if ($Key -eq $taskPreviewProductKey) { '' } else { 'InstallLocation' }
    $taskPathValue = Read-Value $Current $taskPathName
    $taskPathExpected = if ($Key -eq $taskPreviewProductKey) { $taskInstall } else { '"' + $taskInstall + '"' }
    if ($taskPathValue.Count -ne 1 -or $taskPathValue[0].Kind -ne 'String' -or $taskPathValue[0].Value -cne $taskPathExpected) { return $false }
    $taskExpectedStrings = if ($Key -eq $taskPreviewProductKey) { @{ '' = $taskInstall } } else {
        @{
            MainBinaryName = 'Rivloom.exe'; DisplayName = 'Rivloom UI Preview';
            DisplayIcon = ('"' + (Join-Path $taskInstall 'Rivloom.exe') + '"');
            DisplayVersion = [string]$taskPlan.version; Publisher = 'rivloom';
            InstallLocation = ('"' + $taskInstall + '"');
            UninstallString = ('"' + (Join-Path $taskInstall 'uninstall.exe') + '"')
        }
    }
    # Partial NSIS installation only overwrites its known values; it does not
    # delete unrelated original values. A removal is an unrecognized change.
    foreach ($taskOld in $Original.Values) {
        if ((Read-Value $Current $taskOld.Name).Count -ne 1) { return $false }
    }
    foreach ($taskValue in $Current.Values) {
        $taskOld = Read-Value $Original $taskValue.Name
        if ($taskOld.Count -eq 1 -and (Same-Metadata $taskValue $taskOld[0])) { continue }
        if ($taskExpectedStrings.ContainsKey($taskValue.Name)) {
            if ($taskValue.Kind -ne 'String' -or $taskValue.Value -cne $taskExpectedStrings[$taskValue.Name]) { return $false }
        } elseif ($Key -eq $taskPreviewUninstallKey -and $taskValue.Name -cin @('NoModify', 'NoRepair')) {
            if ($taskValue.Kind -ne 'DWord' -or $taskValue.Value -ne 1) { return $false }
        } else {
            # EstimatedSize is accepted only via the complete captured install
            # state above, not as an arbitrary altered value in partial state.
            return $false
        }
    }
    return $true
}

try {
    New-Item -ItemType Directory -Path $taskRoot | Out-Null
    $env:RIVLOOM_PREVIEW_INSTALL_GUARDED = '1'
    $env:RIVLOOM_PREVIEW_INSTALL_ROOT = $taskRoot
    Push-Location $taskRepository
    try {
        $taskInstallerStarted = $true
        Invoke-IsolatedNSIS ([string]$taskPlan.installer) @('/S', '/NS', '/UPDATE', ('/D=' + $taskInstall))
        Assert-RegularDirectory $taskInstall
        Assert-InstalledMetadata
        foreach ($taskView in $taskViews) {
            foreach ($taskKey in @($taskPreviewProductKey, $taskPreviewUninstallKey)) { $taskInstalled["$taskView|$taskKey"] = Read-Metadata $taskKey $taskView }
        }
        Invoke-SmokeNode 'installed' | Out-Null
        $taskUninstallAttempted = $true
        Invoke-IsolatedNSIS (Join-Path $taskInstall 'uninstall.exe') @('/S', '/UPDATE', ('_?=' + $taskInstall))
        $taskUninstalled = $true
        Invoke-SmokeNode 'uninstalled' | Out-Null
    } finally { Pop-Location }
} catch { $taskFailure = $_.Exception.Message }
finally {
    # On ordinary verification failure, clean only executables below this new
    # installation. Never use image-name termination or a registered uninstaller.
    if ($taskInstallerStarted -and -not $taskUninstalled -and (Test-Path -LiteralPath (Join-Path $taskInstall 'uninstall.exe'))) {
        try {
            Assert-NoRivloom
            $taskUninstallAttempted = $true
            Invoke-IsolatedNSIS (Join-Path $taskInstall 'uninstall.exe') @('/S', '/UPDATE', ('_?=' + $taskInstall))
            $taskUninstalled = $true
        } catch { $taskErrors.Add('Isolated uninstall cleanup failed: ' + $_.Exception.Message) }
    }
    foreach ($taskName in $taskEnvNames) { [Environment]::SetEnvironmentVariable($taskName, $taskOldEnvironment[$taskName], 'Process') }
    foreach ($taskView in $taskViews) {
        foreach ($taskKey in @($taskPreviewProductKey, $taskPreviewUninstallKey)) {
            try {
                $taskCurrent = Read-Metadata $taskKey $taskView
                $taskOriginal = $taskBefore["$taskView|$taskKey"]
                if (Same-Metadata $taskCurrent $taskOriginal) { continue }
                $taskKnown = $taskInstalled.ContainsKey("$taskView|$taskKey") -and (Same-Metadata $taskCurrent $taskInstalled["$taskView|$taskKey"])
                if (-not $taskInstallerStarted -or (-not $taskKnown -and -not (Safe-PartialMetadata $taskKey $taskCurrent $taskOriginal))) {
                    throw 'Metadata changed outside a recognized test state; refusing to overwrite it.'
                }
                $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $taskView)
                try {
                    if (-not $taskOriginal.Exists) {
                        if ($taskCurrent.Exists) { $taskRegistry.DeleteSubKey($taskKey, $false) }
                    } else {
                        $taskKeyHandle = $taskRegistry.CreateSubKey($taskKey)
                        try {
                            foreach ($taskName in $taskKeyHandle.GetValueNames()) { $taskKeyHandle.DeleteValue($taskName, $false) }
                            foreach ($taskValue in $taskOriginal.Values) {
                                $taskKind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $taskValue.Kind)
                                $taskKeyHandle.SetValue($taskValue.Name, $taskValue.Value, $taskKind)
                            }
                        } finally { $taskKeyHandle.Dispose() }
                    }
                } finally { $taskRegistry.Dispose() }
                if (-not (Same-Metadata (Read-Metadata $taskKey $taskView) $taskOriginal)) { throw 'Metadata did not restore field for field.' }
            } catch { $taskErrors.Add("$taskView/$taskKey restoration failed: " + $_.Exception.Message) }
        }
        # Remove only an empty vendor parent created by this isolated test.
        if (-not $taskVendorBefore[[string]$taskView]) {
            $taskRegistry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $taskView)
            try {
                $taskVendor = $taskRegistry.OpenSubKey('Software\rivloom')
                if ($null -ne $taskVendor) {
                    try { $taskEmpty = $taskVendor.SubKeyCount -eq 0 -and $taskVendor.ValueCount -eq 0 } finally { $taskVendor.Dispose() }
                    if ($taskEmpty) { $taskRegistry.DeleteSubKey('Software\rivloom', $false) }
                }
            } catch { $taskErrors.Add('Empty test-created vendor metadata cleanup failed.') }
            finally { $taskRegistry.Dispose() }
        }
    }
    $taskFormalUnchanged = $true
    try { Assert-FormalUnchanged } catch { $taskFormalUnchanged = $false; $taskErrors.Add($_.Exception.Message) }
    if (Test-Path -LiteralPath $taskRoot) {
        $taskReportPath = Join-Path $taskRoot 'verification.json'
        $taskReport = if (Test-Path -LiteralPath $taskReportPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $taskReportPath | ConvertFrom-Json } else { [pscustomobject]@{ schemaVersion = 1; status = 'failed'; commit = $ExpectedCommit; identifier = 'com.rivloom.conversationpreview' } }
        if ($taskReport.commit -cne $ExpectedCommit -or $taskReport.identifier -cne 'com.rivloom.conversationpreview') { throw 'Installation report belongs to another candidate.' }
        if ($taskReport.PSObject.Properties.Name -contains 'candidateSha256' -and $taskReport.candidateSha256 -cne $taskPlan.record.artifact.sha256) { throw 'Installation report belongs to different installer bytes.' }
        $taskPassed = $null -eq $taskFailure -and $taskErrors.Count -eq 0 -and $taskReport.status -eq 'awaiting-metadata-restore'
        $taskReport.status = if ($taskPassed) { 'passed' } else { 'failed' }
        $taskReport | Add-Member -NotePropertyName sourceCommit -NotePropertyValue $ExpectedCommit -Force
        $taskReport | Add-Member -NotePropertyName candidateSha256 -NotePropertyValue $taskPlan.record.artifact.sha256 -Force
        $taskReport | Add-Member -NotePropertyName installationMetadataRestored -NotePropertyValue ($taskErrors.Count -eq 0) -Force
        $taskReport | Add-Member -NotePropertyName formalMetadataUnchanged -NotePropertyValue $taskFormalUnchanged -Force
        $taskReport | Add-Member -NotePropertyName wrapperErrors -NotePropertyValue $taskErrors.ToArray() -Force
        if ($null -ne $taskFailure) { $taskReport | Add-Member -NotePropertyName wrapperFailure -NotePropertyValue $taskFailure -Force }
        $taskReportBytes = [Text.UTF8Encoding]::new($false).GetBytes(($taskReport | ConvertTo-Json -Depth 20) + "`n")
        [IO.File]::WriteAllBytes($taskReportPath, $taskReportBytes)
        # Publish only this invocation's bounded report after all metadata
        # restoration; never glob the isolated data or previous test reports.
        $taskReportFile = [IO.File]::Open($taskReportArtifact, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $taskReportFile.Write($taskReportBytes, 0, $taskReportBytes.Length) } finally { $taskReportFile.Dispose() }
        Write-Output "Preview installation report: $taskReportPath"
    }
}
if ($null -ne $taskFailure) { throw $taskFailure }
if ($taskErrors.Count -gt 0) { throw ($taskErrors -join ' | ') }
if (-not $taskPassed) { throw 'Preview installation did not complete all guarded checks.' }
Write-Output 'PASS isolated Preview install/start/restart/uninstall; original Preview metadata restored and formal metadata unchanged.'
