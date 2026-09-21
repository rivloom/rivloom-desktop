import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { WorkerAdmissionGate } from '../server/worker-admission.ts';
import { queueFixture, localSource, remoteSource } from './node-queue-fixture.ts';

test('local waiting and held entries can be cancelled while paused, atomically and durably', () => {
  for (const held of [false, true]) {
    const f = queueFixture();
    try {
      const source = localSource();
      let entry = f.store.enqueue(source);
      if (held) entry = f.store.control({ operationID: randomUUID(), itemID: entry.id,
        expectedVersion: entry.version, action: 'hold' }).entry!;
      f.store.setPaused({ operationID: randomUUID(), expectedVersion: f.store.snapshot().version, paused: true });
      const command = { operationID: randomUUID(), itemID: entry.id, expectedVersion: entry.version, action: 'cancel' as const };
      f.db.exec('CREATE TABLE cancellation_effect (id TEXT)');
      assert.throws(() => f.store.control(command, () => {
        f.db.prepare('INSERT INTO cancellation_effect VALUES (?)').run(entry.id);
        throw new Error('Task changed');
      }), /Task changed/);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM cancellation_effect').get()!.n, 0);
      assert.equal(f.store.get(entry.id)!.state, held ? 'held' : 'waiting');
      let ends = 0;
      const result = f.store.control(command, () => { ends++; });
      assert.equal(result.entry!.state, 'ended');
      assert.equal(result.entry!.endReason!.code, 'cancelled');
      assert.deepEqual(f.reopen().control(command, () => { ends++; }), result);
      assert.equal(ends, 1);
      assert.equal(f.store.enqueue(source).state, 'ended');
      assert.throws(() => f.store.admit(entry.id, result.entry!.version, entry.localTaskID!), /准入/);
      const remote = f.store.enqueue(remoteSource());
      assert.throws(() => f.store.control({ ...command, operationID: randomUUID(), itemID: remote.id,
        expectedVersion: remote.version }), /locally originated/);
    } finally { f.close(); }
  }
});

test('cancellation racing with admission cannot stop an already admitted execution', async () => {
  for (const cancelFirst of [true, false]) {
    const f = queueFixture();
    try {
      const gate = new WorkerAdmissionGate(), entry = f.store.enqueue(localSource());
      let ends = 0;
      const cancel = () => gate.run(async () => f.store.control({ operationID: randomUUID(),
        itemID: entry.id, expectedVersion: entry.version, action: 'cancel' }, () => { ends++; }));
      const admit = () => gate.run(async () => f.store.admit(entry.id, entry.version, entry.localTaskID!));
      const results = await Promise.allSettled(cancelFirst ? [cancel(), admit()] : [admit(), cancel()]);
      assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
      assert.equal(ends, cancelFirst ? 1 : 0);
      assert.equal(f.store.get(entry.id)!.state, cancelFirst ? 'ended' : 'admitted');
    } finally { f.close(); }
  }
});

test('reorder changes authoritative order, fences stale neighbors and survives restart', () => {
  const f = queueFixture();
  try {
    const a = f.store.enqueue(localSource());
    const b = f.store.enqueue(remoteSource());
    const c = f.store.enqueue(localSource());
    const command = {
      operationID: randomUUID(),
      itemID: c.id,
      expectedVersion: c.version,
      expectedQueueVersion: f.store.snapshot().version,
      action: 'up' as const,
    };
    const result = f.store.control(command);
    assert.deepEqual(
      f.store.list().map((e) => e.id),
      [a.id, c.id, b.id],
    );
    assert.deepEqual(f.reopen().control(command), result);
    assert.throws(
      () =>
        f.store.control({
          ...command,
          operationID: randomUUID(),
          itemID: a.id,
          expectedVersion: a.version,
        }),
      /顺序/,
    );
    assert.throws(() => f.store.control({ ...command, action: 'hold' }), /不同/);
  } finally {
    f.close();
  }
});

test('held work resumes once, rejection is durable and cannot be revived by stale controls', () => {
  const f = queueFixture();
  try {
    const source = remoteSource();
    const entry = f.store.enqueue(source);
    const held = f.store.control({
      operationID: randomUUID(),
      itemID: entry.id,
      expectedVersion: entry.version,
      action: 'hold',
    }).entry!;
    const resumed = f.store.control({
      operationID: randomUUID(),
      itemID: entry.id,
      expectedVersion: held.version,
      action: 'resume',
    }).entry!;
    const command = {
      operationID: randomUUID(),
      itemID: entry.id,
      expectedVersion: resumed.version,
      action: 'reject' as const,
      reason: '接收端不再执行这项工作',
    };
    const ended = f.store.control(command);
    assert.deepEqual(f.reopen().control(command), ended);
    assert.equal(f.store.enqueue(source).state, 'ended');
    assert.throws(
      () =>
        f.store.control({
          operationID: randomUUID(),
          itemID: entry.id,
          expectedVersion: ended.entry!.version,
          action: 'resume',
        }),
      /变化/,
    );
    assert.throws(() => f.store.admit(entry.id, ended.entry!.version, randomUUID()), /准入/);
    assert.throws(() => f.store.restoreAdmission(entry.id, randomUUID()), /终态/);
  } finally {
    f.close();
  }
});

test('pause prevents new admission but does not revoke a committed slot', () => {
  const f = queueFixture();
  try {
    const a = f.store.enqueue(localSource());
    const b = f.store.enqueue(remoteSource());
    const admitted = f.store.admit(a.id, a.version, a.localTaskID!);
    const operation = {
      operationID: randomUUID(),
      expectedVersion: f.store.snapshot().version,
      paused: true,
    };
    const result = f.store.setPaused(operation);
    assert.deepEqual(f.reopen().setPaused(operation), result);
    assert.throws(() => f.store.admit(b.id, b.version, randomUUID()), /准入/);
    assert.equal(f.store.markStarting(admitted.id).admissionPhase, 'starting');
    assert.deepEqual(
      f.store.snapshot().entries.map((e) => e.position),
      [null, null],
    );
  } finally {
    f.close();
  }
});

test('control and final admission racing through the same gate have exactly one legal winner', async () => {
  for (const controlFirst of [true, false]) {
    const f = queueFixture();
    try {
      const gate = new WorkerAdmissionGate();
      const entry = f.store.enqueue(remoteSource());
      const control = () =>
        gate.run(async () =>
          f.store.control({
            operationID: randomUUID(),
            itemID: entry.id,
            expectedVersion: entry.version,
            action: 'reject',
            reason: 'owner rejects before execution',
          }),
        );
      const admission = () =>
        gate.run(async () => f.store.admit(entry.id, entry.version, randomUUID()));
      const results = await Promise.allSettled(
        controlFirst ? [control(), admission()] : [admission(), control()],
      );
      assert.deepEqual(
        results.map((result) => result.status),
        ['fulfilled', 'rejected'],
      );
      assert.equal(f.store.get(entry.id)?.state, controlFirst ? 'ended' : 'admitted');
    } finally {
      f.close();
    }
  }
});
