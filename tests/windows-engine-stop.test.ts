import test from 'node:test';
import assert from 'node:assert/strict';

const modulePath = '../server/windows-engine-stop.mjs';
const { processSnapshot, ownedProcessTree, recordedTreeExited, stopWindowsEngineTree, parseWindowsEngineStopDiagnostic, windowsPowerShellEnvironment } = await import(modulePath);
type ProcessRow = { pid: number; parentPid: number; created: string };
const row = (pid: number, parentPid: number, order: number): ProcessRow => ({
  pid, parentPid, created: String(638900000000000000n + BigInt(order)),
});
const root = row(100, 50, 10), child = row(101, 100, 20), grandchild = row(102, 101, 30);
const tree = [root, child, grandchild];

test('CIM helper confines module discovery to Windows built-ins without modifying the engine environment', () => {
  const inherited = { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\user-modules', psMODULEpath: 'C:\\other-modules', TEMP: 'C:\\fixture-temp' };
  const before = { ...inherited };
  const scoped = windowsPowerShellEnvironment(inherited);
  assert.deepEqual(inherited, before);
  assert.deepEqual(Object.keys(scoped).filter(name => name.toUpperCase() === 'PSMODULEPATH'), ['PSModulePath']);
  assert.equal(scoped.PSModulePath.replaceAll('\\', '/'), 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules');
  assert.equal(scoped.TEMP, inherited.TEMP);
  assert.doesNotMatch(scoped.PSModulePath, /user-modules|other-modules/);
});

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

test('cold owned inventory borrows time within the unchanged total stop budget', async () => {
  let elapsed = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async (recorded: ProcessRow[] | undefined, timeout: number) => {
      assert.equal(recorded, undefined); assert.equal(timeout, 5800);
      elapsed += 2500; return tree;
    },
    kill: async (pid: number, timeout: number) => {
      assert.equal(pid, 100); assert.equal(timeout, 2200); kills++;
      elapsed += 75; return 0;
    },
    isRootRunning: () => true,
  });
  assert.deepEqual(result, { stopped: true, code: 0, proof: 'taskkill', recorded: 3 });
  assert.equal(kills, 1); assert.equal(elapsed, 2575);
});

test('cold inventory beyond the former phase cap still leaves a bounded successful cleanup', async () => {
  let elapsed = 0, kills = 0;
  const snapshotBudgets: number[] = [];
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async (_recorded: ProcessRow[] | undefined, timeout: number) => {
      snapshotBudgets.push(timeout); elapsed += 4000; return tree;
    },
    kill: async (pid: number, timeout: number) => {
      assert.equal(pid, 100); assert.equal(timeout, 1800); kills++;
      elapsed += 900; return 0;
    },
    isRootRunning: () => true,
  });
  assert.deepEqual(result, { stopped: true, code: 0, proof: 'taskkill', recorded: 3 });
  assert.deepEqual(snapshotBudgets, [5800]);
  assert.equal(kills, 1); assert.equal(elapsed, 4900);
});

test('inventory that uses the entire shared budget never starts cleanup or certifies late evidence', async () => {
  for (const duration of [5800, 5801]) {
    let elapsed = 0, reads = 0, kills = 0;
    const snapshotBudgets: number[] = [];
    const events: Record<string, unknown>[] = [];
    const result = await stopWindowsEngineTree(100, 50, {
      now: () => elapsed,
      snapshot: async (_recorded: ProcessRow[] | undefined, timeout: number) => {
        snapshotBudgets.push(timeout); reads++; elapsed += duration; return tree;
      },
      kill: async () => { kills++; return 0; },
      onDiagnostic: (event: Record<string, unknown>) => events.push(event),
    });
    assert.deepEqual(result, { stopped: false, code: null, proof: 'unproven', recorded: 0 });
    assert.deepEqual(snapshotBudgets, [5800]);
    assert.equal(reads, 1); assert.equal(kills, 0);
    assert(events.some(event => event.phase === 'before' && event.reason === 'timeout'));
  }
});

test('nonzero taskkill requires timely post-inventory using only the remaining shared budget', async () => {
  let elapsed = 0, reads = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async (recorded: ProcessRow[] | undefined, timeout: number) => {
      if (++reads === 1) { assert.equal(timeout, 5800); elapsed += 3100; return tree; }
      assert.deepEqual(recorded, tree); assert.equal(timeout, 600);
      elapsed += 599; return [];
    },
    kill: async (pid: number, timeout: number) => {
      assert.equal(pid, 100); assert.equal(timeout, 2200); kills++;
      elapsed += 2100; return 128;
    },
  });
  assert.deepEqual(result, { stopped: true, code: 128, proof: 'observed-exit', recorded: 3 });
  assert.equal(reads, 2); assert.equal(kills, 1); assert.equal(elapsed, 5799);
});

