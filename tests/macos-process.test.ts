import test from 'node:test';
import assert from 'node:assert/strict';
import { MacosProcessOwnership, macosProcessSnapshot, parseMacosLifecycle, parseMacosInventoryFailure, parseMacosEngineStopDiagnostic, waitForMacosExit,
  type MacosProcess } from '../server/macos-process.mjs';

const row = (pid: number, parentPid: number, order = pid, group = 100, session = 100): MacosProcess => ({
  pid, parentPid, group, session, uid: 501, created: String(1_750_000_000_000_000n + BigInt(order)), zombie: false,
});
const leader = row(100, 50), root = row(101, 100), child = row(102, 101), grandchild = row(103, 102);
const unrelated = row(500, 1, 1, 500, 500);
const owner = () => new MacosProcessOwnership([unrelated, leader, root], leader.pid, 50, root.pid);
function clock() {
  let elapsed = 0;
  return { now: () => elapsed, wait: async (milliseconds: number) => { elapsed += milliseconds; } };
}
const exited = () => ({ exited: true, expected: true, engineExited: true });

test('macOS native inventory diagnostics admit only fixed bounded failure labels', () => {
  const line = (value: unknown) => `RIVLOOM_PROCESS_INVENTORY_FAILURE ${JSON.stringify(value)}\n`;
  for (const reason of ['capacity', 'short-info', 'full-info-before', 'full-info-after', 'session-before', 'session-after', 'birth-changed', 'group-changed', 'uid-changed'])
    assert.equal(parseMacosInventoryFailure(line({ reason })), reason);
  for (const value of [null, { reason: 'private/path' }, { reason: 'short-info', pid: 123 }, { reason: 'short-info', secret: 'credential' }])
    assert.equal(parseMacosInventoryFailure(line(value)), undefined);
  assert.equal(parseMacosInventoryFailure(`${line({ reason: 'short-info' })}private output`), undefined);
  assert.equal(parseMacosInventoryFailure('x'.repeat(257)), undefined);
});

test('macOS host diagnostics reconstruct safe fields and reject unbounded or unknown failures', () => {
  const value = { phase: 'result', outcome: 'failed', durationMs: 12, proof: 'unproven', recorded: 4,
    failure: 'inventory-unavailable', inventoryFailure: 'group-changed' };
  const line = (diagnostic: unknown) => `RIVLOOM_ENGINE_STOP ${JSON.stringify(diagnostic)}`;
  assert.deepEqual(parseMacosEngineStopDiagnostic(line({ ...value, command: 'secret command', environment: { token: 'private' } })), value);
  for (const change of [{ phase: 'private' }, { outcome: 'skipped' }, { durationMs: -1 }, { durationMs: 1.5 },
    { recorded: 65537 }, { proof: 'private/path' }, { outcome: 'ok' }, { failure: 'secret' }, { inventoryFailure: 'Bearer secret' },
    { ownershipFailure: 'private command' }])
    assert.equal(parseMacosEngineStopDiagnostic(line({ ...value, ...change })), undefined);
  const ownership = { ...value, failure: 'ownership-uncertain', ownershipFailure: 'session-changed' };
  assert.deepEqual(parseMacosEngineStopDiagnostic(line({ ...ownership, childPID: 123, command: 'private' })), ownership);
  assert.equal(parseMacosEngineStopDiagnostic(line({ ...value, extra: 'x'.repeat(769) })), undefined);
  assert.equal(parseMacosEngineStopDiagnostic(`private prefix ${line(value)}`), undefined);
});

test('macOS inventory rejects incomplete, duplicated or malformed process identities', () => {
  for (const value of [null, [], { schemaVersion: 2, processes: [leader] }, { schemaVersion: 1, processes: [] },
    { schemaVersion: 1, processes: [leader, leader] },
    ...[{ created: '' }, { created: 1750000000000000 }, { group: -1 }, { session: 0 }, { uid: -1 }, { zombie: undefined }]
      .map(change => ({ schemaVersion: 1, processes: [{ ...leader, ...change }] }))])
    assert.throws(() => macosProcessSnapshot(value), /inventory|identity/);
  assert.deepEqual(macosProcessSnapshot({ schemaVersion: 1, processes: [{ ...leader, command: 'private' }] }), [leader]);
});

