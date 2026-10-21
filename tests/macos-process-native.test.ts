import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosMediaProcessCount, macosProcessHelper, parseMacosEngineStopDiagnostic, readMacosProcesses, type MacosProcess } from '../server/macos-process.mjs';

const native = { skip: process.platform !== 'darwin', timeout: 15_000 };
const hostPath = fileURLToPath(new URL('../server/engine-host.mjs', import.meta.url));
type Fixture = { root: number; leader: number; child?: number };
const code = (mode: string) => mode === 'churn' ? `
  const {spawn} = require('node:child_process');
  console.log('FIXTURE ' + JSON.stringify({root:process.pid,leader:process.ppid}));
  const deadline = performance.now() + 4000;
  let completed = 0, finished = 0;
  function next() {
    const child = spawn('/bin/sh', ['-c', 'exec /usr/bin/true'], {stdio:'ignore'});
    child.once('error', () => process.exit(1));
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) process.exit(1);
      completed++;
      if (performance.now() < deadline) setImmediate(next);
      else if (++finished === 4) console.log('CHURN ' + JSON.stringify({completed}));
    });
  }
  for (let index = 0; index < 4; index++) next();
  setInterval(() => {}, 1000);
` : `
  const {spawn} = require('node:child_process');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(mode === 'escape'
    ? 'setTimeout(() => process.exit(0), 6000); setInterval(() => {}, 1000)'
    : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')}],
    {stdio: 'ignore', detached: ${mode === 'escape'}});
  child.on('spawn', () => {
    console.log('FIXTURE ' + JSON.stringify({root:process.pid,leader:process.ppid,child:child.pid}));
    ${mode === 'early' ? 'setTimeout(() => process.exit(0), 500);' : ''}
  });
  ${mode === 'escape' ? 'child.unref();' : ''}
  setInterval(() => {}, 1000);
`;

async function start(mode: string) {
  const child = spawn(process.execPath, [hostPath, process.execPath, '-e', code(mode)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', errors = '';
  child.stdout!.on('data', value => { output += value.toString(); });
  child.stderr!.on('data', value => { errors += value.toString(); });
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const line = output.split('\n').find(value => value.startsWith('FIXTURE '));
    if (line) return { child, fixture: JSON.parse(line.slice(8)) as Fixture, errors: () => errors, output: () => output };
    assert.equal(child.exitCode, null, `Fixture failed to start: ${errors}`);
    await delay(30);
  }
  child.disconnect();
  throw new Error(`Native process fixture did not start: ${errors}`);
}

async function exited(child: ChildProcess, timeout = 7000) {
  const deadline = performance.now() + timeout;
  while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await delay(40);
  assert(child.exitCode !== null || child.signalCode !== null, 'Native process owner exceeded its deadline');
  return child.exitCode;
}

async function freeze(fixture: Fixture) {
  const rows = await readMacosProcesses();
  const owned = rows.filter(row => [fixture.root, fixture.leader, fixture.child].includes(row.pid));
  assert.equal(owned.length, fixture.child ? 3 : 2, 'Capture live fixture identities before shutdown');
  return owned;
}

async function proveGone(before: MacosProcess[], session: number, timeout = 7000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const rows = await readMacosProcesses();
    const survivors = rows.filter(row => !row.zombie && (row.session === session ||
      before.some(value => value.pid === row.pid && value.created === row.created)));
    if (!survivors.length) return;
    await delay(100);
  }
  assert.fail('The recorded native fixture or a session descendant survived shutdown');
}

