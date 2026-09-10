param([string]$Directory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Directory) { $Directory = Join-Path $taskRoot '.data/updater-signing' }
$taskDirectory = [System.IO.Path]::GetFullPath($Directory)
$taskPrivateRoot = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.data')) + [System.IO.Path]::DirectorySeparatorChar
if (-not $taskDirectory.StartsWith($taskPrivateRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Signing keys must stay in this project ignored .data directory.' }
$taskKey = Join-Path $taskDirectory 'rivloom.key'
$taskPublic = Join-Path $taskRoot 'src-tauri/updater.pub'
if ((Test-Path -LiteralPath $taskKey) -or (Test-Path -LiteralPath $taskPublic)) { throw 'An updater key already exists; this command never replaces trust keys.' }
New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
$taskSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskAcl = New-Object System.Security.AccessControl.DirectorySecurity
$taskAcl.SetAccessRuleProtection($true, $false)
$taskAcl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($taskSid)))
foreach ($taskPrincipal in @($taskSid, 'S-1-5-18')) {
  $taskRule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($taskPrincipal)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $taskAcl.AddAccessRule($taskRule)
}
Set-Acl -LiteralPath $taskDirectory -AclObject $taskAcl
# The native signer writes the private key to the protected file. Discard all
# output, including errors; never echo signer output or private material.
& node (Join-Path $taskRoot 'node_modules/@tauri-apps/cli/tauri.js') signer generate --ci --write-keys $taskKey *> $null
if ($LASTEXITCODE -ne 0) { throw 'Key generation failed. Inspect the protected directory without printing its contents.' }
$taskPubValue = [System.IO.File]::ReadAllText($taskKey + '.pub').Trim()
if ($taskPubValue.Length -lt 40 -or $taskPubValue.Length -gt 500) { throw 'Unexpected public key format.' }
[System.IO.File]::WriteAllText($taskPublic, $taskPubValue + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Output 'Updater trust key created. The private key remains only in the protected ignored signing directory; source contains its public key.'
