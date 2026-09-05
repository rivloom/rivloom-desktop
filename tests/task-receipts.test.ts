import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeQueueItem } from '../shared/node-queue.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { RemoteTaskInvite, BrainTask } from '../shared/types.ts';
import type { Conversation } from '../src/conversations.ts';
import { taskReceiptView } from '../src/task-receipts.ts';

const date = '2026-09-05T08:00:00.000Z';
const receipt = (extra: Partial<TaskQueueReceipt> = {}) =>
  ({
    state: 'queued',
    position: 3,
    reason: 'slot',
    updatedAt: date,
    queueSequence: 4,
    ...extra,
  }) as TaskQueueReceipt;
const conversation = (remote: Partial<RemoteTaskInvite> = {}) =>
  ({
    key: 'remote:task',
    title: '检查',
    description: '',
    createdAt: date,
    updatedAt: date,
    sourceNodeID: 'sender',
    incoming: false,
    attempts: [],
    remote: {
      status: 'pending',
      executionState: 'not_started',
      executionSequence: 0,
      transmissionState: 'saved',
      ...remote,
    } as RemoteTaskInvite,
  }) as Conversation;

test('local create success is saved, and authenticated delivery still does not invent a queue', () => {
  assert.equal(taskReceiptView(conversation(), { connected: true })?.label, '本机已保存');
  const delivered = taskReceiptView(conversation({ deliveredAt: date }), { connected: true });
  assert.equal(delivered?.label, '对端已接收');
  assert.match(delivered!.detail, /未提供队列信息.*排位未知/);
  assert.equal(delivered?.position, null);
});

test('real queue receipt exposes candidate position and the actual waiting reason', () => {
  const view = taskReceiptView(conversation({ queueReceipt: receipt() }), { connected: true });
  assert.equal(view?.label, '目标 Node 已入队');
  assert.equal(view?.position, 3);
  assert.match(view!.detail, /等待执行槽位/);
  const held = taskReceiptView(
    conversation({
      queueReceipt: receipt({ state: 'held', position: null, reason: '正在维护本机环境' }),
    }),
    { connected: true },
  );
  assert.equal(held?.position, null);
  assert.equal(held?.detail, '正在维护本机环境');
});

test('reconnection preserves the last fact but never claims a current queue position or execution failure', () => {
  const view = taskReceiptView(conversation({ queueReceipt: receipt() }), { connected: false });
  assert.equal(view?.label, '正在确认状态');
  assert.equal(view?.position, null);
  assert.equal(view?.syncing, true);
  assert.match(view!.detail, /上次确认/);
  const unknown = taskReceiptView(
    conversation({ transmissionState: 'transmission_unknown', deliveryError: '连接断开' }),
    { connected: true },
  );
  assert.equal(unknown?.label, '投递状态待确认');
  assert.notEqual(unknown?.tone, 'ended');
});

test('rejection and cancellation remain terminal; review and unknown execution keep their slot', () => {
  const rejected = taskReceiptView(
    conversation({
      queueReceipt: receipt({ state: 'rejected', position: null, reason: '资源维护' }),
    }),
    { connected: false },
  );
  assert.equal(rejected?.label, '目标 Node 已拒绝执行');
  assert.equal(rejected?.detail, '资源维护');
  assert.equal(
    taskReceiptView(conversation({ status: 'cancelled', queueReceipt: receipt() }), {
      connected: true,
    })?.label,
    '投递已取消',
  );
  const reviewing = taskReceiptView(
    conversation({ executionState: 'review', executionSequence: 5, queueReceipt: receipt() }),
    { connected: true },
  );
  assert.equal(reviewing?.label, '待验收');
  assert.match(reviewing!.detail, /执行槽继续保留/);
  const unknown = taskReceiptView(
    conversation({ executionState: 'interrupted', executionSequence: 5 }),
    { connected: true },
  );
  assert.match(unknown!.detail, /不自动重新执行/);
  const contradictory = taskReceiptView(
    conversation({
      executionState: 'running',
      executionSequence: 5,
      queueReceipt: receipt({ state: 'rejected', position: null }),
    }),
    { connected: true },
  );
  assert.equal(contradictory?.label, '执行中');
});

test('Brain queue depth does not become a Node queue or a candidate position', () => {
  const item = {
    ...conversation(),
    remote: undefined,
    brainTask: { status: 'queued', deliveryError: '没有可执行的 Worker' } as BrainTask,
  };
  const view = taskReceiptView(item, { connected: true });
  assert.equal(view?.label, '原 Brain 已接收');
  assert.equal(view?.position, null);
  assert.equal(view?.detail, '没有可执行的 Worker');
});

test('local authoritative queue renders paused reasons and drops positions when its fetch fails', () => {
  const item = { ...conversation(), remote: undefined };
  const queueEntry = {
    state: 'waiting',
    position: null,
    blockReason: { code: 'execution_paused' },
    updatedAt: date,
  } as NodeQueueItem;
  const view = taskReceiptView(item, { connected: true, queueEntry });
  assert.equal(view?.label, '本机已入队');
  assert.match(view!.detail, /Node 已暂停执行/);
  assert.equal(
    taskReceiptView(item, { connected: true, queueEntry, queueConfirmed: false })?.label,
    '正在确认状态',
  );
});
