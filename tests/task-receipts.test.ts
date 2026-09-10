import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeQueueItem } from '../shared/node-queue.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { RemoteTaskInvite, BrainTask, Task } from '../shared/types.ts';
import type { Conversation } from '../src/conversations.ts';
import { taskReceiptView } from '../src/task-receipts.ts';
import { remoteExecutionSummary } from '../server/remote-execution-summary.ts';

test('acceptance preserves the final assistant result instead of replacing it with a status label', () => {
  const value: Pick<Task, 'state' | 'messages' | 'error'> = {
    state: 'review',
    error: null,
    messages: [
      { id: 'u1', role: 'user', text: 'Request', tools: [] },
      { id: 'a1', role: 'assistant', text: 'Earlier response', tools: [] },
      { id: 'a2', role: 'assistant', text: 'RIVLOOM-RESULT\n中文成果 ✅', tools: [] },
    ],
  };
  const reviewed = remoteExecutionSummary(value);
  assert.equal(reviewed, 'RIVLOOM-RESULT\n中文成果 ✅');
  assert.equal(remoteExecutionSummary({ ...value, state: 'accepted' }), reviewed);
});

test('accepted remote results retain redaction, size limits and an accurate empty-result fallback', () => {
  const value: Pick<Task, 'state' | 'messages' | 'error'> = {
    state: 'accepted',
    error: null,
    messages: [
      {
        id: 'a',
        role: 'assistant',
        text: 'Bearer abcdefghijklmnopqrstuvwxyz123456\n' + '文'.repeat(13000),
        tools: [],
      },
    ],
  };
  const summary = remoteExecutionSummary(value);
  assert(!summary.includes('abcdefghijklmnopqrstuvwxyz123456'));
  assert(summary.length <= 12000);
  assert.equal(remoteExecutionSummary({ ...value, messages: [] }), '已完成');
  assert.equal(remoteExecutionSummary({ ...value, state: 'running' }), 'OpenCode 正在执行任务。');
});

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
  assert.equal(reviewing?.label, '已完成');
  assert.match(reviewing!.detail, /旧版执行节点/);
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

test('terminal Brain and delivery receipts supersede stale remote completion snapshots', () => {
  const failed = {
    ...conversation({ status: 'accepted', executionState: 'accepted' }),
    brainTask: { status: 'failed', executionSummary: '' } as BrainTask,
  };
  const failedView = taskReceiptView(failed, { connected: true });
  assert.equal(failedView?.label, '执行失败');
  assert.equal(failedView?.tone, 'ended');

  const cases: [RemoteTaskInvite['status'], string][] = [
    ['cancelled', '投递已取消'],
    ['expired', '投递已过期'],
    ['declined', 'Node 未接受执行'],
  ];
  for (const [status, label] of cases) {
    const view = taskReceiptView(conversation({ status, executionState: 'accepted' }), {
      connected: false,
    });
    assert.equal(view?.label, label, status);
    assert.equal(view?.tone, 'ended');
    assert.equal(view?.syncing, false);
  }
});

test('direct local execution retains priority and an unstarted local queue rejection remains authoritative', () => {
  const item = {
    ...conversation({ status: 'cancelled', executionState: 'running' }),
    brainTask: { status: 'failed', executionSummary: '' } as BrainTask,
    localTask: { state: 'accepted', sessionID: 'local-session' } as Task,
  };
  const completed = taskReceiptView(item, { connected: true });
  assert.equal(completed?.label, '已完成');
  assert.equal(completed?.tone, 'ended');
  item.localTask.state = 'waiting_input';
  assert.equal(taskReceiptView(item, { connected: true })?.label, '待补充');
  const reconnecting = taskReceiptView(item, { connected: false });
  assert.equal(reconnecting?.label, '正在确认状态');
  assert.match(reconnecting!.detail, /待补充/);

  item.localTask.state = 'ready';
  item.localTask.sessionID = null;
  const queueEntry = {
    state: 'ended',
    endReason: { code: 'rejected', message: '维护中，请稍后提交' },
  } as NodeQueueItem;
  const rejected = taskReceiptView(item, { connected: true, queueEntry });
  assert.equal(rejected?.label, '本机已拒绝执行');
  assert.equal(rejected?.detail, '维护中，请稍后提交');
});
