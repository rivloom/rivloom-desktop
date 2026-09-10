import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationStatusGroup,
  filterConversations,
  type ConversationStatusGroup,
} from '../src/conversation-filters.ts';
import { conversations, type Conversation } from '../src/conversations.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { Bootstrap, BrainTask, RemoteTaskInvite, Task } from '../shared/types.ts';

const date = '2026-09-07T00:00:00Z';
const nodeName = (id: string | null) => (id === 'peer' ? 'Design Laptop' : 'This device');

function conversation(extra: Partial<Conversation> = {}): Conversation {
  return {
    key: 'local:task',
    title: 'Draft release notes',
    description: 'Prepare a summary',
    createdAt: date,
    updatedAt: date,
    sourceNodeID: 'local',
    incoming: false,
    attempts: [],
    ...extra,
  };
}

function task(state: Task['state']): Task {
  return { id: 'task', state, createdAt: date, updatedAt: date } as Task;
}

function remote(extra: Partial<RemoteTaskInvite> = {}): RemoteTaskInvite {
  return {
    id: 'execution',
    brainTaskID: 'brain-task',
    title: 'Draft release notes',
    description: '',
    ownerNodeID: 'peer',
    targetNodeID: 'local',
    status: 'accepted',
    executionState: 'not_started',
    createdAt: date,
    updatedAt: date,
    ...extra,
  } as RemoteTaskInvite;
}

function brain(status: BrainTask['status'], extra: Partial<BrainTask> = {}): BrainTask {
  return {
    id: 'brain-task',
    title: 'Draft release notes',
    description: '',
    submitterNodeID: 'local',
    status,
    executionID: 'execution',
    createdAt: date,
    updatedAt: date,
    ...extra,
  } as BrainTask;
}

const executionCases: [Task['state'], ConversationStatusGroup][] = [
  ['open', 'active'],
  ['ready', 'active'],
  ['running', 'active'],
  ['stopping', 'active'],
  ['waiting_approval', 'attention'],
  ['waiting_input', 'attention'],
  ['review', 'completed'],
  ['interrupted', 'attention'],
  ['accepted', 'completed'],
  ['stopped', 'ended'],
  ['failed', 'ended'],
];

test('local task states distinguish pending work, attention, accepted results, and unsuccessful endings', () => {
  for (const [state, expected] of executionCases) {
    assert.equal(
      conversationStatusGroup(conversation({ localTask: task(state) })),
      expected,
      state,
    );
  }
});

test('remote execution states use the same groups without treating an accepted invite as completion', () => {
  for (const [state, expected] of executionCases) {
    assert.equal(
      conversationStatusGroup(conversation({ remote: remote({ executionState: state }) })),
      expected,
      state,
    );
  }
  for (const status of ['pending', 'accepted'] as const) {
    assert.equal(conversationStatusGroup(conversation({ remote: remote({ status }) })), 'active');
  }
});

test('Brain states classify correctly even when the device has no execution snapshot', () => {
  const cases: [BrainTask['status'], ConversationStatusGroup][] = [
    ['submitting', 'active'],
    ['queued', 'active'],
    ['assigned', 'active'],
    ['running', 'active'],
    ['waiting', 'attention'],
    ['review', 'completed'],
    ['completed', 'completed'],
    ['failed', 'ended'],
  ];
  for (const [status, expected] of cases) {
    assert.equal(
      conversationStatusGroup(conversation({ brainTask: brain(status) })),
      expected,
      status,
    );
  }
});

test('terminal delivery and Brain status override stale remote execution snapshots', () => {
  for (const status of ['declined', 'cancelled', 'expired'] as const) {
    for (const executionState of ['not_started', 'running', 'review', 'accepted'] as const) {
      assert.equal(
        conversationStatusGroup(conversation({ remote: remote({ status, executionState }) })),
        'ended',
        `${status}: ${executionState}`,
      );
    }
  }
  assert.equal(
    conversationStatusGroup(
      conversation({
        brainTask: brain('completed'),
        remote: remote({ executionState: 'running' }),
      }),
    ),
    'completed',
  );
  assert.equal(
    conversationStatusGroup(
      conversation({ brainTask: brain('failed'), remote: remote({ executionState: 'accepted' }) }),
    ),
    'ended',
  );
});

