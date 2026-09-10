import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { nodeQueueRecoveryDecision, canReleaseUnboundReservation } from '../server/node-queue.ts';
import { queueFixture, localSource, remoteSource } from './node-queue-fixture.ts';

test('offer intent, acceptance, admission and binding gaps preserve one Task ID', () => {
  const f = queueFixture();
  try {
    const source = remoteSource();
    const queued = f.store.enqueue(source); // Persisted offer is authoritative, independent of SQLite.
    assert.equal(f.reopen().enqueue(source).id, queued.id);
    const allocatedID = randomUUID();
    const reserved = f.store.admit(queued.id, queued.version, allocatedID);
    assert.equal(
      nodeQueueRecoveryDecision(reserved, { source: 'live', task: null }).action,
      'resume_binding',
    );
    f.reopen();
    assert.equal(f.store.get(queued.id)?.localTaskID, allocatedID);
    f.db.exec('CREATE TABLE test_tasks(id TEXT PRIMARY KEY)');
    assert.throws(
      () =>
        f.store.bindTask(queued.id, allocatedID, () => {
          f.db.prepare('INSERT INTO test_tasks VALUES(?)').run(allocatedID);
          throw new Error('binding crash');
        }),
      /crash/,
    );
    assert.equal(f.db.prepare('SELECT * FROM test_tasks').all().length, 0);
    assert.equal(f.store.get(queued.id)?.admissionPhase, 'reserved');
    f.store.bindTask(queued.id, allocatedID, () =>
      f.db.prepare('INSERT INTO test_tasks VALUES(?)').run(allocatedID),
    );
    const recovered = f.reopen().get(queued.id)!;
    assert.equal(recovered.admissionPhase, 'bound');
    assert.equal(
      nodeQueueRecoveryDecision(recovered, {
        source: 'live',
        task: { id: allocatedID, state: 'ready', sessionID: null },
      }).action,
      'dispatch',
    );
    let duplicateCreation = false;
    f.store.bindTask(queued.id, allocatedID, () => {
      duplicateCreation = true;
    });
    assert.equal(duplicateCreation, false);
  } finally {
    f.close();
  }
});

test('crash around session.create remains uncertain, never creates a second session', () => {
  for (const sessionID of [null, 'ses_created_before_crash']) {
    const f = queueFixture();
    try {
      const q = f.store.enqueue(localSource());
      f.store.admit(q.id, q.version, q.localTaskID!);
      f.store.markStarting(q.id);
      const recovered = f.reopen().get(q.id)!;
      assert.equal(
        nodeQueueRecoveryDecision(recovered, {
          source: 'live',
          task: { id: q.localTaskID!, state: 'ready', sessionID },
        }).action,
        'interrupt',
      );
      assert.throws(() => f.store.markStarting(q.id), /重复/);
      assert.equal(recovered.state, 'admitted');
    } finally {
      f.close();
    }
  }
});

test('review, interrupted and started-but-missing execution retain their reservation', () => {
  const f = queueFixture();
  try {
    const q = f.store.enqueue(localSource());
    f.store.admit(q.id, q.version, q.localTaskID!);
    f.store.markStarting(q.id);
    const started = f.store.markStarted(q.id);
    for (const state of [
      'running',
      'review',
      'interrupted',
      'waiting_approval',
      'waiting_input',
      'failed',
    ])
      assert.equal(
        nodeQueueRecoveryDecision(started, {
          source: 'live',
          task: { id: q.localTaskID!, state, sessionID: 'ses_existing' },
        }).action,
        'retain_execution',
      );
    assert.equal(
      nodeQueueRecoveryDecision(started, { source: 'live', task: null }).action,
      'interrupt',
    );
    assert.equal(
      nodeQueueRecoveryDecision(started, { source: 'terminal', task: null }).action,
      'interrupt',
    );
  } finally {
    f.close();
  }
});

test('only a finished read-only planner format failure ends its queue record', () => {
  const f = queueFixture();
  try {
    const q = f.store.enqueue(localSource()); f.store.admit(q.id, q.version, q.localTaskID!); f.store.markStarting(q.id);
    const started = f.store.markStarted(q.id);
    const task = { id: q.localTaskID!, state: 'failed', sessionID: 'ses_existing', error: 'workflow_invalid_outcome', collaboration: { role: 'planner' } };
    assert.deepEqual(nodeQueueRecoveryDecision(started, { source: 'live', task }), { action: 'end', reason: { code: 'failed' } });
    for (const patch of [{ state: 'running' }, { state: 'interrupted' }, { error: 'engine_unknown' }, { collaboration: { role: 'executor' } }, { collaboration: undefined }])
      assert.equal(nodeQueueRecoveryDecision(started, { source: 'live', task: { ...task, ...patch } }).action, 'retain_execution');
  } finally { f.close(); }
});