test('macOS ownership requires the live helper and blocked root in a new owned session', () => {
  assert.throws(() => new MacosProcessOwnership([leader, root], 100, 55, 101), /identity/);
  for (const changed of [{ ...leader, group: 50 }, { ...leader, session: 50 }, { ...leader, zombie: true }])
    assert.throws(() => new MacosProcessOwnership([changed, root], 100, 50, 101), /identity/);
  for (const changed of [{ ...root, parentPid: 50 }, { ...root, group: 50 }, { ...root, uid: 0 }, { ...root, zombie: true }])
    assert.throws(() => new MacosProcessOwnership([leader, changed], 100, 50, 101), /identity/);
});

test('macOS session ownership retains descendants when the engine parent exits first', () => {
  const ownership = owner();
  assert.equal(ownership.observe([leader, root, child, grandchild, unrelated]).recorded, 4);
  const state = ownership.observe([leader, { ...grandchild, parentPid: 1 }, unrelated]);
  assert.equal(state.childrenRunning, 1);
  assert.equal(state.uncertain, false);
  assert.equal(ownership.observe([unrelated]).running, 0);
});

test('macOS PID reuse cannot attach unrelated descendants or turn into a signal target', () => {
  const ownership = owner();
  ownership.observe([leader, root, child, unrelated]);
  const recycled = row(root.pid, 500, 1000, 500, 500);
  const foreignChild = row(999, root.pid, 1001, 500, 500);
  const state = ownership.observe([leader, recycled, foreignChild, unrelated]);
  assert.equal(state.childrenRunning, 0);
  assert.equal(state.recorded, 3);
  assert.equal(state.uncertain, false);
  assert.equal(ownership.observe([row(100, 500, 2000, 500, 500), unrelated]).uncertain, true);
});

test('macOS ownership fails closed on group escape, privilege change and backwards identity time', () => {
  for (const changed of [{ ...child, group: 102 }, { ...child, group: 102, session: 102 },
    { ...child, uid: 0 }, { ...root, created: '1750000000000001' }]) {
    const ownership = owner();
    ownership.observe([leader, root, child, unrelated]);
    const remaining = changed.pid === root.pid ? [leader, changed, unrelated] : [leader, root, changed, unrelated];
    assert.equal(ownership.observe(remaining).uncertain, true);
    assert.equal(ownership.observe([unrelated]).uncertain, true, 'A later empty group does not erase the earlier ownership gap');
  }
});

test('macOS ownership distinguishes a changed group from a new session without forgetting either gap', async () => {
  for (const [changed, reason] of [[{ ...child, group: 102 }, 'group-changed'],
    [{ ...child, group: 102, session: 102 }, 'session-changed']] as const) {
    const ownership = owner();
    const state = ownership.observe([leader, root, changed, unrelated]);
    assert.equal(state.recorded, 3);
    assert.equal(state.uncertain, true);
    assert.equal(state.ownershipFailure, reason);
    assert.equal(ownership.observe([unrelated]).ownershipFailure, reason);
    const result = await waitForMacosExit(ownership, { ...clock(), status: exited, quit: () => assert.fail('Uncertain ownership cannot request success'),
      snapshot: async () => [unrelated] });
    assert.equal(result.stopped, false);
    assert.equal(result.failure, 'ownership-uncertain');
    assert.equal(result.ownershipFailure, reason);
  }
});

test('macOS other-user metadata stays explicit and cannot hide an owned process after privilege change', () => {
  const system = { ...unrelated, uid: 0, created: null };
  const ownership = owner();
  assert.equal(ownership.observe([leader, root, system]).uncertain, false);
  assert.equal(ownership.observe([leader, { ...root, uid: 0, created: null }, system]).uncertain, true);
  const unobservedChild = owner();
  assert.equal(unobservedChild.observe([leader, root, { ...child, uid: 0, group: 102, session: 102, created: null }]).uncertain, true);
});

test('macOS complete exit proof waits for a surviving descendant after leader exit', async () => {
  const ownership = owner(), time = clock();
  ownership.observe([leader, root, child, grandchild, unrelated]);
  let queries = 0;
  const result = await waitForMacosExit(ownership, { ...time, status: exited, quit: () => assert.fail('leader already exited'),
    snapshot: async () => ++queries === 1 ? [grandchild, unrelated] : [unrelated] });
  assert.equal(result.stopped, true);
  assert.equal(result.recorded, 4);
  assert.equal(queries, 2);
  assert.equal(time.now(), 100);
});

