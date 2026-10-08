import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPrepareUpdate, updateBlockers, UpdateMaintenance, type UpdateReadiness } from '../server/update-maintenance.ts';
import { shouldPromptForUpdate, updateDownloadPercent, updateIsBusy, updateIsInstalling, type DesktopUpdateSnapshot } from '../shared/desktop-update.ts';
import { DatabaseSync } from 'node:sqlite';
import { assertReadableWorkspaceDatabase } from '../server/data-format.ts';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';

type UpdateRouteResponse = { statusCode: number; body: { ready?: boolean; released?: boolean; lease?: string | null; blockers?: { operations: number } } };
function desktopIndexFixture() {
  const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const section = (start: string, end: string) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert(first >= 0 && last > first, `Missing complete index section: ${start}`);
    return source.slice(first, last);
  };
  const routeSource = section('function authorizeNativeUpdate(req: Request)', "app.get('/api/health'");
  const queueSource = section('let dispatchingQueue = false;', "nodeNetwork.on('task-files-changed'");
  const controlSource = section('async function processRemoteControl(taskID: string, controlID: string)', 'async function stopExecutionsForRevokedNode');
  let clock = 1000, acquired = 0, completedQueues = 0, modelRuns = 0, admissionRuns = 0;
  const gate = new UpdateMaintenance(() => clock), acquire = gate.acquire.bind(gate);
  gate.acquire = () => { acquired++; return acquire(); };
  const remoteID = randomUUID(), controlID = randomUUID(), localID = randomUUID(), ownerID = 'A'.repeat(32);
  const pending = [{ taskID: remoteID, localTaskID: localID,
    control: { controlID, ownerNodeID: ownerID, action: { kind: 'supplement', text: 'Keep the original execution.' } } }];
  const events = new EventEmitter(), actions: string[] = [], finished: string[] = [], timers: (() => void)[] = [];
  const queueEntries: { id: string; state: string; source: { kind: 'local' } }[] = [];
  const local = { id: localID, projectID: randomUUID(), version: 1, remoteOrigin: { remoteTaskID: remoteID } };
  let queueWork: () => Promise<void> = async () => {};
  let requirementWork: () => Promise<void> = async () => {};
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const dependencies = {
    app: { post: (path: string, handler: (req: unknown, res: unknown) => unknown) => routes.set(path, handler) },
    desktop: true, desktopToken: 'fixture-token', sameToken: (a: string, b: string) => a === b, z, id: randomUUID,
    requireThat: (condition: unknown, status: number, message: string) => {
      if (!condition) throw Object.assign(new Error(message), { status });
    },
    updateMaintenance: gate, updateBlockers, canPrepareUpdate,
    tasks: () => [], nodeQueue: { list: () => queueEntries },
    workflowRuntime: { store: { list: () => [] }, service: { pendingOperations: 0 } }, modelSettings: () => ({ checks: {} }),
    nodeNetwork: {
      snapshot: () => ({ remoteTasks: [], brainTasks: [] }), files: { active: false }, updateOperations: 0,
      pendingRemoteTaskControls: () => [...pending], remoteTask: () => ({ direction: 'incoming', ownerNodeID: ownerID }),
      isTrustedNode: (id: string) => id === ownerID,
      finishRemoteTaskControl: (taskID: string, id: string) => {
        assert.equal(taskID, remoteID); assert.equal(id, controlID); finished.push(id); pending.splice(0);
      },
      on: events.on.bind(events),
    },
    task: () => local, users: () => [{ id: 'fixture-user', owner: true }], activities: () => [],
    activity: (_taskID: string, _actor: string, kind: string) => actions.push(kind),
    workerAdmission: { run: async (run: () => Promise<void>) => { admissionRuns++; await run(); } },
    exclusive: async (_key: string, run: () => Promise<void>) => run(), executionPolicies: { allows: () => true },
    queueForRemote: () => null, assertExecutionCapacity: () => {},
    assertCanStartTask: () => assert.equal(gate.active, false, 'Existing admission must retain its start guard'),
    addRequirement: async () => { await requirementWork(); return local; },
    runTask: async () => { assert.equal(gate.active, false); modelRuns++; }, redact: (text: string) => text,
    publishRemoteExecution: async () => {},
    processLocalQueue: async () => { await queueWork(); assert.equal(gate.active, false); completedQueues++; },
    processRemoteTask: async () => {}, intakeRemoteQueue: () => {}, publishQueueReceipts: async () => {},
    Date: { now: () => clock }, setTimeout: (callback: () => void) => { timers.push(callback); },
    console: { error: (message: string) => { throw new Error(message); } },
  };
  const bound = runInNewContext(stripTypeScriptTypes(`function bindDesktopFixture() {
    const processingRemoteTasks = new Set(), processingRemoteControls = new Set();
    let updateLease = null, updateTargetVersion = null;
    ${routeSource}
    ${queueSource}
    ${controlSource}
    return { processRemoteTasks, processRemoteControl, processRemoteControls, processingRemoteTasks, processingRemoteControls,
      getLease: () => updateLease, getTarget: () => updateTargetVersion, dispatching: () => dispatchingQueue };
  } bindDesktopFixture();`, { mode: 'strip', sourceUrl: 'desktop-update-index-fixture.ts' }), dependencies) as {
    processRemoteTasks(): Promise<void>; processRemoteControl(taskID: string, controlID: string): Promise<void>;
    processRemoteControls(): Promise<void>; processingRemoteTasks: Set<string>; processingRemoteControls: Set<string>;
    getLease(): string | null; getTarget(): string | null; dispatching(): boolean;
  };
  const call = async (path: 'prepare' | 'cancel', body: unknown): Promise<UpdateRouteResponse> => {
    const handler = routes.get(`/api/desktop-update/${path}`); assert(handler);
    const response: UpdateRouteResponse = { statusCode: 200, body: {} };
    const res = { json: (value: UpdateRouteResponse['body']) => { response.body = value; return res; },
      status: (status: number) => { response.statusCode = status; return res; } };
    await handler({ headers: { 'x-rivloom-desktop-token': 'fixture-token' }, body }, res);
    return response;
  };
  return { ...bound, gate, call, remoteID, controlID, actions, finished, pending, events, timers, queueEntries,
    acquireCount: () => acquired, modelRuns: () => modelRuns, admissionRuns: () => admissionRuns, completedQueues: () => completedQueues,
    advanceClock: (milliseconds: number) => { clock += milliseconds; },
    setQueueWork: (work: () => Promise<void>) => { queueWork = work; },
    setRequirementWork: (work: () => Promise<void>) => { requirementWork = work; },
  };
}

