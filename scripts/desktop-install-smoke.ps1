param([string]$BaselineInstaller = '')

$ErrorActionPreference = 'Stop'
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskBase = Join-Path $taskRepository '.data\installer-smoke'
$taskRoot = Join-Path $taskBase ([Guid]::NewGuid().ToString('N'))
$taskInstall = Join-Path $taskRoot 'app'
if (-not [IO.Path]::GetFullPath($taskRoot).StartsWith($taskBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer test path escaped its workspace.'
}
if (Get-Process -Name Rivloom -ErrorAction SilentlyContinue) {
    throw 'Close Rivloom before installer testing; NSIS may otherwise stop it by name.'
}

# These two public installation-metadata keys are the only registry keys the installer writes.
# /NS suppresses shortcuts; /UPDATE avoids deleting app data, jump lists and Run entries.
$taskKeys = @('Software\rivloom\Rivloom', 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom')
function Read-InstallMetadata([string]$Key) {
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
    if ($null -eq $registryKey) { return @{ Exists = $false; Values = @() } }
    try {
        if ($registryKey.SubKeyCount -ne 0) { throw "Unexpected installation subkeys: $Key" }
        $values = @($registryKey.GetValueNames() | Sort-Object | ForEach-Object {
            @{ Name = $_; Kind = $registryKey.GetValueKind($_).ToString(); Value = $registryKey.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        })
        return @{ Exists = $true; Values = $values }
    } finally { $registryKey.Dispose() }
}
$taskBefore = @{}
foreach ($taskKey in $taskKeys) { $taskBefore[$taskKey] = Read-InstallMetadata $taskKey }
$taskEnvNames = @('RIVLOOM_INSTALLER_TEST_GUARDED', 'RIVLOOM_INSTALLER_TEST_ROOT', 'RIVLOOM_INSTALLER_BASELINE')
$taskOldEnv = @{}
foreach ($taskName in $taskEnvNames) { $taskOldEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
$taskExit = 1
try {
    New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
    $env:RIVLOOM_INSTALLER_TEST_GUARDED = '1'
    $env:RIVLOOM_INSTALLER_TEST_ROOT = $taskRoot
    $env:RIVLOOM_INSTALLER_BASELINE = $BaselineInstaller
    Push-Location $taskRepository
    try {
        & node (Join-Path $PSScriptRoot 'desktop-install-smoke.ts')
        $taskExit = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    foreach ($taskName in $taskEnvNames) { [Environment]::SetEnvironmentVariable($taskName, $taskOldEnv[$taskName], 'Process') }
    foreach ($taskKey in $taskKeys) {
        $current = Read-InstallMetadata $taskKey
        $original = $taskBefore[$taskKey]
        # Refuse to overwrite a different installation created while this test was running.
        if ($current.Exists) {
            $pathName = if ($taskKey -like '*\Uninstall\*') { 'InstallLocation' } else { '' }
            $currentPath = @($current.Values | Where-Object { $_.Name -eq $pathName })
            $originalPath = @($original.Values | Where-Object { $_.Name -eq $pathName })
            $pathValue = if ($currentPath.Count) { ([string]$currentPath[0].Value).Trim('"') } else { '' }
            $beforeValue = if ($originalPath.Count) { ([string]$originalPath[0].Value).Trim('"') } else { '' }
            if ($pathValue -ne $taskInstall -and $pathValue -ne $beforeValue) {
                throw "Installation metadata changed outside this test; refusing to overwrite $taskKey"
            }
        }
        if (-not $original.Exists) {
            if ($current.Exists) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($taskKey, $false) }
        } else {
            $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($taskKey)
            try {
                foreach ($name in $registryKey.GetValueNames()) { $registryKey.DeleteValue($name, $false) }
                foreach ($value in $original.Values) {
                    $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $value.Kind)
                    $registryKey.SetValue($value.Name, $value.Value, $kind)
                }
            } finally { $registryKey.Dispose() }
        }
        $restored = Read-InstallMetadata $taskKey
        if ($restored.Exists -ne $original.Exists -or $restored.Values.Count -ne $original.Values.Count) {
            throw "Could not restore installation metadata: $taskKey"
        }
        foreach ($value in $original.Values) {
            $actual = @($restored.Values | Where-Object { $_.Name -eq $value.Name })
            if ($actual.Count -ne 1 -or $actual[0].Kind -ne $value.Kind -or
                (ConvertTo-Json -Compress -InputObject $actual[0].Value) -ne (ConvertTo-Json -Compress -InputObject $value.Value)) {
                throw "Restored installation metadata differs: $taskKey"
            }
        }
    }
    Write-Output 'PASS original installation metadata restored; user installation and data were not targeted'
    $taskReportPath = Join-Path $taskRepository '.data\verification\desktop-install.json'
    if (Test-Path -LiteralPath $taskReportPath) {
        $taskReport = Get-Content -Raw -Encoding UTF8 -LiteralPath $taskReportPath | ConvertFrom-Json
        if ($taskReport.root -eq $taskRoot) {
            $taskReport | Add-Member -NotePropertyName installationMetadataRestored -NotePropertyValue $true -Force
            [IO.File]::WriteAllText($taskReportPath, ($taskReport | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
        }
    }
}
if ($taskExit -ne 0) { throw "Installer checks failed (exit $taskExit); isolated data retained at $taskRoot" }