test('macOS only requests leader exit after the engine and all observed children have stopped', async () => {
  const ownership = owner(), time = clock();
  let quit = 0;
  const result = await waitForMacosExit(ownership, { ...time,
    snapshot: async () => quit ? [unrelated] : [leader, unrelated],
    status: () => ({ exited: quit > 0, expected: quit > 0, engineExited: true }),
    quit: () => { quit++; } });
  assert.equal(result.stopped, true);
  assert.equal(quit, 1);
});

test('macOS permission failure, partial evidence, unexpected owner exit and timeout never certify cleanup', async () => {
  for (const snapshot of [async () => { throw new Error('private query error'); }, async () => [],
    async () => [leader, root, unrelated]]) {
    const result = await waitForMacosExit(owner(), { ...clock(), timeoutMs: 250, status: exited, snapshot, quit: () => {} });
    assert.equal(result.stopped, false);
    assert.equal(result.proof, 'unproven');
  }
  const result = await waitForMacosExit(owner(), { ...clock(), timeoutMs: 250,
    status: () => ({ exited: true, expected: false, engineExited: true }), snapshot: async () => [unrelated], quit: () => {} });
  assert.equal(result.stopped, false);
});

test('macOS stop failure preserves a fixed inventory cause without weakening unknown-state rejection', async () => {
  const error = Object.assign(new Error('private native text'), { inventoryFailure: 'group-changed' });
  const result = await waitForMacosExit(owner(), { ...clock(), timeoutMs: 250, status: exited,
    snapshot: async () => { throw error; }, quit: () => assert.fail('Unavailable inventory cannot request quit') });
  assert.deepEqual(result, { stopped: false, proof: 'unproven', recorded: 2,
    failure: 'inventory-unavailable', inventoryFailure: 'group-changed' });
  const unknown = await waitForMacosExit(owner(), { ...clock(), timeoutMs: 250, status: exited,
    snapshot: async () => { throw Object.assign(new Error('secret'), { inventoryFailure: 'secret' }); }, quit: () => {} });
  assert.equal(unknown.inventoryFailure, 'query-failed');
});

test('macOS late query results cannot cross the shared stop deadline', async () => {
  const time = clock();
  const budgets: number[] = [];
  const result = await waitForMacosExit(owner(), { ...time, timeoutMs: 250, status: exited, quit: () => {},
    snapshot: async timeout => { budgets.push(timeout); await time.wait(250); return [unrelated]; } });
  assert.equal(result.stopped, false);
  assert.deepEqual(budgets, [250]);
  await assert.rejects(waitForMacosExit(owner(), { timeoutMs: 0, status: exited, snapshot: async () => [unrelated], quit: () => {} }), /deadline/);
});

test('macOS zombies are no longer running but live children still block an exit proof', async () => {
  const ownership = owner();
  const state = ownership.observe([{ ...leader, zombie: true }, { ...root, zombie: true }, child, unrelated]);
  assert.equal(state.childrenRunning, 1);
  const result = await waitForMacosExit(ownership, { ...clock(), status: exited, quit: () => {},
    snapshot: async () => [{ ...leader, zombie: true }, { ...root, zombie: true }, { ...child, zombie: true }, unrelated] });
  assert.equal(result.stopped, true);
});

test('macOS lifecycle receipts are bound to the helper PID and permit no free-form diagnostics', () => {
  const ready = { schemaVersion: 1, event: 'ready', groupPID: 100, rootPID: 101, code: 0 };
  assert.deepEqual(parseMacosLifecycle({ ...ready, secret: 'private' }, 100), { event: 'ready', rootPID: 101, code: 0 });
  for (const change of [{ schemaVersion: 2 }, { event: 'private' }, { groupPID: 999 }, { rootPID: 100 }, { rootPID: -1 }, { code: 1 }])
    assert.throws(() => parseMacosLifecycle({ ...ready, ...change }, 100), /receipt/);
});

const guard = row(200, root.pid), target = row(201, guard.pid, 201, 200, 200), watcher = row(202, guard.pid, 202, 200, 200);
const isolatedGuard = { ...guard, group: guard.pid, session: guard.pid };
const registration = { event: 'guard-register', rootPID: root.pid, code: 0, id: 1, guardPID: guard.pid, created: guard.created! };
const guardReady = { event: 'guard-ready', rootPID: root.pid, code: 0, id: 1, guardPID: guard.pid,
  guardRootPID: target.pid, watchdogPID: watcher.pid };
