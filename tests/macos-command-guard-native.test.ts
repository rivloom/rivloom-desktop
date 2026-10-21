import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseMacosEngineStopDiagnostic, readMacosProcesses, type MacosProcess } from '../server/macos-process.mjs';

const native = { skip: process.platform !== 'darwin', timeout: 40_000 };
const hostPath = fileURLToPath(new URL('../server/engine-host.mjs', import.meta.url));
type Event = { kind: string; label?: string; root?: number; owner?: number; guard?: number; target?: number;
  grandchild?: number; code?: number | null; signal?: string | null; input?: string; ordinaryEnv?: string;
  privateEnvAbsent?: boolean; controlClosed?: boolean; value?: string; phase?: string;
  exceptionName?: string; exceptionCode?: string };
type Frozen = { identities: MacosProcess[]; sessions: number[] };
const failureNames = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AssertionError', 'URIError', 'EvalError', 'unknown'];
const failureCodes = ['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'EBADF', 'EINVAL', 'EIO', 'ENFILE', 'EMFILE', 'ENOENT',
  'ENOMEM', 'ENOSYS', 'ENOTSUP', 'EPERM', 'EACCES', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE',
  'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ABORT_ERR', 'unknown'];
const fixturePhases = ['configuration', 'spawn-options', 'spawn', 'attach-streams', 'stdin', 'running', 'action'];

