import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversations,
  conversationState,
  conversationIsRunning,
  localQueue,
  executionQueueEntries,
  pairedNodes,
  showNetworkRail,
  type Conversation,
} from '../src/conversations.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { NodeQueueItem } from '../shared/node-queue.ts';
import type { Bootstrap, BrainTask, RemoteTaskInvite, Task, RivloomNode } from '../shared/types.ts';

const localID = 'local-node';
const date = '2026-09-03T00:00:00Z';

test('confirmed stopped tasks leave the rail while history and explicit continuation remain visible', () => {
  const entry = { id: 'queue', localTaskID: 'task', state: 'admitted', endReason: null } as NodeQueueItem;
  for (const state of ['running', 'stopping', 'interrupted', 'waiting_approval', 'review'] as const)
    assert.equal(executionQueueEntries([entry], [localTask('task', state)]).length, 1, state);
  assert.equal(executionQueueEntries([entry], []).length, 1, 'Missing execution is still uncertain');
  assert.equal(executionQueueEntries([entry], [localTask('task', 'stopped')]).length, 0);
  const ended = { ...entry, state: 'ended' as const, endReason: { code: 'stopped' as const } };
  for (const state of ['stopped', 'accepted', 'failed'] as const)
    assert.equal(executionQueueEntries([ended], [localTask('task', state)]).length, 0, state);
  for (const state of ['running', 'waiting_approval', 'waiting_input', 'stopping', 'review', 'interrupted'] as const)
    assert.deepEqual(executionQueueEntries([ended], [localTask('task', state)]), [ended], state);
  assert.equal(ended.state, 'ended', 'Showing an explicit continuation does not reopen admission');
  const data = fixture(); data.tasks = [localTask('task', 'stopped')];
  assert(conversations(data).some((item) => item.localTask?.id === 'task'), 'Stopping preserves the conversation');
});

test('only the current executing observation animates, including remote and Brain histories', () => {
  const item = (extra: Partial<Conversation>) =>
    ({ key: 'history', attempts: [], ...extra }) as Conversation;
  const brain = (status: BrainTask['status']) => ({ status }) as BrainTask;
  assert.equal(conversationIsRunning(item({ localTask: localTask('local', 'running') })), true);
  assert.equal(
    conversationIsRunning(item({ remote: remoteTask('remote', { executionState: 'running' }) })),
    true,
  );
  assert.equal(conversationIsRunning(item({ brainTask: brain('running') })), true);
  for (const state of [
    'open',
    'ready',
    'waiting_approval',
    'waiting_input',
    'stopping',
    'stopped',
    'interrupted',
    'failed',
    'review',
    'accepted',
  ] as const)
    assert.equal(
      conversationIsRunning(item({ localTask: localTask('local', state) })),
      false,
      state,
    );
  for (const status of [
    'submitting',
    'queued',
    'assigned',
    'waiting',
    'review',
    'completed',
    'failed',
  ] as const)
    assert.equal(conversationIsRunning(item({ brainTask: brain(status) })), false, status);
  for (const status of ['cancelled', 'declined', 'expired'] as const)
    assert.equal(
      conversationIsRunning(
        item({ remote: remoteTask('stale', { status, executionState: 'running' }) }),
      ),
      false,
      status,
    );
  assert.equal(
    conversationIsRunning(
      item({ localTask: localTask('local', 'review'), brainTask: brain('running') }),
    ),
    false,
    'local review wins over an older Brain observation',
  );
  assert.equal(
    conversationIsRunning(
      item({
        brainTask: brain('completed'),
        remote: remoteTask('stale', { executionState: 'running' }),
      }),
    ),
    false,
    'completed Brain wins over its previous execution',
  );
  assert.equal(
    conversationIsRunning(
      item({
        brainTask: brain('running'),
        remote: remoteTask('remote', { executionState: 'waiting_approval' }),
      }),
    ),
    false,
    'current remote approval is static',
  );
  assert.equal(
    conversationIsRunning(
      item({
        localTask: localTask('local', 'ready'),
        remote: remoteTask('remote', { executionState: 'running' }),
      }),
    ),
    true,
    'initial local placeholder does not hide remote execution',
  );
  assert.equal(
    conversationIsRunning(item({ attempts: [remoteTask('old', { executionState: 'running' })] })),
    false,
    'old attempts do not animate the current conversation',
  );
});