test('desktop prepare leaves existing queue and remote control admissions outside maintenance until they finish', async () => {
  const queue = desktopIndexFixture();
  let finishQueue!: () => void;
  queue.setQueueWork(() => new Promise<void>(resolve => { finishQueue = resolve; }));
  queue.queueEntries.push({ id: randomUUID(), state: 'waiting', source: { kind: 'local' } });
  const dispatch = queue.processRemoteTasks(); assert.equal(queue.dispatching(), true);
  const refusedQueue = await queue.call('prepare', { version: '0.1.30' });
  assert.equal(refusedQueue.body.ready, false); assert.equal(refusedQueue.body.lease, null);
  assert.equal(refusedQueue.body.blockers!.operations, 1); assert.equal(queue.acquireCount(), 0);
  assert.equal(queue.gate.active, false); finishQueue(); await dispatch;
  assert.equal(queue.dispatching(), false); assert.equal(queue.completedQueues(), 1);

  const remote = desktopIndexFixture(); remote.processingRemoteTasks.add(remote.remoteID);
  const refusedRemote = await remote.call('prepare', { version: '0.1.30' });
  assert.equal(refusedRemote.body.ready, false); assert.equal(refusedRemote.body.blockers!.operations, 1);
  assert.equal(remote.acquireCount(), 0); assert.equal(remote.gate.active, false);
  assert(remote.processingRemoteTasks.has(remote.remoteID)); remote.processingRemoteTasks.delete(remote.remoteID);

  const control = desktopIndexFixture();
  let finishRequirement!: () => void;
  control.setRequirementWork(() => new Promise<void>(resolve => { finishRequirement = resolve; }));
  const working = control.processRemoteControl(control.remoteID, control.controlID);
  assert(control.processingRemoteControls.has(control.controlID));
  const refusedControl = await control.call('prepare', { version: '0.1.30' });
  assert.equal(refusedControl.body.ready, false); assert.equal(refusedControl.body.blockers!.operations, 1);
  assert.equal(control.acquireCount(), 0); assert.equal(control.gate.active, false);
  assert.equal(control.finished.length, 0); finishRequirement(); await working;
  assert.equal(control.modelRuns(), 1); assert.deepEqual(control.finished, [control.controlID]);
  assert.equal(control.processingRemoteControls.size, 0);
});

