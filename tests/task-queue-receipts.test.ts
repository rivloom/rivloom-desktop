import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteTaskStore } from '../server/remote-tasks.ts';
import {
  TaskQueueReceiptStore,
  receiptMatchesRemote,
  validQueueReceiptMessage,
} from '../server/task-queue-receipts.ts';
import {
  validNodeQueuePublicStats,
  validTaskQueueReceipt,
  nodeQueueForCapabilities,
  nodeWorkloadCapability,
  nodeConcurrencyCapability,
  queueReceiptCapability,
} from '../shared/task-queue-receipts.ts';

test('origin concurrency reports retain overcommitted counts and negotiate each telemetry extension independently', () => {
  const base = { waitingCount: 1, paused: false, updatedAt: new Date().toISOString(), sampledAt: new Date().toISOString(), health: 'normal' as const };
  const concurrency = { localOccupied: 12, localExecuting: 11, remoteOccupied: 3, remoteExecuting: 3, remoteLimit: 1 };
  const modern = { ...base, concurrency, workload: { occupiedSlots: 3, executingCount: 3, totalSlots: 1 } };
  assert(validNodeQueuePublicStats(modern));
  assert.deepEqual(nodeQueueForCapabilities(modern, [queueReceiptCapability]), base);
  assert.deepEqual(nodeQueueForCapabilities(modern, [queueReceiptCapability, nodeConcurrencyCapability]), { ...base, concurrency });
  assert.deepEqual(nodeQueueForCapabilities(modern, [queueReceiptCapability, nodeWorkloadCapability]), { ...base, workload: modern.workload });
  for (const invalid of [null, {}, { ...concurrency, remoteLimit: 11 }, { ...concurrency, localExecuting: 13 }, { ...concurrency, privateTitle: 'secret' }])
    assert(!validNodeQueuePublicStats({ ...base, concurrency: invalid }));
});

test('workload telemetry validates bounded counts and strips extensions for old queue decoders', () => {
  const stats = {
    waitingCount: 2,
    paused: false,
    updatedAt: new Date().toISOString(),
    sampledAt: new Date().toISOString(),
    health: 'normal' as const,
  };
  const workload = { occupiedSlots: 2, totalSlots: 1, executingCount: 1 };
  const modern = { ...stats, workload };
  assert(validNodeQueuePublicStats(modern));
  for (const invalid of [
    null,
    undefined,
    [],
    { ...workload, titles: ['private'] },
    { ...workload, occupiedSlots: -1 },
    { ...workload, totalSlots: 1.5 },
    { ...workload, executingCount: 3 },
    { ...workload, totalSlots: 100_001 },
  ])
    assert(!validNodeQueuePublicStats({ ...stats, workload: invalid }));
  assert.deepEqual(nodeQueueForCapabilities(modern, [queueReceiptCapability]), stats);
  assert.deepEqual(
    nodeQueueForCapabilities(modern, [queueReceiptCapability, nodeWorkloadCapability]),
    modern,
  );
  assert.equal(nodeQueueForCapabilities(modern, [nodeWorkloadCapability]), null);
  assert.deepEqual(modern.workload, workload, 'serialization does not mutate the local report');
});