test('actual local execution takes precedence over remote snapshots and initial task placeholders', () => {
  assert.equal(
    conversationStatusGroup(
      conversation({
        localTask: task('waiting_input'),
        remote: remote({ executionState: 'running' }),
      }),
    ),
    'attention',
  );
  assert.equal(
    conversationStatusGroup(
      conversation({ localTask: task('accepted'), remote: remote({ executionState: 'review' }) }),
    ),
    'completed',
  );
  assert.equal(
    conversationStatusGroup(
      conversation({ localTask: task('ready'), remote: remote({ status: 'cancelled' }) }),
    ),
    'ended',
  );
});

test('queue holds and rejections classify initial work without overriding actual execution facts', () => {
  const cases: [TaskQueueReceipt['state'], ConversationStatusGroup][] = [
    ['queued', 'active'],
    ['admitted', 'active'],
    ['held', 'attention'],
    ['rejected', 'ended'],
  ];
  for (const [state, expected] of cases) {
    const queueReceipt = { state } as TaskQueueReceipt;
    assert.equal(
      conversationStatusGroup(conversation({ remote: remote({ queueReceipt }) })),
      expected,
      state,
    );
    assert.equal(
      conversationStatusGroup(
        conversation({ localTask: task('ready'), brainTask: brain('assigned', { queueReceipt }) }),
      ),
      expected,
      `initial task: ${state}`,
    );
    for (const executionState of ['running', 'review', 'accepted'] as const) {
      assert.equal(
        conversationStatusGroup(conversation({ remote: remote({ queueReceipt, executionState }) })),
        executionCases.find(([value]) => value === executionState)![1],
        `actual state: ${executionState}, receipt: ${state}`,
      );
    }
  }
});

test('retries use the current Brain execution and retain the original source', () => {
  const oldAttempt = remote({ id: 'old', status: 'declined', executionState: 'failed' });
  const currentAttempt = remote({ localTaskID: 'task', executionState: 'waiting_approval' });
  const data = {
    tasks: [task('waiting_approval')],
    network: {
      local: { id: 'local' },
      remoteTasks: [oldAttempt, currentAttempt],
      brainTasks: [brain('waiting')],
    },
  } as unknown as Bootstrap;
  const items = conversations(data);
  assert.equal(items.length, 1);
  assert.equal(items[0].attempts.length, 2);
  assert.equal(conversationStatusGroup(items[0]), 'attention');
  assert.deepEqual(filterConversations(items, { source: 'own' }, nodeName), items);
  assert.deepEqual(filterConversations(items, { source: 'incoming' }, nodeName), []);

  data.tasks = [];
  data.network.brainTasks = [brain('queued', { executionID: null })];
  assert.equal(conversationStatusGroup(conversations(data)[0]), 'active');
});

test('status, source, and title or source-name search combine without changing order or input', () => {
  const own = conversation({ key: 'mine', localTask: task('accepted') });
  const incoming = conversation({
    key: 'incoming',
    incoming: true,
    sourceNodeID: 'peer',
    localTask: task('review'),
  });
  const ended = conversation({ key: 'ended', localTask: task('failed') });
  const items = Object.freeze([incoming, own, ended]);
  const before = structuredClone(items);
  assert.deepEqual(
    filterConversations(
      items,
      { status: 'completed', source: 'incoming', query: '  DESIGN  ' },
      nodeName,
    ),
    [incoming],
  );
  assert.deepEqual(
    filterConversations(items, { status: 'completed', source: 'own', query: 'RELEASE' }, nodeName),
    [own],
  );
  assert.deepEqual(
    filterConversations(items, { status: 'ended', source: 'incoming' }, nodeName),
    [],
  );
  assert.deepEqual(filterConversations(items, { query: 'absent' }, nodeName), []);
  assert.deepEqual(filterConversations(items, { query: '   ' }, nodeName), items);
  assert.deepEqual(filterConversations(items, {}, nodeName), items);
  assert.deepEqual(items, before);
  assert.notEqual(filterConversations(items, {}, nodeName), items);
  assert.equal(filterConversations(items, {}, nodeName)[0], incoming);
});