test('desktop maintenance freezes control timer and event handlers without consuming the original control', async () => {
  const fixture = desktopIndexFixture();
  assert.equal(fixture.gate.acquire(), true);
  await fixture.processRemoteControls();
  fixture.events.emit('remote-task-control', { taskID: fixture.remoteID, controlID: fixture.controlID });
  await Promise.resolve();
  assert.equal(fixture.pending.length, 1); assert.equal(fixture.finished.length, 0);
  assert.equal(fixture.actions.length, 0); assert.equal(fixture.admissionRuns(), 0); assert.equal(fixture.modelRuns(), 0);
  assert.equal(fixture.processingRemoteControls.size, 0);
  fixture.gate.release(); await fixture.processRemoteControls();
  assert.deepEqual(fixture.finished, [fixture.controlID]); assert.equal(fixture.pending.length, 0);
  assert.equal(fixture.admissionRuns(), 1); assert.equal(fixture.modelRuns(), 1);
  assert.deepEqual(fixture.actions, ['remote_control_started', 'remote_control']);
});

test('desktop preparation invalidates an expired lease before draining so stale cancel cannot release the new gate', async () => {
  const fixture = desktopIndexFixture();
  const original = await fixture.call('prepare', { version: '0.1.30' });
  assert.equal(original.body.ready, true); const oldLease = original.body.lease; assert(oldLease);
  fixture.advanceClock(120_001); assert.equal(fixture.gate.active, false);
  const finishWrite = fixture.gate.enterOperation(); assert(finishWrite);
  const preparing = fixture.call('prepare', { version: '0.1.31' });
  assert.equal(fixture.gate.active, true); assert.equal(fixture.gate.pending, 1); assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.getLease(), null); assert.equal(fixture.getTarget(), null);
  await assert.rejects(fixture.call('cancel', { lease: oldLease }), (error: unknown) => (error as { status?: number }).status === 409);
  assert.equal(fixture.gate.active, true); assert.equal(fixture.gate.pending, 1);
  finishWrite(); fixture.timers.shift()!();
  const ready = await preparing;
  assert.equal(ready.body.ready, true); assert(ready.body.lease); assert.notEqual(ready.body.lease, oldLease);
  assert.equal(fixture.getTarget(), '0.1.31');
  await fixture.call('cancel', { lease: ready.body.lease }); assert.equal(fixture.gate.active, false);
});

test('renderer native calls have generated permissions and access from the owned desktop window', () => {
  const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const configuration = JSON.parse(read('src-tauri/tauri.conf.json'));
  const capability = configuration.app.security.capabilities.find((entry: { identifier: string }) => entry.identifier === 'desktop-main');
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, false);
  assert.deepEqual(capability.remote.urls, ['http://127.0.0.1:*']);
  const manifest = read('src-tauri/build.rs').match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1];
  assert(manifest);
  const generatedCommands = new Set([...manifest.matchAll(/"([a-z_]+)"/g)].map(match => match[1]));
  const handler = read('src-tauri/src/main.rs').match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1];
  assert(handler);
  const handled = new Set(handler.split(',').map(value => value.trim().split('::').at(-1)));
  const calls = new Set<string>();
  for (const file of ['src/desktop.ts', 'src/i18n.ts']) {
    const source = stripTypeScriptTypes(read(file), { mode: 'strip', sourceUrl: file });
    const commands = [...source.matchAll(/\binvoke\s*\(\s*['"]([a-z_]+)['"]/g)];
    assert.equal(commands.length, [...source.matchAll(/\binvoke\s*\(/g)].length, 'Native bridge calls must use fixed command names');
    for (const match of commands) calls.add(match[1]);
  }
  assert(calls.size > 0);
  for (const command of calls) {
    assert(handled.has(command), `${command}: missing native handler`);
    assert(generatedCommands.has(command), `${command}: missing Tauri permission generation`);
    const permission = 'allow-' + command.replaceAll('_', '-');
    assert(capability.permissions.includes(permission), `${command}: denied to the desktop workspace`);
    const declaration = read(`src-tauri/permissions/autogenerated/${command}.toml`);
    assert(declaration.includes(`identifier = "${permission}"`), `${command}: missing generated permission`);
    assert(declaration.includes(`commands.allow = ["${command}"]`), `${command}: permission does not enable the native command`);
  }
});

const idle = (): UpdateReadiness => ({ tasks: [], queues: [], workflows: [], remoteTasks: [], brainTasks: [], transfers: 0, operations: 0, modelChecks: 0 });

test('an incompatible future database is rejected before its format marker or content changes', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec("CREATE TABLE future_state(value TEXT); INSERT INTO future_state VALUES ('keep'); PRAGMA user_version=5;");
    assert.throws(() => assertReadableWorkspaceDatabase(database), /更高版本/);
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(database.prepare('SELECT value FROM future_state').get()?.value, 'keep');
    database.exec('PRAGMA user_version=3');
    assert.equal(assertReadableWorkspaceDatabase(database), 3);
  } finally { database.close(); }
});

test('updates protect local execution while retaining saved queues and coordinator state', () => {
  for (const state of ['running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted', 'review'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), tasks: [{ state }] })), false, state);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), tasks: [{ state: 'accepted' }, { state: 'failed' }, { state: 'stopped' }, { state: 'open' }] })), true);
  for (const state of ['waiting', 'held', 'admitted'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), queues: [{ state }] })), true, state);
  for (const state of ['planning', 'running', 'paused', 'stopping'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), workflows: [{ state }] })), true, state);
  for (const field of ['transfers', 'operations', 'modelChecks'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), [field]: 1 })), false, field);
});

