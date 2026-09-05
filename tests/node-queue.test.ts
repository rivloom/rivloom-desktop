import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { queueFixture, localSource, remoteSource } from './node-queue-fixture.ts';

test('mixed sources use receiver sequence, and repeated intake preserves order and terminal rows', () => {
  const f = queueFixture();
  try {
    const a = f.store.enqueue(localSource());
    f.advance(-600_000); // Receiver clock changes cannot reorder its sequence.
    const source = remoteSource();
    const b = f.store.enqueue(source);
    const c = f.store.enqueue(localSource());
    assert.deepEqual(
      f.store.list().map((e) => e.id),
      [a.id, b.id, c.id],
    );
    assert.deepEqual(
      f.store.snapshot().entries.map((e) => e.position),
      [1, 2, 3],
    );
    assert.deepEqual(f.store.enqueue(source), b);
    f.store.end(b.id, { code: 'cancelled' });
    assert.equal(f.store.enqueue(source).state, 'ended');
    assert.equal(f.store.list().length, 3);
    assert.deepEqual(
      f
        .reopen()
        .list()
        .map((e) => e.id),
      [a.id, b.id, c.id],
    );
  } finally {
    f.close();
  }
});

test('queue source binding cannot cross Node or Brain, even with the same remote ID', () => {
  const f = queueFixture();
  try {
    const source = remoteSource();
    if (source.kind !== 'remote') throw new Error('fixture');
    f.store.enqueue(source);
    assert.throws(() => f.store.enqueue({ ...source, ownerNodeID: 'b'.repeat(32) }), /归属/);
    assert.throws(() => f.store.enqueue({ ...source, ownerBrainID: randomUUID() }), /归属/);
  } finally {
    f.close();
  }
});

test('blocked and held work has no claimed candidate position while preserving original order', () => {
  const f = queueFixture();
  try {
    const a = f.store.enqueue(localSource());
    const b = f.store.enqueue(remoteSource());
    const c = f.store.enqueue(localSource());
    f.store.setBlockReason(a.id, { code: 'model_unavailable' });
    f.store.control({
      operationID: randomUUID(),
      itemID: b.id,
      expectedVersion: b.version,
      action: 'hold',
    });
    assert.deepEqual(
      f.store.snapshot().entries.map((e) => e.position),
      [null, null, 1],
    );
    const before = f.store.snapshot().version;
    f.store.setBlockReason(a.id, { code: 'model_unavailable' });
    assert.equal(f.store.snapshot().version, before);
    f.store.setBlockReason(a.id, { code: 'slot' });
    assert.deepEqual(
      f.store.snapshot().entries.map((e) => e.position),
      [1, null, 2],
    );
    assert.equal(f.store.get(c.id)?.order, 3);
  } finally {
    f.close();
  }
});

test('source creation and queue insertion commit together and rollback together', () => {
  const f = queueFixture();
  try {
    f.db.exec('CREATE TABLE test_tasks(id TEXT PRIMARY KEY)');
    const source = localSource();
    if (source.kind !== 'local') throw new Error('fixture');
    assert.throws(
      () =>
        f.store.enqueue(source, () => {
          f.db.prepare('INSERT INTO test_tasks VALUES(?)').run(source.taskID);
          throw new Error('crash before queue row');
        }),
      /crash/,
    );
    assert.equal(f.store.list().length, 0);
    assert.equal(f.db.prepare('SELECT * FROM test_tasks').all().length, 0);
    f.store.enqueue(source, () =>
      f.db.prepare('INSERT INTO test_tasks VALUES(?)').run(source.taskID),
    );
    assert.equal(f.reopen().list().length, 1);
    assert.equal(f.db.prepare('SELECT * FROM test_tasks').all().length, 1);
  } finally {
    f.close();
  }
});
