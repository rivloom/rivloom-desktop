#requires -Version 7.0

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# This dependency preparation is only for disposable GitHub-hosted Windows jobs.
# It must not install a shared runtime on a developer or self-hosted machine.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $IsWindows) {
    throw 'WebView2 preparation requires a GitHub-hosted Windows Actions runner.'
}

# Microsoft detection and deployment guidance:
# https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
# https://github.com/MicrosoftEdge/WebView2Samples/blob/main/SampleApps/WV2DeploymentWiXBurnBundleSample/Bundle.wxs
$runtimeKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$bootstrapperSource = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reportDirectory = Join-Path $repository 'test-results\candidate'
$reportPath = Join-Path $reportDirectory 'webview2.json'

function Get-WebView2Version {
    $highest = $null
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $baseKey = $null
            $key = $null
            try {
                $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
                $key = $baseKey.OpenSubKey($runtimeKey, $false)
                if ($null -eq $key) { continue }
                $value = $key.GetValue('pv', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($value -isnot [string] -or $value -notmatch '^\d+\.\d+\.\d+\.\d+$') { continue }
                $version = $null
                if ([Version]::TryParse($value, [ref]$version) -and $version -gt [Version]'0.0.0.0' -and
                    ($null -eq $highest -or $version -gt $highest)) {
                    $highest = $version
                }
            } finally {
                if ($null -ne $key) { $key.Dispose() }
                if ($null -ne $baseKey) { $baseKey.Dispose() }
            }
        }
    }
    if ($null -ne $highest) { return $highest.ToString() }
    return $null
}

New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
# A report from an earlier invocation is not proof for this candidate preparation.
$reportStream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$report = [ordered]@{
    schema = 1
    status = 'failed'
    scope = 'github-hosted-windows-only'
    outcome = $null
    detectedVersion = $null
    installationAttempted = $false
    sourceUrl = $null
    publisher = $null
    bootstrapperSha256 = $null
    installerExitCode = $null
    timedOut = $false
    failureStage = $null
    failureType = $null
    failureHresult = $null
}
$stage = 'detect-runtime'
$failure = $false
try {
    $report.detectedVersion = Get-WebView2Version
    if ($null -ne $report.detectedVersion) {
        $report.outcome = 'present'
    } else {
        $stage = 'download-bootstrapper'
        $toolsBase = Join-Path $repository 'test-results\ci-tools'
        $toolsDirectory = Join-Path $toolsBase ('webview2-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $toolsDirectory | Out-Null
        $bootstrapper = Join-Path $toolsDirectory 'MicrosoftEdgeWebview2Setup.exe'
        $report.sourceUrl = $bootstrapperSource
        Invoke-WebRequest -Uri $bootstrapperSource -OutFile $bootstrapper -TimeoutSec 180 -MaximumRedirection 5

        $stage = 'verify-bootstrapper-signature'
        $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
            $null -eq $signature.SignerCertificate) {
            throw 'The WebView2 bootstrapper does not have a valid Authenticode signature.'
        }
        $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($publisher -cne 'Microsoft Corporation' -or
            $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
            throw 'The WebView2 bootstrapper is not signed by Microsoft Corporation.'
        }
        $report.publisher = $publisher
        $report.bootstrapperSha256 = (Get-FileHash -LiteralPath $bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()

        $stage = 'install-runtime'
        $report.installationAttempted = $true
        $installer = Start-Process -FilePath $bootstrapper -ArgumentList @('/silent', '/install') -WindowStyle Hidden -PassThru
        try {
            if (-not $installer.WaitForExit(600000)) {
                $report.timedOut = $true
                # Stop only the exact installer process tree created above.
                if (-not $installer.HasExited) { $installer.Kill($true) }
                $null = $installer.WaitForExit(5000)
                throw 'The WebView2 bootstrapper exceeded its installation deadline.'
            }
            $report.installerExitCode = $installer.ExitCode
            if ($installer.ExitCode -ne 0) { throw 'The WebView2 bootstrapper returned a nonzero exit code.' }
        } finally {
            $installer.Dispose()
        }

        $stage = 'verify-installed-runtime'
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $report.detectedVersion = Get-WebView2Version
            if ($null -ne $report.detectedVersion) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -eq $report.detectedVersion) { throw 'WebView2 runtime detection did not succeed after installation.' }
        $report.outcome = 'installed'
    }
    $report.status = 'passed'
} catch {
    $failure = $true
    $report.failureStage = $stage
    $report.failureType = $_.Exception.GetType().FullName
    $report.failureHresult = $_.Exception.HResult
} finally {
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 4) + [Environment]::NewLine)
        $reportStream.Write($bytes, 0, $bytes.Length)
    } finally {
        $reportStream.Dispose()
    }
}

if ($failure) {
    [Console]::Error.WriteLine('WebView2 preparation failed at ' + $report.failureStage + '; see the restricted candidate report.')
    exit 1
}
Write-Output ('WebView2 runtime ' + $report.outcome + '; version=' + $report.detectedVersion)