function guarded() {
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, guard, unrelated]);
  ownership.authorizeGuard(registration.id);
  ownership.activateGuard(guardReady, [leader, root, isolatedGuard, target, watcher, unrelated]);
  return ownership;
}

test('macOS guard registration binds the live engine parent, immutable birth and sequential identity', () => {
  for (const [receipt, changed] of [
    [{ ...registration, id: 2 }, guard], [{ ...registration, created: root.created! }, guard],
    [registration, { ...guard, parentPid: leader.pid }], [registration, { ...guard, uid: 0 }],
    [registration, isolatedGuard], [registration, { ...guard, zombie: true }],
  ] as const) assert.throws(() => owner().registerGuard(receipt, [leader, root, changed, unrelated]), /identity/);
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, guard, unrelated]);
  assert.throws(() => ownership.registerGuard(registration, [leader, root, guard, unrelated]), /identity/);
  assert.throws(() => owner().registerGuard(registration, [leader, { ...root, created: guard.created }, guard, unrelated]), /identity/);
});

test('macOS only a registered guard can establish an independently controlled session', () => {
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, guard, unrelated]);
  ownership.authorizeGuard(registration.id);
  assert.equal(ownership.observe([leader, root, isolatedGuard, target, watcher, unrelated]).uncertain, false);
  ownership.activateGuard(guardReady, [leader, root, isolatedGuard, target, watcher, unrelated]);
  const escape = row(203, target.pid, 203, 203, 203);
  assert.equal(ownership.observe([leader, root, isolatedGuard, target, watcher, escape, unrelated]).uncertain, true);
  assert.equal(ownership.observe([unrelated]).uncertain, true);
  assert.equal(owner().observe([leader, root, isolatedGuard, unrelated]).uncertain, true);
});

test('macOS guarded target execution requires its own live target and watchdog identities', () => {
  for (const changed of [{ ...target, parentPid: root.pid }, { ...target, group: 100 }, { ...target, uid: 0 },
    { ...target, zombie: true }]) {
    const ownership = owner();
    ownership.registerGuard(registration, [leader, root, guard, unrelated]);
    ownership.authorizeGuard(registration.id);
    assert.throws(() => ownership.activateGuard(guardReady, [leader, root, isolatedGuard, changed, watcher, unrelated]), /identity/);
  }
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, guard, unrelated]);
  ownership.authorizeGuard(registration.id);
  assert.throws(() => ownership.activateGuard({ ...guardReady, watchdogPID: target.pid },
    [leader, root, isolatedGuard, target, watcher, unrelated]), /identity/);
  assert.throws(() => guarded().activateGuard(guardReady, [leader, root, isolatedGuard, target, watcher, unrelated]), /transition/);
});

test('macOS per-command completion waits for the real descendants and ignores only its authenticated control members', () => {
  const ownership = guarded(), grandchild = row(203, target.pid, 203, 200, 200);
  ownership.guardEvent({ ...guardReady, event: 'guard-engine-exit', code: 37 });
  ownership.guardEvent({ ...guardReady, event: 'guard-stopping' });
  ownership.observe([leader, root, isolatedGuard, watcher, { ...grandchild, parentPid: 1 }, unrelated]);
  assert.deepEqual(ownership.guardQuits(), []);
  ownership.observe([leader, root, isolatedGuard, watcher, unrelated]);
  assert.deepEqual(ownership.guardQuits(), [1]);
  assert.deepEqual(ownership.guardQuits(), [], 'A completion request is single-use');
  assert.throws(() => ownership.guardEvent({ ...guardReady, event: 'guard-engine-exit' }), /ordering/);
});

test('macOS closed guard groups retain surviving orphan identities then retire before PID reuse', () => {
  const ownership = guarded(), grandchild = row(203, target.pid, 203, 200, 200);
  ownership.observe([leader, root, isolatedGuard, target, watcher, grandchild, unrelated]);
  ownership.guardEvent({ ...guardReady, event: 'guard-stopping' });
  ownership.guardEvent({ ...guardReady, event: 'guard-closed' });
  assert.equal(ownership.observe([leader, root, { ...grandchild, parentPid: 1 }, unrelated]).childrenRunning, 2);
  assert.equal(ownership.observe([leader, root, unrelated]).uncertain, false);
  const reused = row(guard.pid, 1, 2000, guard.pid, guard.pid);
  assert.equal(ownership.observe([leader, root, reused, unrelated]).uncertain, false);
});