test('cancelled, expired and revoked waiting records end; accepted scans cannot resurrect them', () => {
  for (const code of ['cancelled', 'expired', 'trust_revoked'] as const) {
    const f = queueFixture();
    try {
      const source = remoteSource();
      const q = f.store.enqueue(source);
      const decision = nodeQueueRecoveryDecision(q, {
        source: 'terminal',
        task: null,
        endReason: { code },
      });
      assert.equal(decision.action, 'end');
      if (decision.action !== 'end') throw new Error('unexpected recovery');
      f.store.end(q.id, decision.reason);
      const recovered = f.reopen().enqueue(source);
      assert.equal(recovered.state, 'ended');
      assert.equal(
        nodeQueueRecoveryDecision(recovered, { source: 'live', task: null }).action,
        'none',
      );
    } finally {
      f.close();
    }
  }
});

test('confirmed stop closes local and remote reservations across restart without replay', () => {
  for (const source of [localSource(), remoteSource()]) for (const phase of ['bound', 'starting', 'started']) {
    const f = queueFixture();
    try {
      const queued = f.store.enqueue(source);
      const taskID = queued.localTaskID || randomUUID();
      f.store.admit(queued.id, queued.version, taskID); f.store.bindTask(queued.id, taskID);
      if (phase !== 'bound') f.store.markStarting(queued.id);
      if (phase === 'started') f.store.markStarted(queued.id);
      const restored = f.reopen().get(queued.id)!;
      const facts = { source: 'live' as const, task: { id: taskID, state: 'stopped', sessionID: 'ses_original' } };
      assert.equal(nodeQueueRecoveryDecision(restored, { ...facts, task: { ...facts.task, id: randomUUID() } }).action, 'interrupt');
      const decision = nodeQueueRecoveryDecision(restored, facts);
      assert.deepEqual(decision, { action: 'end', reason: { code: 'stopped' } });
      if (decision.action !== 'end') throw new Error('Expected confirmed stop');
      f.store.end(queued.id, decision.reason);
      const ended = f.reopen().enqueue(source);
      assert.equal(ended.id, queued.id); assert.equal(ended.localTaskID, taskID);
      assert.equal(ended.state, 'ended'); assert.equal(ended.endReason?.code, 'stopped');
      assert.deepEqual(nodeQueueRecoveryDecision(ended, facts), { action: 'none' });
      assert.deepEqual(nodeQueueRecoveryDecision(ended, { ...facts, task: { ...facts.task, state: 'running' } }), { action: 'none' });
      assert.equal(f.store.snapshot().entries.filter((entry) => entry.state !== 'ended').length, 0);
    } finally { f.close(); }
  }
});

test('startup schema migration does not import legacy ready Tasks into automatic queue', () => {
  const f = queueFixture();
  try {
    f.db.exec('CREATE TABLE legacy_tasks(id TEXT PRIMARY KEY,state TEXT)');
    f.db.prepare('INSERT INTO legacy_tasks VALUES(?,?)').run(randomUUID(), 'ready');
    assert.equal(f.reopen().snapshot().entries.length, 0);
  } finally {
    f.close();
  }
});

test('Master cancellation releases only a provably unbound reservation after lost acceptance ACK', () => {
  const f = queueFixture();
  try {
    const q = f.store.enqueue(remoteSource());
    const allocatedID = randomUUID();
    const reserved = f.store.admit(q.id, q.version, allocatedID);
    f.reopen();
    const noExecution = { localTaskExists: false, remoteLocalTaskID: null, executionSequence: 0 };
    assert.equal(canReleaseUnboundReservation(reserved, noExecution), true);
    assert.equal(
      canReleaseUnboundReservation(reserved, { ...noExecution, executionSequence: 1 }),
      false,
    );
    assert.equal(
      canReleaseUnboundReservation(reserved, { ...noExecution, localTaskExists: true }),
      false,
    );
    const ended = f.store.end(q.id, { code: 'expired' });
    assert.equal(ended.state, 'ended');
    assert.throws(() => f.store.restoreAdmission(q.id, allocatedID), /终态/);
    const another = f.store.enqueue(remoteSource());
    f.store.admit(another.id, another.version, randomUUID());
    f.store.bindTask(another.id, f.store.get(another.id)!.localTaskID!);
    const starting = f.store.markStarting(another.id);
    assert.equal(canReleaseUnboundReservation(starting, noExecution), false);
    assert.throws(() => f.store.end(another.id, { code: 'cancelled' }), /状态未知/);
  } finally {
    f.close();
  }
});
