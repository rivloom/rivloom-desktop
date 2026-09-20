import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collectAttention, completionSoundFor } from '../shared/task-attention.ts';
import { TaskAttentionStore, notificationPreferencesSchema } from '../server/task-attention.ts';
import type { Bootstrap, Task, RemoteTaskInvite, BrainTask } from '../shared/types.ts';

const task = (state: Task['state'], more: Partial<Task> = {}) =>
  ({
    id: 'one',
    title: 'One',
    state,
    creatorID: 'owner',
    assigneeID: 'owner',
    approverID: 'owner',
    reviewerID: 'owner',
    updatedAt: '2026-09-06T00:00:00Z',
    createdAt: '2026-09-06T00:00:00Z',
    runAfter: 1,
    approvals: [],
    questions: [],
    ...more,
  }) as Task;
const fixture = (tasks: Task[] = []) =>
  ({
    user: { id: 'owner', owner: true },
    tasks,
    network: { local: { id: 'local' }, remoteTasks: [], brainTasks: [] },
  }) as unknown as Bootstrap;

test('sound preferences migrate old saved settings, persist per user and reject unknown audio sources', () => {
  const db = new DatabaseSync(':memory:'), store = new TaskAttentionStore(db, () => 1000);
  db.prepare('INSERT INTO task_attention_preferences VALUES (?,?)').run('owner', JSON.stringify({ enabled: false, quietUntil: 1500 }));
  assert.deepEqual(store.preferences('owner'), { enabled: false, quietUntil: 1500, completionSound: 'chime' });
  for (const completionSound of ['off', 'chime', 'bell', 'pulse'] as const) {
    store.savePreferences('owner', { enabled: true, quietUntil: null, completionSound });
    assert.equal(new TaskAttentionStore(db).preferences('owner').completionSound, completionSound);
  }
  assert.equal(store.preferences('other').completionSound, 'chime');
  assert.throws(() => notificationPreferencesSchema.parse({ enabled: true, quietUntil: null, completionSound: 'file:///private.wav' }));
  db.prepare('UPDATE task_attention_preferences SET body=? WHERE user_id=?').run('{broken', 'owner');
  assert.equal(store.preferences('owner').completionSound, 'off');
  assert.equal(store.preferences('owner').enabled, false);
  db.close();
});

test('completion audio uses delivered events once per round, remains silent on restart/mute and covers remote completion', () => {
  const db = new DatabaseSync(':memory:'), store = new TaskAttentionStore(db, () => 1000);
  const data = fixture([task('running')]);
  assert.equal(completionSoundFor(store.check(data), 1000), null);
  data.tasks[0].state = 'review';
  assert.equal(completionSoundFor(store.check(data), 1000), 'chime');
  assert.equal(completionSoundFor(store.check(data), 1000), null);
  assert.equal(completionSoundFor(new TaskAttentionStore(db).check(data), 1000), null);
  for (const completionSound of ['off', 'bell', 'pulse'] as const) {
    store.savePreferences('owner', { enabled: true, quietUntil: null, completionSound });
    data.tasks[0].state = 'running'; store.check(data); data.tasks[0].state = 'accepted';
    assert.equal(completionSoundFor(store.check(data), 1000), completionSound === 'off' ? null : completionSound);
  }
  store.savePreferences('owner', { enabled: true, quietUntil: 2000, completionSound: 'bell' });
  data.tasks[0].state = 'running'; store.check(data); data.tasks[0].state = 'review';
  assert.equal(completionSoundFor(store.check(data), 1000), null);
  store.savePreferences('owner', { enabled: true, quietUntil: null, completionSound: 'bell' });
  assert.equal(completionSoundFor(store.check(data), 3000), null, 'Unmuting does not replay old completions');
  data.tasks = [];
  data.network.remoteTasks = [{ id: 'remote', direction: 'outgoing', status: 'accepted', executionState: 'running', title: 'Remote', createdAt: '2026-09-20', updatedAt: '2026-09-20' }] as RemoteTaskInvite[];
  store.check(data);
  data.network.remoteTasks[0].executionState = 'review';
  const delivered = store.check(data);
  assert.equal(completionSoundFor(delivered, 3000), 'bell');
  assert.equal(completionSoundFor({ ...delivered, preferences: { ...delivered.preferences, enabled: false } }, 3000), null);
  assert.equal(completionSoundFor({ ...delivered, notifications: delivered.notifications.map(event => ({ ...event, kind: 'approval' })) }, 3000), null);
  assert.equal(completionSoundFor({ ...delivered, notifications: [...delivered.notifications, ...delivered.notifications] }, 3000), 'bell', 'A batch has one sound selection');
  db.close();
});

