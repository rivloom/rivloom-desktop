import { execFile } from 'node:child_process';
import { join } from 'node:path';

const validPID = (value) => Number.isSafeInteger(value) && value > 0;
const validCreated = (value) => typeof value === 'string' && /^[1-9]\d{15,18}$/.test(value);

const diagnosticPhases = ['before', 'root-check', 'kill', 'after', 'result', 'deadline', 'unexpected'];
const diagnosticReasons = ['timeout', 'output_limit', 'command_missing', 'command_denied', 'command_failed', 'invalid_inventory', 'invalid_result', 'root_exited', 'survivor'];
// Parse only this fixed, bounded schema. Never forward raw child output/errors:
// those may contain command lines, paths or credentials supplied to the engine.
export function parseWindowsEngineStopDiagnostic(line) {
  const prefix = 'RIVLOOM_ENGINE_STOP ';
  if (typeof line !== 'string' || line.length > 768 || !line.startsWith(prefix)) return;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    if (!value || !diagnosticPhases.includes(value.phase) || !['ok', 'failed', 'skipped'].includes(value.outcome) ||
        !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) return;
    const result = { phase: value.phase, outcome: value.outcome, durationMs: value.durationMs };
    if ('code' in value) { if (value.code !== null && (!Number.isSafeInteger(value.code) || value.code < 0)) return; result.code = value.code; }
    if ('recorded' in value) { if (!Number.isSafeInteger(value.recorded) || value.recorded < 0) return; result.recorded = value.recorded; }
    if ('proof' in value) { if (!['taskkill', 'observed-exit', 'unproven'].includes(value.proof)) return; result.proof = value.proof; }
    if ('reason' in value) { if (!diagnosticReasons.includes(value.reason)) return; result.reason = value.reason; }
    return result;
  } catch { return; }
}

function failureReason(error, fallback) {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (error?.killed === true) return 'timeout';
  if (error?.code === 'ENOENT') return 'command_missing';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'command_denied';
  if (Number.isSafeInteger(error?.code) && error.code >= 0) return 'command_failed';
  return fallback;
}

// Creation ticks stay strings: .NET ticks exceed JavaScript's safe integer range.
// No names, command lines, credentials or unrelated process records are logged.
export function processSnapshot(value) {
  if (!Array.isArray(value)) throw new Error('Windows process inventory is unavailable.');
  const seen = new Set();
  return value.map((item) => {
    if (!item || !validPID(item.pid) || !Number.isSafeInteger(item.parentPid) || item.parentPid < 0 ||
        !validCreated(item.created) || seen.has(item.pid))
      throw new Error('Windows process identity is incomplete or ambiguous.');
    seen.add(item.pid);
    return { pid: item.pid, parentPid: item.parentPid, created: item.created };
  });
}

export function ownedProcessTree(snapshot, rootPID, hostPID) {
  if (!validPID(rootPID) || !validPID(hostPID)) throw new Error('Invalid owned process identity.');
  const rows = processSnapshot(snapshot);
  const root = rows.find((item) => item.pid === rootPID);
  if (!root || root.parentPid !== hostPID) throw new Error('Owned engine identity could not be established.');
  const owned = new Map([[root.pid, root]]);
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const item of rows) {
      const parent = owned.get(item.parentPid);
      // An older process may still have a now-reused parent PID. It is not ours.
      if (parent && BigInt(item.created) >= BigInt(parent.created)) owned.set(item.pid, item);
    }
  }
  return [...owned.values()];
}

