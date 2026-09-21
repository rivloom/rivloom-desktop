import test from 'node:test';
import assert from 'node:assert/strict';

const modulePath = '../server/windows-engine-stop.mjs';
const { processSnapshot, ownedProcessTree, recordedTreeExited, stopWindowsEngineTree, parseWindowsEngineStopDiagnostic } = await import(modulePath);
type ProcessRow = { pid: number; parentPid: number; created: string };
const row = (pid: number, parentPid: number, order: number): ProcessRow => ({
  pid, parentPid, created: String(638900000000000000n + BigInt(order)),
});
const root = row(100, 50, 10), child = row(101, 100, 20), grandchild = row(102, 101, 30);
const tree = [root, child, grandchild];

test('Windows owned inventory includes descendants but excludes unrelated and reused-parent processes', () => {
  assert.deepEqual(ownedProcessTree([grandchild, row(999, 1, 1), row(103, 100, 5), child, root], 100, 50), tree);
  assert.throws(() => ownedProcessTree([root], 100, 999), /identity/);
  assert.throws(() => ownedProcessTree([], 100, 50), /identity/);
});

test('Windows exit proof rejects missing identities, duplicate PIDs and empty pre-kill evidence', () => {
  assert.throws(() => processSnapshot([{ ...root, created: '' }]), /identity/);
  assert.throws(() => processSnapshot([{ ...root, created: 638900000000000000 }]), /identity/);
  assert.throws(() => processSnapshot([root, root]), /identity/);
  assert.throws(() => recordedTreeExited([], []), /empty/);
  assert.throws(() => ownedProcessTree([root, { ...child, created: '' }], 100, 50), /identity/);
});

test('Windows exit proof requires every recorded descendant to exit, even after its root disappears', () => {
  assert.equal(recordedTreeExited(tree, [root]), false);
  assert.equal(recordedTreeExited(tree, [grandchild]), false);
  assert.equal(recordedTreeExited(tree, []), true);
  assert.equal(recordedTreeExited(tree, [row(900, 800, 100)]), true);
});

test('Windows PID reuse is distinguished by creation time and never becomes a kill target', () => {
  assert.equal(recordedTreeExited(tree, [row(root.pid, 80, 100)]), true);
  assert.equal(recordedTreeExited(tree, [row(root.pid, 80, 1)]), false);
  assert.equal(recordedTreeExited(tree, [row(105, child.pid, 100)]), false);
});

test('nonzero taskkill succeeds only with complete pre-kill and post-kill owned exit evidence', async () => {
  const requested: number[] = [];
  let reads = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => ++reads === 1 ? tree : [],
    kill: async (pid: number) => { requested.push(pid); return 128; },
  });
  assert.deepEqual(result, { stopped: true, code: 128, proof: 'observed-exit', recorded: 3 });
  assert.deepEqual(requested, [100]);
  assert.equal(reads, 2);
});

test('nonzero taskkill does not accept a surviving child or a failed post-kill query', async () => {
  for (const after of [async () => [grandchild], async () => { throw new Error('CIM unavailable'); }]) {
    let reads = 0;
    const result = await stopWindowsEngineTree(100, 50, {
      snapshot: async () => ++reads === 1 ? tree : after(), kill: async () => 128,
    });
    assert.equal(result.stopped, false);
    assert.equal(result.proof, 'unproven');
  }
});

test('failed pre-kill inventory still requests owned cleanup but cannot certify success', async () => {
  let kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => { throw new Error('CIM denied'); },
    kill: async (pid: number) => { assert.equal(pid, 100); kills++; return 0; },
  });
  assert.equal(kills, 1);
  assert.equal(result.stopped, false);
});

test('taskkill timeout is not accepted as either successful termination or observed exit', async () => {
  let reads = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => { reads++; return tree; }, kill: async () => null,
  });
  assert.equal(result.stopped, false);
  assert.equal(reads, 1);
});

test('an engine that exits during the pre-kill query is never targeted by a possibly reused PID', async () => {
  let kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => tree, isRootRunning: () => false,
    kill: async () => { kills++; return 0; },
  });
  assert.equal(kills, 0);
  assert.equal(result.stopped, false);
});

test('stop diagnostics distinguish inventory and taskkill timeouts without exposing raw errors', async () => {
  const events: Record<string, unknown>[] = [];
  const secretError = Object.assign(new Error('secret command line and credential'), { code: 'ETIMEDOUT', killed: true, path: 'secret-path' });
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => { throw secretError; },
    kill: async () => { throw secretError; },
    onDiagnostic: (event: Record<string, unknown>) => events.push(event),
  });
  assert.deepEqual(result, { stopped: false, code: null, proof: 'unproven', recorded: 0 });
  assert.deepEqual(events.map(({ phase, outcome, reason }) => ({ phase, outcome, reason })), [
    { phase: 'before', outcome: 'failed', reason: 'timeout' },
    { phase: 'kill', outcome: 'failed', reason: 'timeout' },
    { phase: 'result', outcome: 'failed', reason: undefined },
  ]);
  for (const event of events) {
    assert.equal(Number.isSafeInteger(event.durationMs), true);
    assert.deepEqual(parseWindowsEngineStopDiagnostic(`RIVLOOM_ENGINE_STOP ${JSON.stringify(event)}`), event);
  }
  assert.doesNotMatch(JSON.stringify(events), /secret|credential|path|\bpid\b/i);
});

test('diagnostic failures cannot change cleanup proof or repeat a kill request', async () => {
  let reads = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    snapshot: async () => ++reads === 1 ? tree : [],
    kill: async () => { kills++; return 128; },
    onDiagnostic: () => { throw new Error('diagnostic sink unavailable'); },
  });
  assert.deepEqual(result, { stopped: true, code: 128, proof: 'observed-exit', recorded: 3 });
  assert.equal(kills, 1);
});

test('diagnostic parser forwards only bounded allowlisted fields', () => {
  const safe = { phase: 'before', outcome: 'failed', durationMs: 1802, reason: 'timeout' };
  assert.deepEqual(parseWindowsEngineStopDiagnostic(`RIVLOOM_ENGINE_STOP ${JSON.stringify({ ...safe, path: 'private', command: 'secret', pid: 999 })}`), safe);
  for (const value of [
    { ...safe, phase: 'private/path' }, { ...safe, outcome: 'private' }, { ...safe, reason: 'secret' },
    { ...safe, durationMs: -1 }, { ...safe, code: 'ETIMEDOUT' }, { ...safe, recorded: -1 },
    { ...safe, proof: 'private' }, { ...safe, padding: 'x'.repeat(768) },
  ]) assert.equal(parseWindowsEngineStopDiagnostic(`RIVLOOM_ENGINE_STOP ${JSON.stringify(value)}`), undefined);
  assert.equal(parseWindowsEngineStopDiagnostic('unrelated engine stderr'), undefined);
  assert.equal(parseWindowsEngineStopDiagnostic('RIVLOOM_ENGINE_STOP invalid JSON'), undefined);
});