test('requirement-body search combines with status and source for already loaded conversations', () => {
  const incoming = conversation({
    key: 'incoming',
    description: '整理客户访谈纪要，补齐退款流程。',
    incoming: true,
    sourceNodeID: 'peer',
    localTask: task('review'),
  });
  const own = conversation({
    key: 'own',
    description: '整理客户访谈纪要，补齐退款流程。',
    localTask: task('accepted'),
  });
  const remoteItem = conversation({
    key: 'remote:execution',
    description: 'Check the Kubernetes network policy.',
    remote: remote(),
  });
  const brainItem = conversation({
    key: 'brain:brain-task',
    description: '制作包含退款流程的操作手册。',
    brainTask: brain('queued'),
  });
  const items = Object.freeze([incoming, own, remoteItem, brainItem]);
  const before = structuredClone(items);
  assert.deepEqual(filterConversations(items, { query: '退款流程' }, nodeName), [
    incoming,
    own,
    brainItem,
  ]);
  assert.deepEqual(
    filterConversations(
      items,
      { query: '退款流程', source: 'incoming', status: 'completed' },
      nodeName,
    ),
    [incoming],
  );
  assert.deepEqual(
    filterConversations(items, { query: '退款流程', source: 'own', status: 'completed' }, nodeName),
    [own],
  );
  assert.deepEqual(
    filterConversations(items, { query: '  KUBERNETES NETWORK  ', status: 'active' }, nodeName),
    [remoteItem],
  );
  assert.deepEqual(items, before);
});

test('saved requirement supplements and user-authored envelope-like wording remain searchable', () => {
  const item = conversation({
    description:
      '文档保留“验收标准：”标题。\n\n补充要求：增加 Safari 兼容性说明，并解释“不要调用子代理”这句话。',
    localTask: {
      ...task('review'),
      messages: [
        { id: 'prompt', role: 'user', text: 'Internal engine envelope', tools: [] },
        { id: 'reply', role: 'assistant', text: '已整理文档。', tools: [] },
      ],
    },
  });
  for (const query of ['验收标准：', 'safari 兼容性', '不要调用子代理']) {
    assert.deepEqual(filterConversations([item], { query }, nodeName), [item], query);
  }
});

test('body search excludes engine envelopes, replies, tools, model settings, and execution summaries', () => {
  const item = conversation({
    description: '请整理客户访谈。',
    localTask: {
      ...task('review'),
      criteria: 'criteria-only-term',
      model: 'model-only-term',
      messages: [
        {
          id: 'prompt',
          role: 'user',
          text: '任务：检查\n\n要求：请整理客户访谈。\n\n验收标准：\ncriteria-only-term\n\n不要调用子代理。',
          tools: [],
        },
        {
          id: 'reply',
          role: 'assistant',
          text: 'reply-only-term',
          tools: [
            { name: 'tool-only-name', title: '', status: 'completed', output: 'tool-only-output' },
          ],
        },
      ],
    },
    remote: remote({ executionSummary: 'remote-summary-only-term' }),
    brainTask: brain('review', { executionSummary: 'brain-summary-only-term' }),
  });
  for (const query of [
    '验收标准',
    '不要调用子代理',
    'criteria-only-term',
    'model-only-term',
    'reply-only-term',
    'tool-only-name',
    'tool-only-output',
    'remote-summary-only-term',
    'brain-summary-only-term',
  ]) {
    assert.deepEqual(filterConversations([item], { query }, nodeName), [], query);
  }
  assert.deepEqual(filterConversations([item], { query: '客户访谈' }, nodeName), [item]);
});

test('missing or unfamiliar execution facts remain visible as active work', () => {
  assert.equal(conversationStatusGroup(conversation()), 'active');
  assert.equal(
    conversationStatusGroup(conversation({ localTask: task('future_state' as Task['state']) })),
    'active',
  );
  assert.equal(
    conversationStatusGroup(
      conversation({ brainTask: brain('future_state' as BrainTask['status']) }),
    ),
    'active',
  );
  assert.equal(
    conversationStatusGroup(
      conversation({
        remote: remote({ executionState: 'future_state' as RemoteTaskInvite['executionState'] }),
      }),
    ),
    'active',
  );
});