test('macOS the native owner watchdog is excluded from work counts but required for final disappearance', async () => {
  const watchdog = row(104, leader.pid), ownership = new MacosProcessOwnership([leader, root, watchdog, unrelated], 100, 50, 101, 104);
  const state = ownership.observe([leader, watchdog, unrelated]);
  assert.equal(state.childrenRunning, 0);
  assert.equal(state.running, 2);
  assert.equal(ownership.observe([leader, unrelated]).ownershipFailure, 'watchdog-identity');
  const stable = new MacosProcessOwnership([leader, root, watchdog, unrelated], 100, 50, 101, 104);
  let quit = false;
  const result = await waitForMacosExit(stable, { ...clock(),
    observe: async () => stable.observe(quit ? [unrelated] : [leader, watchdog, unrelated]),
    status: () => ({ exited: quit, expected: quit, engineExited: true }),
    quit: () => { stable.ownerQuit = true; quit = true; } });
  assert.equal(result.stopped, true);
});

test('macOS guard receipts validate distinct target and watchdog identities without forwarding arbitrary fields', () => {
  const raw = { schemaVersion: 1, groupPID: leader.pid, ...guardReady, secret: 'private' };
  assert.deepEqual(parseMacosLifecycle(raw, leader.pid), guardReady);
  for (const change of [{ id: 0 }, { id: 1000001 }, { guardPID: leader.pid }, { guardRootPID: 0 },
    { watchdogPID: 0 }, { watchdogPID: target.pid }, { guardRootPID: root.pid }, { watchdogPID: guard.pid }])
    assert.throws(() => parseMacosLifecycle({ ...raw, ...change }, leader.pid), /receipt/);
  assert.deepEqual(parseMacosLifecycle({ schemaVersion: 1, groupPID: leader.pid, ...registration }, leader.pid), registration);
  assert.throws(() => parseMacosLifecycle({ schemaVersion: 1, groupPID: leader.pid, ...registration, created: '' }, leader.pid), /receipt/);
});

test('macOS cancellation before the first gate may reconcile a vanished peer but never authorizes an escaped session', () => {
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, unrelated], true);
  ownership.guardEvent({ ...guardReady, event: 'guard-stopping', guardRootPID: 0, watchdogPID: 0 });
  ownership.guardEvent({ ...guardReady, event: 'guard-closed', guardRootPID: 0, watchdogPID: 0 });
  assert.equal(ownership.observe([leader, root, unrelated]).uncertain, false);
  const escaped = owner();
  assert.throws(() => escaped.registerGuard(registration, [leader, root, isolatedGuard, unrelated], true), /identity/);
  const reused = owner(), foreign = row(guard.pid, unrelated.pid, 2000, unrelated.pid, unrelated.pid);
  reused.registerGuard(registration, [leader, root, foreign, unrelated], true);
  reused.guardEvent({ ...guardReady, event: 'guard-stopping', guardRootPID: 0, watchdogPID: 0 });
  reused.guardEvent({ ...guardReady, event: 'guard-closed', guardRootPID: 0, watchdogPID: 0 });
  assert.equal(reused.observe([leader, root, foreign, unrelated]).uncertain, false);
});

test('macOS cancellation before target execution tracks the registered session even after the blocked target disappears', () => {
  const ownership = owner();
  ownership.registerGuard(registration, [leader, root, guard, unrelated]);
  ownership.authorizeGuard(1);
  ownership.activateGuard(guardReady, [leader, root, isolatedGuard, watcher, unrelated], true);
  ownership.guardEvent({ ...guardReady, event: 'guard-stopping' });
  ownership.guardEvent({ ...guardReady, event: 'guard-engine-exit', code: 143 });
  assert.deepEqual(ownership.guardQuits(), [1]);
  ownership.guardEvent({ ...guardReady, event: 'guard-closed' });
  assert.equal(ownership.observe([leader, root, unrelated]).uncertain, false);
  assert.throws(() => guarded().activateGuard(guardReady, [leader, root, unrelated], true), /transition/,
    'An executed target cannot be reclassified as an unexecuted cancellation');
});

test('macOS an unexpected registered guard disconnect remains a failure after watchdog cleanup', () => {
  const ownership = guarded();
  ownership.guardEvent({ ...guardReady, event: 'guard-closed' });
  assert.equal(ownership.observe([unrelated]).uncertain, true);
  assert.equal(ownership.ownershipFailure, 'guard-identity');
});
