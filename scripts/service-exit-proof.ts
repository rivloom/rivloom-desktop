import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const { processSnapshot, ownedProcessTree, recordedTreeExited, windowsPowerShellEnvironment,
  windowsPowerShellPrelude } = await import(new URL('../server/windows-engine-stop.mjs', import.meta.url).href);

export type ServiceProcess = { pid: number; parentPid: number; created: string };
export type ServiceExitProof = { serviceURL: string; engineURL: string; processes: ServiceProcess[] };
type ChildStatus = { exitCode: number | null; signalCode: NodeJS.Signals | null };

function loopback(url: string) {
  const value = new URL(url);
  assert.equal(value.protocol, 'http:');
  assert.equal(value.hostname, '127.0.0.1');
  assert(Number(value.port) > 0, 'The exact fixture listener must be recorded');
  return value;
}

export async function fixtureListenerOpen(url: string, timeout = 500) {
  const address = loopback(url);
  return new Promise<boolean>((ok, fail) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    const done = (listening: boolean) => { socket.destroy(); ok(listening); };
    socket.once('connect', () => done(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') done(false);
      else { socket.destroy(); fail(error); }
    });
    // An unresponsive connect is not proof that a listener has closed.
    socket.setTimeout(timeout, () => done(true));
  });
}

async function windowsProcesses(ids: number[], timeout: number): Promise<ServiceProcess[]> {
  assert(ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0));
  assert(timeout > 0, 'Do not start an unbounded process query');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only the recorded fixture identities and their descendants leave PowerShell.
  // No process names, command lines, paths or credentials are collected.
  const command = `${windowsPowerShellPrelude}$ErrorActionPreference="Stop"; $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop); if($all.Count -eq 0){throw "Process inventory unavailable"}; $ids=[Collections.Generic.HashSet[int]]::new(); @(${ids.join(',')}) | ForEach-Object {[void]$ids.Add($_)}; do {$count=$ids.Count; foreach($p in $all) {if($ids.Contains([int]$p.ParentProcessId)) {[void]$ids.Add([int]$p.ProcessId)}}} while($ids.Count -ne $count); ConvertTo-Json -Compress -InputObject @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}else{""}}})`;
  const output = await new Promise<string>((ok, fail) => execFile(powershell,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, env: windowsPowerShellEnvironment() },
    (error, stdout) => error ? fail(error) : ok(stdout)));
  return processSnapshot(JSON.parse(output.trim()));
}

export async function freezeServiceExitProof(servicePID: number, serviceURL: string, output: string): Promise<ServiceExitProof> {
  const engineURL = output.match(/RIVLOOM_ENGINE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(engineURL, 'Record the engine listener before stopping this fixture');
  loopback(serviceURL); loopback(engineURL);
  const processes = process.platform === 'win32'
    ? ownedProcessTree(await windowsProcesses([servicePID], 5000), servicePID, process.pid) as ServiceProcess[] : [];
  // Windows fixture startup creates service -> engine host -> actual Runtime.
  if (process.platform === 'win32') assert(processes.length >= 3, 'The owned Runtime tree must be present before shutdown');
  return { serviceURL, engineURL, processes };
}

/** Test-only barrier: no signals, retries of failed queries, SQLite writes or WAL removal. */
export async function waitForServiceExit(proof: ServiceExitProof, status: () => ChildStatus, options: {
  timeoutMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  listening?: (url: string, timeout: number) => Promise<boolean>;
  snapshot?: (ids: number[], timeout: number) => Promise<ServiceProcess[]>;
} = {}) {
  const now = options.now || performance.now.bind(performance);
  const wait = options.wait || ((milliseconds) => new Promise<void>(ok => setTimeout(ok, milliseconds)));
  const listening = options.listening || fixtureListenerOpen;
  const snapshot = options.snapshot || windowsProcesses;
  const timeout = options.timeoutMs ?? 10_000;
  assert(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 10_000, 'Fixture exit proof must have a bounded deadline');
  const started = now(), deadline = started + timeout;
  const remaining = () => {
    const value = Math.floor(deadline - now());
    assert(value > 0, 'Owned fixture Runtime exit was not confirmed before the deadline');
    return value;
  };
  for (;;) {
    remaining();
    const current = status();
    assert.equal(current.signalCode, null, 'Fixture service ended by a signal, not a verified shutdown');
    assert(current.exitCode === null || current.exitCode === 0, 'Fixture service shutdown failed');
    const [serviceListening, engineListening] = await Promise.all([
      listening(proof.serviceURL, Math.min(500, remaining())),
      listening(proof.engineURL, Math.min(500, remaining())),
    ]);
    const processes = proof.processes.length ? await snapshot(proof.processes.map(value => value.pid), remaining()) : [];
    remaining(); // A late observation is not an exit proof.
    const treeExited = !proof.processes.length || recordedTreeExited(proof.processes, processes);
    if (current.exitCode === 0 && !serviceListening && !engineListening && treeExited)
      return { confirmedClosed: true, exitCode: 0, signalCode: null, serviceListening, engineListening,
        recordedProcessCount: proof.processes.length, treeExited, durationMs: Math.round(now() - started) };
    await wait(Math.min(100, remaining()));
  }
}