function setup() {
  mkdirSync('.data/verification', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-receipt-'));
  const offers = new RemoteTaskStore(root);
  const brainID = randomUUID();
  const remote = offers.create('A'.repeat(32), brainID, 'B'.repeat(32), brainID, {
    title: 'PRIVATE other task title',
    description: 'PRIVATE body',
    criteria: 'PRIVATE check',
  });
  const receipts = new TaskQueueReceiptStore(root);
  return { root, offers, remote, receipts };
}

test('queue receipts have independent sequences, persist/replay and do not copy private task data', () => {
  const { root, remote, receipts } = setup();
  const first = receipts.publish(remote, { state: 'queued', position: 2, reason: '等待执行槽位' });
  assert.equal(first.queueSequence, 1);
  assert.equal(remote.executionSequence, 0);
  const second = receipts.publish(remote, { state: 'queued', position: 1, reason: '等待执行槽位' });
  assert.equal(second.queueSequence, 2);
  assert.equal(
    receipts.publish(remote, { state: 'queued', position: 1, reason: '等待执行槽位' })
      .queueSequence,
    2,
  );
  receipts.delivered(`remote:${remote.id}`, first);
  assert.equal(receipts.pending(remote.ownerNodeID).length, 1, 'stale ACK cannot clear new state');
  receipts.delivered(`remote:${remote.id}`, second);
  assert.equal(receipts.pending(remote.ownerNodeID).length, 0);
  const restarted = new TaskQueueReceiptStore(root);
  restarted.load();
  restarted.replay(remote.ownerNodeID);
  assert.deepEqual(restarted.pending(remote.ownerNodeID)[0].receipt, second);
  assert.equal(restarted.pending('C'.repeat(32)).length, 0);
  assert(!readFileSync(join(root, 'task-queue-receipts.json'), 'utf8').includes('PRIVATE'));
});

test('rejected queue receipt cannot be revived by duplicates, reordering, newer sequence or local rescan', () => {
  const { remote, receipts } = setup();
  const queued = receipts.publish(remote, { state: 'queued', position: 1, reason: null });
  const rejected = receipts.publish(remote, {
    state: 'rejected',
    position: null,
    reason: '执行节点已拒绝',
  });
  assert.equal(receipts.receive(`remote:${remote.id}`, queued), false);
  assert.equal(receipts.receive(`remote:${remote.id}`, rejected), false);
  assert.equal(
    receipts.receive(
      `remote:${remote.id}`,
      Object.fromEntries(Object.entries(rejected).reverse()) as typeof rejected,
    ),
    false,
    'field serialization order does not change an identical authenticated receipt',
  );
  assert.equal(receipts.receive(`remote:${remote.id}`, { ...queued, queueSequence: 50 }), false);
  assert.equal(
    receipts.publish(remote, { state: 'queued', position: 1, reason: null }).state,
    'rejected',
  );
  assert.throws(
    () => receipts.receive(`remote:${remote.id}`, { ...rejected, reason: 'conflict' }),
    /冲突/,
  );
});

test('admitted queue receipt cannot fall back to waiting or imply actual execution', () => {
  const { remote, receipts } = setup();
  const admitted = receipts.publish(remote, { state: 'admitted', position: null, reason: null });
  assert.equal(remote.executionState, 'not_started');
  assert.equal(
    receipts.receive(`remote:${remote.id}`, { ...admitted, queueSequence: 4, state: 'held' }),
    false,
  );
  assert.equal(receipts.get(`remote:${remote.id}`)!.state, 'admitted');
});

test('queue receipt and public statistics validators reject extra fields, oversized values and bad routing', () => {
  const { remote, receipts } = setup();
  const receipt = receipts.publish(remote, { state: 'queued', position: 1, reason: null });
  const stats = {
    waitingCount: 2,
    paused: false,
    updatedAt: receipt.updatedAt,
    sampledAt: receipt.updatedAt,
    health: 'normal',
  };
  assert(validNodeQueuePublicStats(stats));
  assert(!validNodeQueuePublicStats({ ...stats, titles: ['other title'] }));
  assert(!validNodeQueuePublicStats({ ...stats, waitingCount: -1 }));
  assert(!validTaskQueueReceipt({ ...receipt, localProjectID: randomUUID() }));
  assert(!validTaskQueueReceipt({ ...receipt, reason: 'x'.repeat(301) }));
  assert(!validTaskQueueReceipt({ ...receipt, state: 'held', position: 1 }));
  assert(!validTaskQueueReceipt({ ...receipt, targetBrainID: randomUUID() }));
  assert(receiptMatchesRemote(receipt, remote));
  assert(!receiptMatchesRemote({ ...receipt, remoteTaskID: randomUUID() }, remote));
  assert(!receiptMatchesRemote({ ...receipt, targetNodeID: 'C'.repeat(32) }, remote));
  const message = { type: 'remote-task-queue', version: 1, idempotencyKey: randomUUID(), receipt };
  assert(validQueueReceiptMessage(message));
  assert(!validQueueReceiptMessage({ ...message, localModel: 'private' }));
});

test('Master forwards only the current execution receipt and a new execution has independent queue sequence', () => {
  const { remote, receipts } = setup();
  const brainTaskID = randomUUID();
  const receipt = receipts.publish(
    { ...remote, brainTaskID },
    { state: 'admitted', position: null, reason: null },
  );
  const key = `brain:${brainTaskID}`;
  receipts.receive(key, receipt, 'C'.repeat(32));
  const message = {
    type: 'brain-task-queue',
    version: 1,
    taskID: brainTaskID,
    brainID: remote.ownerBrainID,
    masterNodeID: remote.ownerNodeID,
    submitterNodeID: 'C'.repeat(32),
    idempotencyKey: randomUUID(),
    receipt,
  };
  assert(validQueueReceiptMessage(message));
  assert(!validQueueReceiptMessage({ ...message, taskID: randomUUID() }));
  assert(!validQueueReceiptMessage({ ...message, masterNodeID: 'D'.repeat(32) }));
  const next = {
    ...receipt,
    remoteTaskID: randomUUID(),
    targetNodeID: 'E'.repeat(32),
    queueSequence: 1,
    state: 'queued' as const,
    position: 1,
  };
  assert(receipts.receive(key, next, 'C'.repeat(32)));
  assert.equal(receipts.pending('C'.repeat(32)).length, 1);
  assert.equal(receipts.pending('C'.repeat(32))[0].receipt.remoteTaskID, next.remoteTaskID);
});

test('offer delivery records saved, attempted, uncertain and authenticated delivery separately', () => {
  const { root, offers, remote } = setup();
  assert.equal(remote.transmissionState, 'saved');
  offers.markOfferTransmission(remote.id, 'sending');
  let restored = new RemoteTaskStore(root);
  restored.load();
  assert.equal(restored.record(remote.id)!.transmissionState, 'transmission_unknown');
  assert.equal(restored.record(remote.id)!.deliveredAt, null);
  const message = restored.message(remote.id)!;
  restored.markDelivered(remote.id, message);
  assert.equal(restored.record(remote.id)!.transmissionState, 'delivered');
  assert(restored.record(remote.id)!.deliveredAt);
  assert.equal(restored.record(remote.id)!.executionSequence, 0);
  restored.markOfferTransmission(remote.id, 'transmission_unknown');
  restored = new RemoteTaskStore(root);
  restored.load();
  assert.equal(restored.record(remote.id)!.transmissionState, 'delivered');
});

test('legacy HTTP transport success remains uncertain until an authenticated task response arrives', () => {
  const { root, offers, remote } = setup();
  const offer = offers.message(remote.id)!;
  assert.equal(offer.type, 'remote-task-offer');
  offers.markDelivered(remote.id, offer, false);
  assert.equal(offers.record(remote.id)!.transmissionState, 'transmission_unknown');
  assert.equal(offers.record(remote.id)!.deliveredAt, null);
  assert.equal(offers.record(remote.id)!.deliveryPending, true);
  const receiver = new RemoteTaskStore(join(root, 'legacy-receiver'));
  if (offer.type !== 'remote-task-offer') throw new Error('fixture offer expected');
  receiver.receiveOffer(offer);
  receiver.decide(remote.id, 'accepted');
  const response = receiver.message(remote.id)!;
  if (response.type !== 'remote-task-response') throw new Error('fixture response expected');
  offers.receiveResponse(response);
  assert.equal(offers.record(remote.id)!.transmissionState, 'delivered');
  assert(offers.record(remote.id)!.deliveredAt);
});