// These fixtures exercise the shipped host/helper protocol. Their independent
// 20-second lifetimes are only a failed-test containment measure; every product
// cleanup assertion has a shorter deadline and cannot pass by waiting them out.
function fixtureSource(actionPath: string, mode: string) {
  const resistant = `
    const {spawn} = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e',
      'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000)'],
      {stdio:['ignore','pipe','ignore']});
    process.on('SIGTERM', () => {});
    grandchild.stdout.once('data', () => console.log(JSON.stringify({kind:'ready', label:process.env.FIXTURE_LABEL,
      target:process.pid, guard:process.ppid, grandchild:grandchild.pid})));
    setTimeout(() => process.exit(0), 20000);
    setInterval(() => {}, 1000);
  `;
  const stdio = `
    const fs = require('node:fs');
    let controlClosed = false;
    try { fs.fstatSync(64); } catch (error) { controlClosed = error.code === 'EBADF'; }
    fs.writeSync(3, 'extra-fd-preserved\\n');
    fs.closeSync(3);
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', value => input += value);
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({kind:'stdio', input,
      ordinaryEnv:process.env.FIXTURE_ORDINARY_VALUE, controlClosed,
      privateEnvAbsent:!('RIVLOOM_MACOS_PROCESS_HELPER' in process.env) && !('RIVLOOM_MACOS_PROCESS_SOCKET' in process.env)
    }) + '\\n', () => process.exit(37)));
  `;
  return `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const helper = process.env.RIVLOOM_MACOS_PROCESS_HELPER;
    const socket = process.env.RIVLOOM_MACOS_PROCESS_SOCKET;
    const send = value => {
      try { fs.writeSync(1, 'GUARD_FIXTURE ' + JSON.stringify(value) + '\\n'); }
      catch { process.exit(76); }
    };
    const safeError = error => ({
      exceptionName: ${JSON.stringify(failureNames)}.includes(error?.name) ? error.name : 'unknown',
      exceptionCode: ${JSON.stringify(failureCodes)}.includes(error?.code) ? error.code : 'unknown'
    });
    let phase = 'configuration';
    process.on('uncaughtException', error => { send({kind:'fixture-exception',phase,...safeError(error)}); process.exit(74); });
    process.on('unhandledRejection', error => { send({kind:'fixture-rejection',phase,...safeError(error)}); process.exit(75); });
    if (!helper || !socket) { send({kind:'configuration-missing'}); process.exit(71); }
    const guards = new Map();
    const owner = process.ppid;
    send({kind:'root',root:process.pid,owner});
    function start(label, targetCode, wide = false) {
      phase = 'spawn-options';
      const controlFD = wide ? 64 : 3;
      const channels = Array(controlFD + 1).fill('ignore');
      channels[0] = 'pipe'; channels[1] = 'pipe'; channels[2] = 'pipe'; channels[controlFD] = 'pipe';
      if (wide) channels[3] = 'pipe';
      phase = 'spawn';
      const child = spawn(helper, ['guard','--control-fd',String(controlFD),'--','/bin/sh','-c',
        'exec "$FIXTURE_NODE" -e "$FIXTURE_CODE"'], {
        detached:false, shell:false, stdio:channels,
        env:{...process.env,FIXTURE_NODE:process.execPath,FIXTURE_CODE:targetCode,FIXTURE_LABEL:label,
          FIXTURE_ORDINARY_VALUE:'ordinary-value-survives'}
      });
      phase = 'attach-streams';
      guards.set(label,child);
      child.on('error', error => send({kind:'launch-error',label,phase:'spawn',...safeError(error)}));
      child.once('spawn', () => send({kind:'spawned',label,guard:child.pid}));
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 16384) process.exit(72);
        for (let end; (end = output.indexOf('\\n')) !== -1;) {
          const line = output.slice(0,end); output = output.slice(end+1);
          try { send({...JSON.parse(line),label}); } catch { send({kind:'invalid-output',label}); }
        }
      });
      child.stderr.resume();
      child.once('close', (code,signal) => send({kind:'exit',label,code,signal}));
      child.stdio[controlFD].on('error', () => {});
      phase = 'stdin';
      if (wide) {
        let extra = '';
        child.stdio[3].on('data', chunk => extra += chunk.toString());
        child.stdio[3].on('end', () => { send({kind:'extra',label,value:extra}); child.stdin.end(); });
        child.stdin.write('stdin survives the guard\\n');
      } else child.stdin.end();
      phase = 'running';
      return child;
    }
    const mode = ${JSON.stringify(mode)};
    if (mode === 'stdio') start('stdio',${JSON.stringify(stdio)},true);
    else if (mode === 'concurrent') { start('a',${JSON.stringify(resistant)}); start('b',${JSON.stringify(resistant)}); }
    else start('a',${JSON.stringify(resistant)});
    let sequence = 0;
    const actionTimer = setInterval(() => {
      let action;
      try { action = JSON.parse(fs.readFileSync(${JSON.stringify(actionPath)},'utf8')); } catch { return; }
      if (action.sequence <= sequence) return;
      phase = 'action';
      sequence = action.sequence;
      if (action.kind === 'cancel') guards.get(action.label).stdio[3].write('T');
      else if (action.kind === 'kill') guards.get(action.label).stdio[3].write('K');
      else if (action.kind === 'control-eof') guards.get(action.label).stdio[3].end();
      else if (action.kind === 'guard-crash') guards.get(action.label).kill('SIGKILL');
      else if (action.kind === 'early-pressure') {
        for (let index = 0; index < 8; index++) {
          const label = 'early-' + index;
          const child = start(label, 'console.log(JSON.stringify({kind:"early-executed"}))');
          if (index % 2 === 0) child.stdio[3].write('T'); else child.stdio[3].end();
        }
      }
      else if (action.kind === 'root-crash') process.kill(process.pid,'SIGKILL');
      else if (action.kind === 'broker-crash') {
        if (process.ppid !== owner || owner <= 1) return process.exit(73);
        process.kill(process.ppid,'SIGKILL');
      }
      else if (action.kind === 'foreign-parent') {
        const probe = spawn(process.execPath,['-e',
          'const {spawn}=require("node:child_process");' +
          'const c=spawn(process.env.RIVLOOM_MACOS_PROCESS_HELPER,["guard","--control-fd","3","--","/bin/sh","-c","echo MUST_NOT_EXECUTE"],{stdio:["ignore","pipe","ignore","pipe"]});' +
          'let output="";c.stdout.on("data",x=>output+=x);c.stdio[3].on("error",()=>{});' +
          'c.on("exit",(code,signal)=>console.log(JSON.stringify({kind:"foreign-result",code,signal,value:output})));'
        ],{stdio:['ignore','pipe','ignore']});
        let output = '';
        probe.stdout.on('data', chunk => output += chunk.toString());
        probe.once('close', () => { try { send(JSON.parse(output)); } catch { send({kind:'invalid-probe'}); } });
      }
    },25);
    setTimeout(() => { clearInterval(actionTimer); process.exit(0); },20000);
  `;
}