export function recordedTreeExited(before, after) {
  const recorded = processSnapshot(before), current = processSnapshot(after);
  if (!recorded.length) throw new Error('An empty inventory cannot prove owned-tree exit.');
  const known = new Map(recorded.map((item) => [item.pid, item]));
  for (const item of current) {
    const prior = known.get(item.pid);
    // A later creation time proves PID reuse; the new process must never be killed.
    if (prior && BigInt(item.created) <= BigInt(prior.created)) return false;
    const parent = known.get(item.parentPid);
    // Also reject a surviving child that appeared after the pre-kill snapshot,
    // including an orphan whose recorded parent has already exited.
    if (parent && BigInt(item.created) >= BigInt(parent.created)) return false;
  }
  return true;
}

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function windowsSnapshot(rootPID, recorded) {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ids = recorded ? recorded.map((item) => item.pid) : [rootPID];
  if (!ids.length || !ids.every(validPID)) throw new Error('Invalid owned process inventory.');
  // CIM reads metadata once. Only the selected owned identities and descendants
  // leave PowerShell; missing creation times are retained so validation fails.
  const output = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference="Stop"; $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop); if($all.Count -eq 0){throw "Process inventory unavailable"}; $ids=[Collections.Generic.HashSet[int]]::new(); @(${ids.join(',')}) | ForEach-Object {[void]$ids.Add($_)}; do {$count=$ids.Count; foreach($p in $all) {if($ids.Contains([int]$p.ParentProcessId)) {[void]$ids.Add([int]$p.ProcessId)}}} while($ids.Count -ne $count); ConvertTo-Json -Compress -InputObject @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}else{""}}})`,
  ], 1800);
  return processSnapshot(JSON.parse(output.trim()));
}

async function killTree(rootPID) {
  const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  try {
    await run(taskkill, ['/PID', String(rootPID), '/T', '/F'], 2200);
    return 0;
  } catch (error) {
    // A timeout, signal, missing command or query error is not a taskkill exit code.
    if (Number.isSafeInteger(error.code) && error.code >= 0 && !error.killed) return error.code;
    throw error;
  }
}

export async function stopWindowsEngineTree(rootPID, hostPID, options = {}) {
  if (!validPID(rootPID) || !validPID(hostPID)) throw new Error('Invalid owned process identity.');
  const snapshot = options.snapshot || ((recorded) => windowsSnapshot(rootPID, recorded));
  const kill = options.kill || killTree;
  const started = performance.now();
  const report = (phase, outcome, since, detail = {}) => {
    try { options.onDiagnostic?.({ phase, outcome, durationMs: Math.max(0, Math.round(performance.now() - since)), ...detail }); }
    catch { /* Diagnostics must not alter cleanup or its proof. */ }
  };
  const done = (result) => {
    report('result', result.stopped ? 'ok' : 'failed', started, { code: result.code, proof: result.proof, recorded: result.recorded });
    return result;
  };
  let owned;
  const before = performance.now();
  try {
    owned = ownedProcessTree(await snapshot(), rootPID, hostPID);
    report('before', 'ok', before, { recorded: owned.length });
  } catch (error) { report('before', 'failed', before, { reason: failureReason(error, 'invalid_inventory') }); }
  // Exactly one kill request, always to the owned engine PID; never kill by name,
  // enumerate-and-kill individual PIDs, or retry against a potentially reused PID.
  if (options.isRootRunning && !options.isRootRunning()) {
    report('root-check', 'skipped', started, { reason: 'root_exited' });
    return done({ stopped: false, code: null, proof: 'unproven', recorded: owned?.length || 0 });
  }
  const killing = performance.now();
  let code = null, reason;
  try { code = await kill(rootPID); } catch (error) { reason = failureReason(error, 'command_failed'); }
  const validCode = Number.isSafeInteger(code) && code >= 0;
  report('kill', validCode ? 'ok' : 'failed', killing, { code: validCode ? code : null, ...(!validCode ? { reason: reason || 'invalid_result' } : {}) });
  if (!owned || !validCode) return done({ stopped: false, code, proof: 'unproven', recorded: owned?.length || 0 });
  if (code === 0) return done({ stopped: true, code, proof: 'taskkill', recorded: owned.length });
  const after = performance.now();
  try {
    const stopped = recordedTreeExited(owned, await snapshot(owned));
    report('after', stopped ? 'ok' : 'failed', after, stopped ? {} : { reason: 'survivor' });
    return done({ stopped, code, proof: stopped ? 'observed-exit' : 'unproven', recorded: owned.length });
  } catch (error) {
    report('after', 'failed', after, { reason: failureReason(error, 'invalid_inventory') });
    return done({ stopped: false, code, proof: 'unproven', recorded: owned.length });
  }
}