function fixture() {
  return {
    tasks: [],
    network: { local: { id: localID }, nearby: [], remoteTasks: [], brainTasks: [] },
  } as unknown as Bootstrap;
}
function localTask(id: string, state: Task['state'] = 'review'): Task {
  return { id, title: id, description: id, state, createdAt: date, updatedAt: date } as Task;
}
function remoteTask(id: string, extra: Partial<RemoteTaskInvite> = {}): RemoteTaskInvite {
  return {
    id,
    brainTaskID: 'brain-task',
    direction: 'incoming',
    ownerNodeID: 'peer',
    targetNodeID: localID,
    title: id,
    description: id,
    createdAt: date,
    updatedAt: date,
    status: 'accepted',
    executionState: 'review',
    ...extra,
  } as RemoteTaskInvite;
}
test('local and received sessions have different sources; linked execution appears once', () => {
  const data = fixture();
  data.tasks = [
    localTask('mine'),
    {
      ...localTask('received'),
      remoteOrigin: { remoteTaskID: 'execution', ownerNodeID: 'peer', ownerBrainID: 'brain' },
    },
  ];
  data.network.remoteTasks = [remoteTask('execution', { localTaskID: 'received' })];
  const items = conversations(data);
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.localTask?.id === 'mine')?.incoming, false);
  assert.equal(items.find((item) => item.localTask?.id === 'received')?.incoming, true);
  assert.equal(localQueue(items, localID).length, 2);
});
test('own Brain task returning to own Worker stays light and retries do not duplicate sessions', () => {
  const data = fixture();
  data.tasks = [localTask('local-execution')];
  data.network.brainTasks = [
    {
      id: 'brain-task',
      title: 'mine',
      description: 'mine',
      submitterNodeID: localID,
      executionID: 'second',
      status: 'review',
      createdAt: date,
      updatedAt: date,
    } as BrainTask,
  ];
  data.network.remoteTasks = [
    remoteTask('first', { status: 'declined', localTaskID: null }),
    remoteTask('second', { localTaskID: 'local-execution' }),
  ];
  const items = conversations(data);
  assert.equal(items.length, 1);
  assert.equal(items[0].incoming, false);
  assert.equal(items[0].attempts.length, 2);
  assert.equal(items[0].localTask?.id, 'local-execution');
  assert.equal(items[0].key, 'brain:brain-task');
});
test('a Master queue is not the local Worker queue; completed and declined attempts are excluded', () => {
  const data = fixture();
  data.tasks = [localTask('done', 'accepted'), localTask('ready', 'ready')];
  data.network.brainTasks = [
    {
      id: 'unassigned',
      status: 'queued',
      submitterNodeID: 'peer',
      title: 'waiting',
      description: '',
      createdAt: date,
      updatedAt: date,
    } as BrainTask,
  ];
  data.network.remoteTasks = [
    remoteTask('other-worker', { brainTaskID: 'other', targetNodeID: 'other-node' }),
    remoteTask('declined', {
      brainTaskID: null,
      status: 'declined',
      executionState: 'not_started',
    }),
  ];
  assert.deepEqual(
    localQueue(conversations(data), localID).map((item) => item.title),
    ['ready'],
  );
});
test('an incoming accepted invitation waiting for execution is in the local queue', () => {
  const data = fixture();
  data.network.remoteTasks = [
    remoteTask('waiting', { executionState: 'not_started', localTaskID: null }),
  ];
  assert.equal(localQueue(conversations(data), localID).length, 1);
});
test('the rail requires an online paired connection, not discovery or stale trust alone', () => {
  const data = fixture();
  data.network.nearby = [
    { id: 'untrusted', online: true, trusted: false, channelReady: true } as RivloomNode,
  ];
  assert.equal(showNetworkRail(pairedNodes(data)), false);
  data.network.paired = [
    {
      id: 'paired',
      name: 'peer',
      online: false,
      trusted: true,
      channelReady: false,
    } as RivloomNode,
  ];
  assert.equal(showNetworkRail(pairedNodes(data)), false);
  data.network.paired[0].online = true;
  assert.equal(showNetworkRail(pairedNodes(data)), false);
  data.network.paired[0].channelReady = true;
  assert.equal(showNetworkRail(pairedNodes(data)), true);
});

test('queue receipts update conversation status without overriding terminal or actual execution facts', () => {
  const data = fixture();
  const waiting = remoteTask('waiting', {
    brainTaskID: null,
    executionState: 'not_started',
    queueReceipt: { state: 'held' } as TaskQueueReceipt,
  });
  data.network.remoteTasks = [waiting];
  assert.equal(conversationState(conversations(data)[0]), '已暂缓');
  waiting.executionState = 'review';
  assert.equal(conversationState(conversations(data)[0]), '已完成');
  waiting.executionState = 'not_started';
  waiting.status = 'cancelled';
  assert.equal(conversationState(conversations(data)[0]), '已取消');
});

test('terminal Brain labels override stale remote snapshots while direct local execution stays authoritative', () => {
  const data = fixture();
  data.network.brainTasks = [
    {
      id: 'brain-task',
      title: 'finished work',
      description: '',
      submitterNodeID: localID,
      executionID: 'execution',
      status: 'completed',
      createdAt: date,
      updatedAt: date,
    } as BrainTask,
  ];
  data.network.remoteTasks = [remoteTask('execution', { executionState: 'running' })];
  assert.equal(conversationState(conversations(data)[0]), '已完成');

  data.network.brainTasks[0].status = 'failed';
  data.network.remoteTasks[0].executionState = 'accepted';
  assert.equal(conversationState(conversations(data)[0]), '执行失败');

  data.network.brainTasks[0].status = 'completed';
  data.network.remoteTasks[0].status = 'cancelled';
  assert.equal(conversationState(conversations(data)[0]), '已完成');

  data.tasks = [localTask('current', 'waiting_input')];
  data.network.remoteTasks[0].localTaskID = 'current';
  assert.equal(conversationState(conversations(data)[0]), '待补充');
});