async function start(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'rivloom-command-guard-'));
  const actionPath = join(directory, 'action.json');
  const child = spawn(process.execPath, [hostPath, process.execPath, '-e', fixtureSource(actionPath, mode)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const events: Event[] = [];
  let buffer = '', errors = '', sequence = 0;
  child.stdout!.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 65536) { if (child.connected) child.disconnect(); return; }
    for (let end; (end = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.startsWith('GUARD_FIXTURE ')) events.push(JSON.parse(line.slice(14)) as Event);
    }
  });
  child.stderr!.on('data', chunk => { errors = (errors + chunk.toString()).slice(-65536); });
  const diagnostics = () => JSON.stringify({
    host: { exitCode: child.exitCode, signalCode: child.signalCode },
    stop: errors.split('\n').map(parseMacosEngineStopDiagnostic).filter(Boolean).slice(-2),
    fixture: events.filter(value => ['fixture-exception', 'fixture-rejection', 'launch-error'].includes(value.kind)).slice(-4).map(value => ({
      kind: value.kind,
      phase: fixturePhases.includes(value.phase!) ? value.phase : 'unknown',
      exceptionName: failureNames.includes(value.exceptionName!) ? value.exceptionName : 'unknown',
      exceptionCode: failureCodes.includes(value.exceptionCode!) ? value.exceptionCode : 'unknown',
    })),
  });
  const wait = async (kind: string, label?: string, timeout = 6000) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const event = events.find(value => value.kind === kind && (label === undefined || value.label === label));
      if (event) return event;
      assert(child.exitCode === null && child.signalCode === null,
        `Guard fixture exited before ${kind}; events=${events.map(value => value.kind).join(',')}; diagnostics=${diagnostics()}`);
      await delay(25);
    }
    assert.fail(`Guard fixture timed out before ${kind}; events=${events.map(value => value.kind).join(',')}; diagnostics=${diagnostics()}`);
  };
  const cleanup = async () => {
    if (child.connected) child.disconnect();
    await exited(child);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const root = await wait('root');
    return { child, root, wait, errors: () => errors, seen: (kind: string) => events.some(value => value.kind === kind), cleanup,
      action: async (kind: string, label?: string) => writeFile(actionPath, JSON.stringify({ sequence: ++sequence, kind, label }), { mode: 0o600 }) };
  } catch (error) { await cleanup(); throw error; }
}

async function exited(child: ChildProcess, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await delay(40);
  assert(child.exitCode !== null || child.signalCode !== null, 'Guard fixture host exceeded its exit deadline');
  return child.exitCode;
}

async function freeze(root: Event, commands: Event[]): Promise<Frozen> {
  const rows = await readMacosProcesses();
  const ids = [root.root, root.owner, ...commands.flatMap(value => [value.guard, value.target, value.grandchild])];
  assert(ids.every(value => Number.isSafeInteger(value) && Number(value) > 1));
  const identities = ids.map(id => {
    const row = rows.find(value => value.pid === id && !value.zombie);
    assert(row?.created, 'Capture each actual process birth before exercising cancellation');
    return row;
  });
  for (const command of commands) {
    for (const id of [command.guard, command.target, command.grandchild]) {
      const row = identities.find(value => value.pid === id)!;
      assert.equal(row.session, command.guard, 'A managed command must own its registered session');
      assert.equal(row.group, command.guard, 'A managed command must keep the target in its private group');
    }
  }
  return { identities, sessions: [root.owner!, ...commands.map(value => value.guard!)] };
}

async function proveGone(frozen: Frozen, timeout = 7000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const rows = await readMacosProcesses();
    const survivors = rows.filter(row => !row.zombie && (frozen.sessions.includes(row.session) ||
      frozen.identities.some(value => value.pid === row.pid && value.created === row.created)));
    if (!survivors.length) return;
    await delay(80);
  }
  assert.fail('A recorded command process or private-session descendant survived the cleanup deadline');
}

function commandOnly(frozen: Frozen, command: Event): Frozen {
  return { identities: frozen.identities.filter(value => [command.guard, command.target, command.grandchild].includes(value.pid)),
    sessions: [command.guard!] };
}

async function stillAlive(frozen: Frozen) {
  const rows = await readMacosProcesses();
  for (const value of frozen.identities)
    assert(rows.some(row => row.pid === value.pid && row.created === value.created && !row.zombie), 'Cancelling another command must preserve this exact process incarnation');
}

function observedExit(errors: string) {
  const diagnostic = errors.split('\n').map(parseMacosEngineStopDiagnostic).find(Boolean);
  assert(diagnostic && diagnostic.outcome === 'ok' && diagnostic.proof === 'observed-exit' && diagnostic.failure === 'none',
    'Normal host shutdown must retain its complete observed-exit proof');
}

test('macOS command guard preserves real shell stdin, extra descriptors, environment and exit status', native, async () => {
  const fixture = await start('stdio');
  try {
    const value = await fixture.wait('stdio', 'stdio');
    assert.equal(value.input, 'stdin survives the guard\n');
    assert.equal(value.ordinaryEnv, 'ordinary-value-survives');
    assert.equal(value.privateEnvAbsent, true, 'Broker configuration must not reach the target');
    assert.equal(value.controlClosed, true, 'The target must not inherit its cancellation channel');
    assert.equal((await fixture.wait('extra', 'stdio')).value, 'extra-fd-preserved\n');
    const result = await fixture.wait('exit', 'stdio');
    assert.equal(result.code, 37, 'The guard must propagate the real target exit code');
    assert.equal(result.signal, null);
    fixture.child.disconnect();
    assert.equal(await exited(fixture.child), 0);
    observedExit(fixture.errors());
  } finally { await fixture.cleanup(); }
});

