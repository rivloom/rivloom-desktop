import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RemoteTaskStore,
  validRemoteTaskOffer,
  validRemoteTaskResponse,
  validRemoteTaskExecution,
  validRemoteTaskPreparation,
} from '../server/remote-tasks.ts';

const now = Date.parse('2026-09-02T04:00:00Z');
const iso = (at: number) => new Date(at).toISOString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-clock-test-'));
  const owner = new RemoteTaskStore(join(root, 'master'));
  const worker = new RemoteTaskStore(join(root, 'worker'));
  const brainID = randomUUID();
  const task = owner.create('A'.repeat(32), brainID, 'B'.repeat(32), brainID, {
    title: 'Clock skew regression',
    description: 'No engine or tools are started by this store test.',
    criteria: 'Bounded skew works without reviving invalid executions.',
    brainTaskID: randomUUID(),
  });
  const offer = owner.message(task.id);
  assert(validRemoteTaskOffer(offer));
  worker.receiveOffer(offer);
  owner.markDelivered(task.id, offer);
  return { root, owner, worker, task };
}

for (const offset of [-60_000, -5000, -50, 0, 50, 5000, 60_000]) {
  test(`remote task clock skew ${offset} ms accepts replies and ordered execution`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const { root, owner, worker, task } = fixture();
    try {
      t.mock.timers.setTime(now + offset);
      worker.decide(task.id, 'accepted');
      const response = worker.message(task.id);
      t.mock.timers.setTime(now);
      assert(validRemoteTaskResponse(response));
      assert.equal(owner.receiveResponse(response), true);
      assert.equal(owner.receiveResponse(response), false);
      assert(worker.markDelivered(task.id, response));

      t.mock.timers.setTime(now + offset);
      worker.bindLocalTask(task.id, randomUUID());
      const execution = worker.message(task.id);
      t.mock.timers.setTime(now);
      assert(validRemoteTaskExecution(execution));
      assert.equal(owner.receiveExecution(execution), true);
      assert.equal(owner.receiveExecution(execution), false);
      assert.equal(owner.receiveExecution({ ...execution, sequence: 2, state: 'running' }), true);
      assert.equal(owner.receiveExecution(execution), false, 'old sequence stays fenced');
      assert.throws(
        () => owner.receiveExecution({ ...execution, sequence: 2, state: 'failed' }),
        /序号冲突/,
      );
      assert.throws(
        () => owner.receiveExecution({ ...execution, sequence: 3, statusAt: iso(now - 60_001) }),
        /时间无效/,
      );
      const reloaded = new RemoteTaskStore(join(root, 'master'));
      reloaded.load();
      assert.equal(reloaded.record(task.id)?.status, 'accepted');
      assert.equal(reloaded.record(task.id)?.executionSequence, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('remote task clock skew also permits bounded declines and legacy preparation', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const decision of ['accepted', 'declined'] as const) {
    const { root, owner, worker, task } = fixture();
    try {
      t.mock.timers.setTime(now - 5000);
      worker.decide(task.id, decision);
      const response = worker.message(task.id);
      t.mock.timers.setTime(now);
      assert(validRemoteTaskResponse(response));
      assert(owner.receiveResponse(response));
      assert(worker.markDelivered(task.id, response));
      if (decision === 'accepted') {
        t.mock.timers.setTime(now - 5000);
        worker.prepare(task.id, randomUUID(), 'fixture/m34');
        const preparation = worker.message(task.id);
        t.mock.timers.setTime(now);
        assert(validRemoteTaskPreparation(preparation));
        assert(owner.receivePreparation(preparation));
        assert.equal(owner.receivePreparation(preparation), false);
        assert.throws(
          () => owner.receivePreparation({ ...preparation, statusAt: iso(now - 60_001) }),
          /时间无效/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('remote task clock skew rejects invalid times, routes and idempotency keys', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const { root, owner, worker, task } = fixture();
  try {
    worker.decide(task.id, 'accepted');
    const response = worker.message(task.id);
    assert(validRemoteTaskResponse(response));
    for (const decidedAt of [iso(now - 60_001), iso(now + 60_001), 'not-a-date']) {
      assert.throws(() => owner.receiveResponse({ ...response, decidedAt }), /时间无效/);
      assert.equal(owner.record(task.id)?.status, 'pending');
    }
    for (const field of ['taskID', 'idempotencyKey', 'ownerBrainID', 'targetBrainID'] as const)
      assert.throws(() => owner.receiveResponse({ ...response, [field]: randomUUID() }), /不匹配/);
    for (const field of ['ownerNodeID', 'targetNodeID'] as const)
      assert.throws(
        () => owner.receiveResponse({ ...response, [field]: 'C'.repeat(32) }),
        /不匹配/,
      );
    assert(owner.receiveResponse(response));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote task clock skew never revives cancelled, declined or expired executions', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const invalidatedBy of ['cancel', 'decline', 'expire', 'deadline-without-tick']) {
    t.mock.timers.setTime(now);
    const { root, owner, worker, task } = fixture();
    try {
      t.mock.timers.setTime(now - 50);
      worker.decide(task.id, 'accepted');
      const response = worker.message(task.id);
      t.mock.timers.setTime(now);
      assert(validRemoteTaskResponse(response));
      if (invalidatedBy === 'cancel') owner.cancel(task.id);
      else if (invalidatedBy === 'decline')
        owner.receiveResponse({ ...response, decision: 'declined', decidedAt: iso(now) });
      else {
        t.mock.timers.setTime(Date.parse(task.expiresAt));
        if (invalidatedBy === 'expire') owner.expire();
      }
      assert.throws(() => owner.receiveResponse(response), /失效|过期/);
      assert.notEqual(owner.record(task.id)?.status, 'accepted');
      worker.markDeliveryFailed(task.id, 'Master rejected the obsolete execution');
      assert.throws(() => worker.bindLocalTask(task.id, randomUUID()), /尚未完成同步/);
      assert.equal(worker.record(task.id)?.localTaskID, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('accepted execution retries remain idempotent after the invitation deadline', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const { root, owner, worker, task } = fixture();
  try {
    worker.decide(task.id, 'accepted');
    const response = worker.message(task.id);
    assert(validRemoteTaskResponse(response));
    assert(owner.receiveResponse(response));
    t.mock.timers.setTime(Date.parse(task.expiresAt) + 1);
    assert.equal(owner.receiveResponse(response), false);
    assert.equal(owner.record(task.id)?.status, 'accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
