import test from 'node:test';
import assert from 'node:assert/strict';
import { MacosProcessOwnership, macosProcessSnapshot, parseMacosLifecycle, waitForMacosExit,
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