test('macOS command cancellation isolates concurrent shells and kills a TERM-resistant grandchild', native, async () => {
  const fixture = await start('concurrent');
  let frozen: Frozen | undefined;
  try {
    const a = await fixture.wait('ready', 'a'), b = await fixture.wait('ready', 'b');
    frozen = await freeze(fixture.root, [a, b]);
    await fixture.action('cancel', 'a');
    await fixture.wait('exit', 'a');
    await proveGone(commandOnly(frozen, a));
    await stillAlive(commandOnly(frozen, b));
    assert.equal(fixture.child.exitCode, null, 'Cancelling one command must preserve its engine');
    fixture.child.disconnect();
    assert.equal(await exited(fixture.child), 0);
    await proveGone(frozen);
    observedExit(fixture.errors());
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

test('macOS command guard cleans registered sessions after an engine root crash', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    await fixture.action('root-crash');
    assert.equal(await exited(fixture.child), 137, 'The real engine crash status must reach its caller');
    await proveGone(frozen);
    const diagnostic = fixture.errors().split('\n').map(parseMacosEngineStopDiagnostic).find(Boolean);
    assert.equal(diagnostic?.proof, 'observed-exit');
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

test('macOS command guard private EOF cleans registered sessions after a JavaScript host crash', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    fixture.child.kill('SIGKILL');
    await exited(fixture.child);
    await proveGone(frozen);
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

test('macOS command guard broker crash cleans command groups and the original engine session', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    await fixture.action('broker-crash');
    assert.equal(await exited(fixture.child), 1, 'An unexpected broker death must be reported as failure');
    await proveGone(frozen);
    const diagnostic = fixture.errors().split('\n').map(parseMacosEngineStopDiagnostic).find(Boolean);
    assert(diagnostic && diagnostic.outcome === 'failed' && diagnostic.proof === 'unproven',
      'The host must not manufacture a normal-shutdown receipt after losing its broker');
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

test('macOS command guard watchdog cleans a command after its registered leader crashes', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    await fixture.action('guard-crash', 'a');
    await proveGone(commandOnly(frozen, command));
    assert.equal(await exited(fixture.child), 1, 'Unexpected loss of a registered leader must fail closed');
    await proveGone(frozen);
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

for (const action of ['kill', 'control-eof'] as const) {
  test(`macOS command guard ${action} cancels only its command through the private channel`, native, async () => {
    const fixture = await start('crash');
    let frozen: Frozen | undefined;
    try {
      const command = await fixture.wait('ready', 'a');
      frozen = await freeze(fixture.root, [command]);
      await fixture.action(action, 'a');
      await fixture.wait('exit', 'a');
      await proveGone(commandOnly(frozen, command));
      await stillAlive({ identities: frozen.identities.filter(value => [fixture.root.root, fixture.root.owner].includes(value.pid)),
        sessions: [fixture.root.owner!] });
      fixture.child.disconnect();
      assert.equal(await exited(fixture.child), 0);
      await proveGone(frozen);
      observedExit(fixture.errors());
    } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
  });
}

test('macOS command guard rejects the real helper launched by a foreign parent without executing its target', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    await fixture.action('foreign-parent');
    const probe = await fixture.wait('foreign-result');
    assert.notEqual(probe.code, 0);
    assert.equal(probe.value, '', 'An unregistered helper must not execute any target bytes');
    await stillAlive(frozen);
    fixture.child.disconnect();
    assert.equal(await exited(fixture.child), 0);
    await proveGone(frozen);
    observedExit(fixture.errors());
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});

test('macOS command guards cancelled immediately by T or EOF preserve a concurrent live engine', native, async () => {
  const fixture = await start('crash');
  let frozen: Frozen | undefined;
  try {
    const command = await fixture.wait('ready', 'a');
    frozen = await freeze(fixture.root, [command]);
    await fixture.action('early-pressure');
    for (let index = 0; index < 8; index++) {
      const result = await fixture.wait('exit', `early-${index}`);
      assert(result.code !== null || result.signal !== null, 'Each early cancellation must actually terminate its helper');
    }
    assert.equal(fixture.seen('early-executed'), false, 'Immediate cancellation must keep every new target behind its execution gate');
    await stillAlive(frozen);
    fixture.child.disconnect();
    assert.equal(await exited(fixture.child), 0, 'A legitimate early cancellation must not turn into an engine failure');
    await proveGone(frozen);
    observedExit(fixture.errors());
  } finally { await fixture.cleanup(); if (frozen) await proveGone(frozen); }
});
