import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { CreationRequestStore } from '../server/creation-requests.ts';
import { RemoteTaskStore } from '../server/remote-tasks.ts';
import { BrainTaskStore } from '../server/brain-tasks.ts';
import { nodeQueueBacklog, validQueueConfirmation } from '../shared/queue-backlog.ts';
import {
  requireQueueConfirmation,
  QueueConfirmationRequired,
} from '../server/queue-confirmation.ts';
import type { RivloomNode } from '../shared/types.ts';

const owner = 'A'.repeat(32);
const target = 'B'.repeat(32);
const content = {
  title: '工作',
  description: '相同的一项工作',
  criteria: '检查结果',
  requirements: {},
};

test('queue reminder counts waiting and reserved work, requires fresh facts and binds confirmation to the target', () => {
  const now = Date.now();
  const node = {
    online: true,
    channelReady: true,
    nodeQueue: {
      sampledAt: new Date(now).toISOString(),
      waitingCount: 9,
      workload: { occupiedSlots: 1, totalSlots: 1, executingCount: 0 },
    },
    worker: null,
  } as RivloomNode;
  assert.equal(nodeQueueBacklog(node, now), 10);
  assert.equal(nodeQueueBacklog(node, now + 30000), null);
  assert.equal(nodeQueueBacklog({ ...node, online: false }, now), null);
  assert.equal(nodeQueueBacklog({ ...node, channelReady: false }, now), null);
  assert.equal(nodeQueueBacklog(node, now - 1001), null);
  assert.doesNotThrow(() => requireQueueConfirmation(target, 'Target', 9));
  assert.doesNotThrow(() => requireQueueConfirmation(target, 'Target', null));
  for (const confirmedFor of [undefined, owner])
    assert.throws(
      () => requireQueueConfirmation(target, 'Target', 10, confirmedFor),
      (error: unknown) =>
        error instanceof QueueConfirmationRequired &&
        error.status === 409 &&
        validQueueConfirmation(error.queueConfirmation) &&
        error.queueConfirmation.count === 10,
    );
  assert.doesNotThrow(() => requireQueueConfirmation(target, 'Target', 100, target));
  assert(!validQueueConfirmation({ nodeID: target, name: 'Target', count: '10', threshold: 10 }));
});

test('queue confirmation keeps the original creation identity across cancellation, confirmation and retry', () => {
  const db = new DatabaseSync(':memory:');
  const requests = new CreationRequestStore(db);
  const requestID = randomUUID();
  const logical = { routing: { kind: 'node', nodeID: target }, ...content };
  const original = requests.reserve(owner, requestID, logical);
  assert.throws(() => requireQueueConfirmation(target, 'Target', 10), QueueConfirmationRequired);
  // Cancellation creates no invite; the same logical submission remains retryable.
  assert.equal(requests.reserve(owner, requestID, logical), original);
  requireQueueConfirmation(target, 'Target', 11, target);
  assert.equal(requests.reserve(owner, requestID, logical), original);
  assert.throws(
    () => requireQueueConfirmation('C'.repeat(32), 'Other target', 12, target),
    QueueConfirmationRequired,
  );
  db.close();
});

test('HTTP creation retry preserves task ID across restart and rejects changed target/content', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-create-'));
  const path = join(root, 'requests.sqlite');
  const requestID = randomUUID();
  let db = new DatabaseSync(path);
  let requests = new CreationRequestStore(db);
  const logical = { routing: { kind: 'node', nodeID: target }, ...content };
  const taskID = requests.reserve(owner, requestID, logical);
  assert.equal(
    requests.reserve(owner, requestID, { ...content, routing: logical.routing }),
    taskID,
  );
  assert.throws(
    () => requests.reserve(owner, requestID, { ...logical, title: '另一项工作' }),
    /冲突/,
  );
  assert.throws(
    () => requests.reserve(owner, requestID, { ...logical, routing: { kind: 'local' } }),
    /冲突/,
  );
  db.close();
  db = new DatabaseSync(path);
  requests = new CreationRequestStore(db);
  assert.equal(requests.reserve(owner, requestID, logical), taskID);
  assert.notEqual(requests.reserve('other-actor', requestID, logical), taskID);
  db.close();
});

test('lost HTTP reply and ledger-to-invite crash recovery create exactly one stable invitation', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-directed-'));
  const db = new DatabaseSync(join(root, 'requests.sqlite'));
  const requests = new CreationRequestStore(db);
  const requestID = randomUUID();
  const brainID = randomUUID();
  const taskID = requests.reserve(owner, requestID, { nodeID: target, ...content });
  // Restart after intent persistence, before creating the offer.
  let invites = new RemoteTaskStore(root);
  invites.load();
  const first = invites.create(owner, brainID, target, brainID, content, taskID);
  // The invite was saved but the HTTP response never reached the caller.
  invites = new RemoteTaskStore(root);
  invites.load();
  const retryID = requests.reserve(owner, requestID, { nodeID: target, ...content });
  const retry = invites.create(owner, brainID, target, brainID, content, retryID);
  assert.equal(retry.id, first.id);
  assert.equal(invites.list().length, 1);
  assert.equal(invites.record(taskID)!.idempotencyKey, invites.record(retry.id)!.idempotencyKey);
  assert.throws(
    () => invites.create(owner, brainID, 'C'.repeat(32), brainID, content, taskID),
    /冲突/,
  );
  assert.throws(
    () => invites.create(owner, brainID, target, brainID, { ...content, title: '不同' }, taskID),
    /冲突/,
  );
  db.close();
});

test('automatic creation retry retains the original Brain and Task after placement changes', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-brain-create-'));
  const brainID = randomUUID();
  const taskID = randomUUID();
  const input = { ...content, requestedProjectID: null };
  let tasks = new BrainTaskStore(root);
  tasks.load();
  const first = tasks.create('submitted', owner, brainID, target, input, taskID);
  tasks = new BrainTaskStore(root);
  tasks.load();
  assert.equal(tasks.create('submitted', owner, brainID, target, input, taskID).id, first.id);
  assert.equal(tasks.list().length, 1);
  assert.throws(
    () => tasks.create('submitted', owner, randomUUID(), target, input, taskID),
    /冲突/,
  );
});