test('attention filters actual approval/input/review roles and excludes passive observers', () => {
  const data = fixture([
    task('waiting_approval', {
      id: 'a',
      approvals: [{ id: 'request' } as Task['approvals'][number]],
    }),
    task('waiting_input', {
      id: 'b',
      assigneeID: 'other',
      questions: [{ id: 'q' } as Task['questions'][number]],
    }),
    task('review', { id: 'c', reviewerID: 'other' }),
    task('interrupted', { id: 'd' }),
  ]);
  assert.deepEqual(
    collectAttention(data).items.map((i) => [i.conversationKey, i.kind]),
    [
      ['local:a', 'approval'],
      ['local:d', 'interrupted'],
    ],
  );
});
test('linked completed records produce one completion event without review actions; historical retry failures stay hidden', () => {
  const data = fixture([task('review')]);
  data.network.remoteTasks = [
    {
      id: 'old',
      brainTaskID: 'brain',
      status: 'declined',
      createdAt: '2026-01-01',
      direction: 'outgoing',
      executionState: 'not_started',
    },
    {
      id: 'current',
      brainTaskID: 'brain',
      localTaskID: 'one',
      createdAt: '2026-01-02',
      direction: 'incoming',
      executionState: 'review',
    },
  ] as unknown as RemoteTaskInvite[];
  data.network.brainTasks = [
    {
      id: 'brain',
      executionID: 'current',
      status: 'review',
      title: 'Brain',
      updatedAt: '2026-01-02',
    },
  ] as BrainTask[];
  assert.deepEqual(
    collectAttention(data).events.map((i) => i.conversationKey),
    ['brain:brain'],
  );
  assert.equal(collectAttention(data).items.length, 0);
  assert.equal(collectAttention(data).events[0].kind, 'completed');
  data.tasks = [];
  data.network.brainTasks[0].status = 'queued';
  data.network.brainTasks[0].executionID = null;
  assert.equal(collectAttention(data).items.length, 0);
});
test('remote controls require owning operator and real request IDs', () => {
  const data = fixture();
  data.network.remoteTasks = [
    {
      id: 'remote',
      brainTaskID: null,
      direction: 'outgoing',
      title: 'Remote',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      executionState: 'waiting_approval',
      status: 'accepted',
      remoteApprovals: [{ id: 'permission' }],
    },
  ] as RemoteTaskInvite[];
  assert.equal(collectAttention(data).items[0].kind, 'approval');
  data.user.owner = false;
  assert.equal(collectAttention(data).items.length, 0);
});
test('notification baseline, polling, mute, restart and phase transitions preserve deduplication', () => {
  const db = new DatabaseSync(':memory:');
  const store = new TaskAttentionStore(db, () => 1000);
  const data = fixture([task('running')]);
  assert.equal(store.check(data).notifications.length, 0);
  data.tasks[0].state = 'review';
  assert.equal(store.check(data).notifications.length, 1);
  data.tasks[0].version = 15;
  data.tasks[0].updatedAt = '2026-09-06T00:30:00Z';
  assert.equal(store.check(data).notifications.length, 0);
  assert.equal(new TaskAttentionStore(db).check(data).notifications.length, 0);
  data.tasks[0].state = 'running';
  store.check(data);
  data.tasks[0].state = 'review';
  assert.equal(store.check(data).notifications.length, 1);
  store.savePreferences('owner', { enabled: true, quietUntil: 2000 });
  data.tasks[0].state = 'accepted';
  assert.equal(store.check(data).notifications.length, 0);
  assert.equal(store.check(data).items.length, 0);
  store.savePreferences('owner', { enabled: true, quietUntil: null });
  assert.equal(store.check(data).notifications.length, 0);
  data.user.id = 'other';
  assert.equal(store.preferences('other').quietUntil, null);
  assert.equal(store.check(data).notifications.length, 0);
  db.close();
});
test('a new permission request notifies once without waiting for a different task state', () => {
  const db = new DatabaseSync(':memory:');
  const store = new TaskAttentionStore(db);
  const data = fixture([
    task('waiting_approval', { approvals: [{ id: 'a' } as Task['approvals'][number]] }),
  ]);
  store.check(data);
  data.tasks[0].approvals = [{ id: 'b' } as Task['approvals'][number]];
  assert.equal(store.check(data).notifications.length, 1);
  assert.equal(store.check(data).notifications.length, 0);
  db.close();
});

test('each completed conversation round notifies once while archived execution records stay suppressed', () => {
  const db = new DatabaseSync(':memory:'), store = new TaskAttentionStore(db);
  const data = fixture([task('accepted', { id: 'archived' })]);
  data.workflows = [{ id: 'w', requestID: 'first', creatorID: 'owner', state: 'completed', title: 'Continuity',
    planner: { attempts: [], state: 'completed' }, steps: [], rounds: [{ requestID: 'first',
      planner: { state: 'completed', attempts: [{ executionID: 'archived', kind: 'local', phase: 'completed' }] }, steps: [] }] }] as unknown as Bootstrap['workflows'];
  assert.deepEqual(collectAttention(data).events.map((e) => e.conversationKey), ['workflow:w']);
  store.check(data);
  data.workflows![0].roundRequestID = 'second';
  assert.equal(store.check(data).notifications.length, 1);
  assert.equal(new TaskAttentionStore(db).check(data).notifications.length, 0);
  db.close();
});
