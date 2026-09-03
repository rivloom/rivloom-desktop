$ErrorActionPreference = 'Stop'
$raceRepo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$raceDistribution = Join-Path $raceRepo '.data\distribution'
New-Item -ItemType Directory -Path $raceDistribution -Force | Out-Null
$raceStage = Join-Path $raceDistribution ('master-race-package-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $raceStage | Out-Null
$raceFiles = [ordered]@{
    'package.json' = 'support\m34-master-helper\package.json'
    'README.md' = 'support\m34-master-helper\README.md'
    'start-master.cmd' = 'support\m34-master-helper\start-master.cmd'
    'scripts/m34-physical-master.ts' = 'scripts\m34-physical-master.ts'
    'scripts/m34-fixtures.ts' = 'scripts\m34-fixtures.ts'
    'scripts/m34-race.ts' = 'scripts\m34-race.ts'
    'server/http-ports.ts' = 'server\http-ports.ts'
    'shared/types.ts' = 'shared\types.ts'
}
foreach ($raceEntry in $raceFiles.GetEnumerator()) {
    $raceTarget = Join-Path $raceStage $raceEntry.Key
    New-Item -ItemType Directory -Path (Split-Path -Parent $raceTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $raceRepo $raceEntry.Value) -Destination $raceTarget
}
$raceZip = Join-Path $raceDistribution 'Rivloom_M3.4_Master_Helper_0.1.3_race-v2.zip'
if (Test-Path -LiteralPath $raceZip) { throw 'Package exists; preserve it and inspect before rebuilding.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($raceStage, $raceZip)
$raceArchive = [System.IO.Compression.ZipFile]::OpenRead($raceZip)
try {
    $raceEntries = @($raceArchive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
    $raceExpected = @($raceFiles.Keys | Sort-Object)
    if (@(Compare-Object $raceExpected $raceEntries).Count -ne 0) { throw 'Unexpected package contents' }
    if (@($raceEntries | Where-Object { $_ -match '(^|/)\.data/|auth-token|\.db$|identity\.json' }).Count) { throw 'Private test data must never enter the package' }
    [pscustomobject]@{ zip = $raceZip; bytes = (Get-Item -LiteralPath $raceZip).Length; staging = $raceStage; entries = $raceEntries } | ConvertTo-Json -Depth 3
} finally { $raceArchive.Dispose() }
