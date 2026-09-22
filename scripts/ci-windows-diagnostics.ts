import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { windowsPowerShellEnvironment, windowsPowerShellPrelude } from '../server/windows-engine-stop.mjs';
import { testEnvironment } from './ci-workspace.ts';

// Observation only: the real Windows tests remain the pass/fail gate. This probe
// uses fixed non-secret bytes, creates no identity and never prints input/output
// bytes, environment values or arbitrary child-process stderr.
const timeoutMs = 15_000;
const sample = Buffer.from('Rivloom non-secret Windows DPAPI diagnostic sample');
const stageNames = [
  'powershell-started',
  'before-add-type',
  'after-add-type',
  'before-read-input',
  'after-read-input',
  'before-protect',
  'after-protect',
  'before-unprotect',
  'after-unprotect',
] as const;
const stages = new Set<string>(stageNames);
const script = `
$ErrorActionPreference = 'Stop'
$stageTimer = [System.Diagnostics.Stopwatch]::StartNew()
function Write-DiagnosticStage([string]$name) {
  [Console]::Error.WriteLine('RIVLOOM_DPAPI_STAGE|' + $name + '|' + $stageTimer.ElapsedMilliseconds)
}
$phase = 'powershell-started'
Write-DiagnosticStage $phase
try {
  $phase = 'before-add-type'
  Write-DiagnosticStage $phase
  Add-Type -AssemblyName System.Security
  $phase = 'after-add-type'
  Write-DiagnosticStage $phase
  $phase = 'before-read-input'
  Write-DiagnosticStage $phase
  $value = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $phase = 'after-read-input'
  Write-DiagnosticStage $phase
  $phase = 'before-protect'
  Write-DiagnosticStage $phase
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($value, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $phase = 'after-protect'
  Write-DiagnosticStage $phase
  $phase = 'before-unprotect'
  Write-DiagnosticStage $phase
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $phase = 'after-unprotect'
  Write-DiagnosticStage $phase
  [Console]::Out.Write([Convert]::ToBase64String($plain))
} catch {
  $exception = $_.Exception
  for ($depth = 0; $null -ne $exception -and $depth -lt 4; $depth++) {
    [Console]::Error.WriteLine('RIVLOOM_DPAPI_ERROR|' + $phase + '|' + $exception.GetType().FullName + '|' + $exception.HResult)
    $exception = $exception.InnerException
  }
  exit 1
}
`;

function safeStderr(stderr: string) {
  const stageRecords: { stage: string; powerShellElapsedMs: number }[] = [];
  const exceptions: { stage: string; type: string; hresult: number }[] = [];
  let unclassifiedStderrPresent = false;
  for (const line of stderr.split(/\r?\n/).filter((line) => line.trim())) {
    const fields = line.split('|');
    if (
      fields.length === 3 &&
      fields[0] === 'RIVLOOM_DPAPI_STAGE' &&
      stages.has(fields[1]) &&
      /^\d{1,8}$/.test(fields[2])
    ) {
      if (stageRecords.length < stageNames.length)
        stageRecords.push({ stage: fields[1], powerShellElapsedMs: Number(fields[2]) });
    } else if (
      fields.length === 4 &&
      fields[0] === 'RIVLOOM_DPAPI_ERROR' &&
      stages.has(fields[1]) &&
      /^[A-Za-z][A-Za-z0-9_.]{0,159}$/.test(fields[2]) &&
      /^-?\d{1,10}$/.test(fields[3])
    ) {
      if (exceptions.length < 4)
        exceptions.push({ stage: fields[1], type: fields[2], hresult: Number(fields[3]) });
    } else unclassifiedStderrPresent = true;
  }
  return { stages: stageRecords, exceptions, unclassifiedStderrPresent };
}

const cimOnly = process.argv.includes('--cim-only');
console.log(`Windows ${cimOnly ? 'CIM module' : 'DPAPI'} diagnostic observation; actual test failures remain the CI gate.`);
if (process.platform !== 'win32') {
  console.log(JSON.stringify({ kind: 'diagnostic-observation', outcome: 'unsupported-platform' }));
} else {
  const fixedEnvironment = testEnvironment(resolve('.data/verification/ci-windows-diagnostics'));
  const environments = [
    ['inherited', { ...process.env }],
    ['fixed-ci-whitelist', fixedEnvironment],
  ] as const;
  if (!cimOnly) for (const [environment, env] of environments) {
    const startedAt = Date.now();
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        env,
        input: sample.toString('base64'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    const roundTripMatched = Buffer.from((result.stdout || '').trim(), 'base64').equals(sample);
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code || null;
    console.log(
      JSON.stringify({
        kind: 'diagnostic-observation',
        environment,
        psModulePathPresent: Object.keys(env).some((name) => name.toUpperCase() === 'PSMODULEPATH'),
        outcome:
          !result.error && result.status === 0 && roundTripMatched
            ? 'observed-success'
            : 'observed-failure',
        durationMs: Date.now() - startedAt,
        timeoutMs,
        status: result.status,
        signal: result.signal,
        errorCode,
        timedOut: errorCode === 'ETIMEDOUT',
        roundTripMatched,
        ...safeStderr(result.stderr || ''),
      }),
    );
  }
  if (cimOnly) {
  // Run after real lifecycle checks; never prewarm their cold-stop path.
  // Fresh PowerShell processes, same read-only CIM enumeration and isolated TEMP.
  // This timing observation never overrides the real shared owned-stop deadline.
  const temporary = resolve('.data/verification/ci-windows-diagnostics/cim-temp');
  mkdirSync(temporary, { recursive: true });
  // Match engineEnv's system whitelist; no model, account or provider settings.
  const withoutModules = Object.fromEntries(Object.entries(fixedEnvironment).filter(([name]) =>
    /^(path|home|shell|lang|lc_all|lc_ctype|term|systemroot|windir|comspec|pathext|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|systemdrive|https?_proxy|no_proxy)$/i.test(name)));
  Object.assign(withoutModules, { TEMP: temporary, TMP: temporary });
  const inheritedModules = Object.fromEntries(Object.entries(fixedEnvironment).filter(([name]) => name.toUpperCase() === 'PSMODULEPATH'));
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = '$ErrorActionPreference="Stop"; $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop); if($all.Count -eq 0){throw "Process inventory unavailable"}; [Console]::Out.Write([string]$all.Count + "|" + [string]($env:PSModulePath -ceq ($PSHOME + "\\Modules")))';
  for (const [environment, env] of [
    ['missing-module-path-first', withoutModules],
    ['fixed-system-modules', windowsPowerShellEnvironment(withoutModules)],
    ['inherited-module-path', { ...withoutModules, ...inheritedModules }],
    ['missing-module-path-repeat', withoutModules],
  ] as const) {
    const startedAt = Date.now();
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', (environment === 'fixed-system-modules' ? windowsPowerShellPrelude : '') + command], { env, encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4096 });
    const durationMs = Date.now() - startedAt;
    const observed = (result.stdout || '').trim().match(/^[1-9]\d{0,6}\|(True|False)$/);
    const inventoryAvailable = !result.error && result.status === 0 && !!observed;
    console.log(JSON.stringify({ kind: 'cim-module-diagnostic', environment, freshPowerShell: true, readOnly: true, durationMs, timeoutMs: 8000,
      initialSnapshotBudgetMs: 5800, totalStopBudgetMs: 5800,
      withinInitialSnapshotBudget: inventoryAvailable && durationMs < 5800, inventoryAvailable,
      actualSystemModulesOnly: observed ? observed[1] === 'True' : null,
      status: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', stderrPresent: !!result.stderr }));
  }
  }
}