test('a late successful post-inventory cannot certify exit or reset the shared deadline', async () => {
  for (const postDuration of [600, 601, 1800]) {
    let elapsed = 0, reads = 0, kills = 0;
    const events: Record<string, unknown>[] = [];
    const result = await stopWindowsEngineTree(100, 50, {
      now: () => elapsed,
      snapshot: async (_recorded: ProcessRow[] | undefined, timeout: number) => {
        if (++reads === 1) { elapsed += 3100; return tree; }
        assert.equal(timeout, 600); elapsed += postDuration; return [];
      },
      kill: async () => { kills++; elapsed += 2100; return 128; },
      onDiagnostic: (event: Record<string, unknown>) => events.push(event),
    });
    assert.deepEqual(result, { stopped: false, code: 128, proof: 'unproven', recorded: 3 });
    assert.equal(reads, 2); assert.equal(kills, 1);
    assert(events.some(event => event.phase === 'after' && event.reason === 'timeout'));
  }
});

test('failed pre-inventory leaves exactly one remaining-budget cleanup that cannot prove exit', async () => {
  let elapsed = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async () => { elapsed += 5000; throw new Error('CIM unavailable'); },
    kill: async (pid: number, timeout: number) => {
      assert.equal(pid, 100); assert.equal(timeout, 800); assert(timeout > 0);
      kills++; elapsed += 40; return 0;
    },
  });
  assert.deepEqual(result, { stopped: false, code: 0, proof: 'unproven', recorded: 0 });
  assert.equal(kills, 1);
});

test('long cold inventory and nonzero taskkill still require timely complete exit evidence', async () => {
  let elapsed = 0, reads = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async (recorded: ProcessRow[] | undefined, timeout: number) => {
      if (++reads === 1) { assert.equal(timeout, 5800); elapsed += 4000; return tree; }
      assert.deepEqual(recorded, tree); assert.equal(timeout, 800); elapsed += 799; return [];
    },
    kill: async (pid: number, timeout: number) => {
      assert.equal(pid, 100); assert.equal(timeout, 1800); kills++;
      elapsed += 1000; return 128;
    },
  });
  assert.deepEqual(result, { stopped: true, code: 128, proof: 'observed-exit', recorded: 3 });
  assert.equal(reads, 2); assert.equal(kills, 1); assert.equal(elapsed, 5799);
});

test('taskkill uses only the budget left after a long inventory and rejects its boundary or late success', async () => {
  for (const duration of [799, 800, 801]) {
    let elapsed = 0, reads = 0, kills = 0;
    const result = await stopWindowsEngineTree(100, 50, {
      now: () => elapsed,
      snapshot: async () => { reads++; elapsed += 5000; return tree; },
      kill: async (pid: number, timeout: number) => {
        assert.equal(pid, 100); assert.equal(timeout, 800); kills++;
        elapsed += duration; return 0;
      },
    });
    assert.deepEqual(result, duration < 800
      ? { stopped: true, code: 0, proof: 'taskkill', recorded: 3 }
      : { stopped: false, code: null, proof: 'unproven', recorded: 3 });
    assert.equal(reads, 1); assert.equal(kills, 1);
  }
});

test('late taskkill success cannot become exit proof and never triggers another PID kill or query', async () => {
  let elapsed = 0, reads = 0, kills = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async () => { reads++; elapsed += 3000; return tree; },
    kill: async (_pid: number, timeout: number) => {
      assert.equal(timeout, 2200); kills++; elapsed += 2200; return 0;
    },
  });
  assert.deepEqual(result, { stopped: false, code: null, proof: 'unproven', recorded: 3 });
  assert.equal(reads, 1); assert.equal(kills, 1);
});

test('deadline exhaustion never launches a zero-timeout command or retargets a PID', async () => {
  for (const expiresBeforeKill of [true, false]) {
    let elapsed = 0, reads = 0, kills = 0;
    const result = await stopWindowsEngineTree(100, 50, {
      now: () => elapsed,
      snapshot: async (_recorded: ProcessRow[] | undefined, timeout: number) => {
        assert(timeout > 0); reads++; elapsed += 100; return tree;
      },
      kill: async (_pid: number, timeout: number) => {
        assert(timeout > 0); kills++; elapsed += 50; return 128;
      },
      onDiagnostic: (event: Record<string, unknown>) => {
        if (event.phase === (expiresBeforeKill ? 'before' : 'kill')) elapsed = 5800;
      },
    });
    assert.equal(result.stopped, false); assert.equal(result.proof, 'unproven');
    assert.equal(reads, 1); assert.equal(kills, expiresBeforeKill ? 0 : 1);
  }
});

test('time spent before the final verdict cannot certify an expired successful kill', async () => {
  let elapsed = 0;
  const result = await stopWindowsEngineTree(100, 50, {
    now: () => elapsed,
    snapshot: async () => tree,
    kill: async () => 0,
    onDiagnostic: (event: Record<string, unknown>) => { if (event.phase === 'kill') elapsed = 5800; },
  });
  assert.deepEqual(result, { stopped: false, code: 0, proof: 'unproven', recorded: 3 });
});