test('saved remote controls and Brain results survive updates without claiming their execution ended', () => {
  const done = { status: 'accepted' as const, executionState: 'accepted' as const, controlPending: false, deliveryPending: false };
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), remoteTasks: [done] })), true);
  for (const delta of [{ controlPending: true }, { deliveryPending: true }, { executionState: 'interrupted' as const }, { status: 'pending' as const }])
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), remoteTasks: [{ ...done, ...delta }] })), true);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), brainTasks: [{ status: 'completed', deliveryPending: true }] })), true);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), brainTasks: [{ status: 'queued', deliveryPending: false }] })), true);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), remoteTasks: [done], operations: 1 })), false,
    'An actual in-flight network write still drains before preparation');
});

test('updates retain queued conversation rounds without requiring users to cancel their messages', () => {
  const workflow = { state: 'completed' as const, messages: [{ requestID: 'next', text: 'Continue', state: 'queued' as const, inputFiles: [], createdAt: '' }] };
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), workflows: [workflow] })), true);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), workflows: [{ ...workflow, queuePaused: true }] })), true);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), workflows: [{ ...workflow, roundRequestID: 'next' }] })), true);
});

test('maintenance atomically fences intake, tracks in-flight writes and recovers from a lost caller', () => {
  let clock = 1000;
  const gate = new UpdateMaintenance(() => clock);
  const finish = gate.enterOperation()!;
  assert.equal(gate.pending, 1);
  assert.equal(gate.acquire(), true);
  assert.equal(gate.acquire(), false);
  assert.equal(gate.enterOperation(), null);
  finish(); finish();
  assert.equal(gate.pending, 0);
  gate.release();
  const second = gate.enterOperation()!; second();
  assert.equal(gate.acquire(), true);
  clock += 120_001;
  assert.equal(gate.active, false);
  assert.equal(gate.acquire(), true);
  assert.equal(gate.commit(), true);
  assert.equal(gate.commit(), false);
  gate.release(); clock += 120_001;
  assert.equal(gate.active, true, 'A committed shutdown cannot be cancelled or expire');
  assert.equal(gate.enterOperation(), null);
});

const snapshot = (): DesktopUpdateSnapshot => ({ phase: 'available', currentVersion: '0.1.4', release: { version: '0.1.5', notes: '', publishedAt: null },
  skippedVersion: null, lastCheckedAt: null, downloadedBytes: 0, totalBytes: null, error: null, blockers: null, revision: 1 });

test('only the selected skipped version is quiet and progress cannot exceed its bounds', () => {
  const value = snapshot();
  assert.equal(shouldPromptForUpdate(value), true);
  value.skippedVersion = '0.1.5';
  assert.equal(shouldPromptForUpdate(value), false);
  value.release!.version = '0.1.6';
  assert.equal(shouldPromptForUpdate(value), true);
  value.phase = 'downloading';
  assert.equal(shouldPromptForUpdate(value), false);
  assert.equal(updateDownloadPercent(value), null);
  value.totalBytes = 100; value.downloadedBytes = 60;
  assert.equal(updateDownloadPercent(value), 60);
  value.downloadedBytes = 150;
  assert.equal(updateDownloadPercent(value), 100);
  assert.equal(updateIsBusy('ready'), false);
  assert.equal(updateIsBusy('preparing'), true);
});

test('every native installation phase stays busy without displaying an update offer', () => {
  for (const phase of ['preparing', 'stopping', 'backing_up', 'installing'] as const) {
    assert.equal(updateIsInstalling(phase), true, phase);
    assert.equal(updateIsBusy(phase), true, phase);
    assert.equal(shouldPromptForUpdate({ ...snapshot(), phase }), false, phase);
  }
  for (const phase of ['ready', 'available', 'error', 'downloading'] as const)
    assert.equal(updateIsInstalling(phase), false, phase);
});