test('macOS native monitoring preserves a live engine during sustained short-lived child churn', { ...native, timeout: 20_000 }, async () => {
  const fixture = await start('churn');
  let before: MacosProcess[] = [];
  let cleaned = false;
  try {
    before = await freeze(fixture.fixture);
    const deadline = performance.now() + 6000;
    let snapshots = 0, complete: string | undefined;
    while (performance.now() < deadline) {
      assert.equal(fixture.child.exitCode, null, fixture.errors());
      assert.equal(fixture.child.signalCode, null, fixture.errors());
      const rows = await readMacosProcesses();
      for (const owned of before)
        assert(rows.some(row => row.pid === owned.pid && row.created === owned.created && !row.zombie), 'Engine and private leader must remain alive during ordinary child churn');
      snapshots++;
      complete = fixture.output().split('\n').find(line => line.startsWith('CHURN '));
      if (complete) break;
      await delay(80);
    }
    assert(complete, `Short-lived child churn did not complete: ${fixture.errors()}`);
    const result = JSON.parse(complete.slice(6));
    assert(Number.isSafeInteger(result.completed) && result.completed >= 64, 'The fixture must exercise real repeated fork/exec/exit activity');
    assert(snapshots >= 2, 'The native inventory must be sampled while the root stays alive');
    fixture.child.disconnect();
    assert.equal(await exited(fixture.child), 0, fixture.errors());
    await proveGone(before, fixture.fixture.leader);
    cleaned = true;
    const diagnostic = fixture.errors().split('\n').map(parseMacosEngineStopDiagnostic).find(Boolean);
    assert(diagnostic && diagnostic.outcome === 'ok' && diagnostic.proof === 'observed-exit' && diagnostic.failure === 'none', 'Ordinary churn must retain the complete normal-shutdown proof');
  } finally {
    if (!cleaned) {
      if (fixture.child.connected) fixture.child.disconnect();
      await exited(fixture.child);
      await proveGone(before, fixture.fixture.leader);
    }
  }
});

test('macOS native cancellation kills a TERM-resistant descendant and proves group exit', native, async () => {
  const fixture = await start('cancel');
  const before = await freeze(fixture.fixture);
  fixture.child.disconnect();
  assert.equal(await exited(fixture.child), 0, fixture.errors());
  await proveGone(before, fixture.fixture.leader);
  assert.match(fixture.errors(), /"proof":"observed-exit"/);
});

test('macOS native root exit first still cleans its surviving descendant', native, async () => {
  const fixture = await start('early');
  const before = await freeze(fixture.fixture);
  assert.equal(await exited(fixture.child), 0, fixture.errors());
  await proveGone(before, fixture.fixture.leader);
});

test('macOS native owner crash closes the private pipe and cleans the group', native, async () => {
  const fixture = await start('cancel');
  const before = await freeze(fixture.fixture);
  fixture.child.kill('SIGKILL');
  await exited(fixture.child);
  await proveGone(before, fixture.fixture.leader);
});

test('macOS native changed session fails closed instead of claiming escaped work stopped', native, async () => {
  const fixture = await start('escape');
  const before = await freeze(fixture.fixture);
  // Keep the root alive long enough for the monitor to observe the changed
  // boundary. The synthetic escaped child has its own six-second lifetime.
  assert.equal(await exited(fixture.child), 1, fixture.errors());
  assert.doesNotMatch(fixture.errors(), /"proof":"observed-exit"/);
  await proveGone(before, fixture.fixture.leader);
});

test('macOS native launch gate timeout cleans up without executing the requested program', native, async () => {
  const child = spawn(macosProcessHelper(), ['run', process.execPath, '-e', 'console.log("MUST_NOT_EXECUTE")'],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let output = '', receipt = '';
  child.stdout!.on('data', value => { output += value.toString(); });
  child.stdio[3]!.on('data', value => { receipt += value.toString(); });
  const deadline = performance.now() + 2000;
  while (!receipt.includes('\n') && performance.now() < deadline) await delay(20);
  const ready = JSON.parse(receipt.split('\n')[0]);
  const before = await freeze({ root: ready.rootPID, leader: ready.groupPID });
  await exited(child, 9000);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(output, '');
  await proveGone(before, ready.groupPID);
});

test('macOS native media audit observes a synthetic foreground ffmpeg process', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rivloom-macos-media-'));
  let fixture: ChildProcess | undefined;
  try {
    const executable = join(directory, 'ffmpeg');
    await copyFile('/bin/sleep', executable);
    await chmod(executable, 0o755);
    fixture = spawn(executable, ['10'], { stdio: 'ignore' });
    await new Promise<void>((ok, fail) => { fixture!.once('spawn', ok); fixture!.once('error', fail); });
    assert(await macosMediaProcessCount() >= 1);
  } finally {
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGTERM');
    if (fixture?.pid) await exited(fixture);
    await rm(directory, { recursive: true, force: true });
  }
});
