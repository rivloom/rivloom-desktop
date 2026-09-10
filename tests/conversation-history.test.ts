import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ConversationHistory, type HistoryData } from '../server/conversation-history.ts';
import { conversations } from '../shared/conversations.ts';
import { groupConversationHistory, historyCanTrash, historyExpiry, historyMembers } from '../shared/conversation-history.ts';
import { TaskFileStore } from '../server/task-files.ts';
import { TaskQueries } from '../server/task-queries.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { CreationRequestStore } from '../server/creation-requests.ts';
import { RemoteTaskStore, validRemoteTaskOffer } from '../server/remote-tasks.ts';
import { BrainTaskStore, validBrainTaskSubmission } from '../server/brain-tasks.ts';
import { NodeQueueStore } from '../server/node-queue.ts';
import type { Task, RemoteTaskInvite } from '../shared/types.ts';
import type { Workflow } from '../shared/workflows.ts';
import type { NodeQueueEntry } from '../shared/node-queue.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';

const at = '2026-09-10T01:00:00.000Z';
function local(id = randomUUID(), state: Task['state'] = 'accepted'): Task {
  return { id, state, title: 'Private conversation', description: 'Private request', projectID: 'p', createdAt: at, updatedAt: at } as Task;
}
function data(): HistoryData {
  return { tasks: [local()], projects: [{ id: 'p', directory: 'C:\\work\\one', name: 'one' }], workflows: [],
    network: { local: { id: 'node' }, remoteTasks: [], brainTasks: [], nearby: [] } } as unknown as HistoryData;
}
function root() { const path = resolve('.data/unit-conversation-history', randomUUID()); mkdirSync(path, { recursive: true }); return path; }

test('three-calendar-month retention clamps month ends and preserves UTC time', () => {
  assert.equal(historyExpiry('2026-11-30T23:01:02.123Z'), '2027-02-28T23:01:02.123Z');
  assert.equal(historyExpiry('2027-11-30T23:01:02.123Z'), '2028-02-29T23:01:02.123Z');
  assert.equal(historyExpiry('2026-08-31T10:00:00Z'), '2026-11-30T10:00:00.000Z');
  assert.equal(historyExpiry(at), '2026-12-10T01:00:00.000Z');
});
test('trash survives restart, restores original identity, and expires at the exact boundary', () => {
  const path = join(root(), 'history.sqlite'), input = data(), key = `local:${input.tasks[0].id}`;
  let time = Date.parse(at), purges = 0;
  const options = { data: () => input, queue: () => [], busy: () => false, clock: () => time,
    purge: () => { purges++; input.tasks = []; } };
  let db = new DatabaseSync(path), history = new ConversationHistory(db, options);
  history.trash(key, input); assert.equal(history.filter(input).tasks.length, 0); assert.equal(input.tasks.length, 1);
  db.close(); db = new DatabaseSync(path); history = new ConversationHistory(db, options);
  assert.equal(history.list()[0].key, key);
  history.restore(key); assert.equal(history.filter(input).tasks[0].id, key.slice(6));
  assert.equal(history.retired('local', key.slice(6)), false);
  history.trash(key, input); time = Date.parse(history.list()[0].expiresAt) - 1;
  assert.equal(history.sweep().deleted, 0); time++;
  assert.equal(history.sweep().deleted, 1); assert.equal(purges, 1); assert.deepEqual(history.list(), []);
  assert.equal(history.retired('local', key.slice(6), true), true);
  assert.throws(() => history.assertAvailable('local', key.slice(6)), { status: 410 }); db.close();
});
test('trash rejects active and uncertain work, including queue entries and old workflow attempts', () => {
  const input = data();
  for (const state of ['running', 'waiting_input', 'waiting_approval', 'stopping', 'interrupted', 'review'] as const) {
    input.tasks[0].state = state; assert.equal(historyCanTrash(conversations(input)[0], input), false, state);
  }
  input.tasks[0].state = 'accepted'; const item = conversations(input)[0];
  const queue = [{ state: 'waiting', localTaskID: item.localTask!.id, source: { kind: 'local', taskID: item.localTask!.id } }] as NodeQueueEntry[];
  assert.equal(historyCanTrash(item, input, queue), false);
  const workflow = { id: 'w', state: 'completed', title: 'Workflow', description: '', createdAt: at, updatedAt: at,
    planner: { attempts: [{ executionID: 'old', kind: 'remote', phase: 'unknown' }] }, steps: [] } as unknown as Workflow;
  input.workflows = [workflow]; assert.equal(historyCanTrash(conversations(input).find((v) => v.workflow)!, input), false);
});
test('complete workflow membership includes child tasks, retry attempts, and creation replay identity', () => {
  const input = data(); const child = input.tasks[0];
  child.collaboration = { workflowID: 'w' } as Task['collaboration'];
  input.network.remoteTasks = [{ id: 'remote-try', localTaskID: child.id, direction: 'outgoing', createdAt: at, updatedAt: at }] as RemoteTaskInvite[];
  input.workflows = [{ id: 'w', creatorID: 'u', requestID: 'request', state: 'completed', title: 'Workflow', description: '', createdAt: at, updatedAt: at,
    planner: { attempts: [{ executionID: 'local-try', kind: 'local', phase: 'completed' }] },
    steps: [{ attempts: [{ executionID: 'remote-try', kind: 'remote', phase: 'completed' }] }] }] as unknown as Workflow[];
  const workflow = conversations(input).find((v) => v.workflow)!;
  assert.deepEqual(historyMembers(workflow, input), { local: ['local-try', child.id], remote: ['remote-try'], brain: [], workflow: ['w'], requests: ['u:request'] });
});
test('failed purge is journaled, cannot restore, and safely retries without losing other conversations', () => {
  const input = data(), key = `local:${input.tasks[0].id}`, db = new DatabaseSync(':memory:'); let fail = true;
  const other = local(); input.tasks.push(other);
  const history = new ConversationHistory(db, { data: () => input, queue: () => [], busy: () => false,
    purge: (members) => { if (fail) throw new Error('disk'); input.tasks = input.tasks.filter((v) => !members.local.includes(v.id)); } });
  history.trash(key, input); assert.deepEqual(history.sweep(false), { deleted: 0, failed: [key] });
  assert.equal(history.list()[0].purging, true); assert.throws(() => history.restore(key), { status: 409 });
  fail = false; assert.equal(history.sweep().deleted, 1); assert.deepEqual(input.tasks, [other]); db.close();
});
test('working directory groups preserve recency and separate ambiguous remote projects', () => {
  const input = data(), second = local(); second.projectID = 'p2'; input.tasks.push(second);
  input.projects.push({ id: 'p2', name: 'same path', directory: 'c:/work/one/', createdAt: at });
  const groups = groupConversationHistory(conversations(input), input); assert.equal(groups.length, 1); assert.equal(groups[0].items.length, 2);
  second.projectID = 'missing'; assert.equal(groupConversationHistory(conversations(input), input).length, 2);
  input.tasks = [];
  input.network.remoteTasks = ['peer-a', 'peer-b'].map((targetNodeID, i) => ({ id: String(i), direction: 'outgoing',
    requestedProjectID: 'same-id', targetNodeID, createdAt: at, updatedAt: at })) as RemoteTaskInvite[];
  assert.equal(groupConversationHistory(conversations(input), input).length, 2);
});
test('attachment purge preserves shared blobs and project originals, removes only unused app copies', async () => {
  const folder = root(), store = new TaskFileStore(folder), body = 'original-project-data';
  const file: TaskFileDescriptor = { id: randomUUID(), name: 'source.txt', bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), mime: 'application/octet-stream' };
  store.beginUpload('u', file); store.uploadChunk('u', file.id, 0, Buffer.from(body).toString('base64'));
  const first = randomUUID(), second = randomUUID();
  store.bindUploaded({ scope: 'local', taskID: first, purpose: 'input' }, 'u', [file.id]);
  store.bindUploaded({ scope: 'local', taskID: second, purpose: 'input' }, 'u', [file.id]);
  const original = join(folder, 'project-original.txt'); writeFileSync(original, body);
  const received = await store.location(file.id);
  store.purgeHistory({ local: [first], remote: [], brain: [] }, [file.id], new Set());
  assert.equal(store.descriptorFor(file.id).id, file.id); assert.equal(existsSync(received.path), true);
  store.purgeHistory({ local: [second], remote: [], brain: [] }, [file.id], new Set());
  assert.throws(() => store.descriptorFor(file.id), { status: 404 }); assert.equal(existsSync(received.path), false);
  assert.equal(readFileSync(original, 'utf8'), body); store.close();
});
test('purged local and workflow creation requests cannot resurrect and task numbers never repeat', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,number INTEGER,body TEXT)');
  const queries = new TaskQueries(db); db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('one', 7, JSON.stringify({ state: 'accepted' }));
  db.exec('DELETE FROM tasks'); assert.equal(queries.nextNumber(), 8);
  const requests = new CreationRequestStore(db), requestID = randomUUID(), id = requests.reserve('u', requestID, { title: 'secret' });
  db.prepare('INSERT INTO conversation_retired VALUES (?,?,?,1)').run('local', id, `local:${id}`);
  assert.throws(() => requests.reserve('u', requestID, { title: 'secret' }), { status: 410 });
  const workflows = new WorkflowStore(db), workflowRequestID = randomUUID();
  db.prepare('INSERT INTO conversation_retired VALUES (?,?,?,1)').run('requests', `u:${workflowRequestID}`, 'workflow:deleted');
  assert.throws(() => workflows.create({ requestID: workflowRequestID, creatorID: 'u' } as Parameters<WorkflowStore['create']>[0]), { status: 410 });
  db.close();
});
test('purged remote and Brain stores erase bodies and reject replayed offers after restart', () => {
  const folder = root(), receiverRoot = join(folder, 'receiver');
  const sender = new RemoteTaskStore(folder); let receiver = new RemoteTaskStore(receiverRoot);
  const remote = sender.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), { title: 'private remote', description: 'private remote body', criteria: 'done' });
  const offer = sender.message(remote.id); assert(validRemoteTaskOffer(offer)); receiver.receiveOffer(offer);
  receiver.purge([remote.id]); assert(!readFileSync(join(receiverRoot, 'remote-task-invites.json'), 'utf8').includes('private remote'));
  receiver = new RemoteTaskStore(receiverRoot); receiver.retired = (id) => id === remote.id; receiver.load();
  assert.throws(() => receiver.receiveOffer(offer), /conversation_retired/); assert.equal(receiver.list().length, 0);
  const submitter = new BrainTaskStore(folder); let master = new BrainTaskStore(receiverRoot);
  const brain = submitter.create('submitted', 'A'.repeat(32), randomUUID(), 'B'.repeat(32), {
    title: 'private brain', description: 'private brain body', criteria: 'done', requestedProjectID: null, requirements: {} });
  const submission = submitter.message(brain.id); assert(validBrainTaskSubmission(submission)); master.receiveSubmission(submission);
  master.purge([brain.id]); assert(!readFileSync(join(receiverRoot, 'brain-tasks.json'), 'utf8').includes('private brain'));
  master = new BrainTaskStore(receiverRoot); master.retired = (id) => id === brain.id; master.load();
  assert.throws(() => master.receiveSubmission(submission), /conversation_retired/); assert.equal(master.list().length, 0);
});
test('purge removes queue operation text but retains a minimal replay fence', () => {
  const db = new DatabaseSync(':memory:'), queue = new NodeQueueStore(db), taskID = randomUUID();
  const entry = queue.enqueue({ kind: 'local', taskID }), operation = { operationID: randomUUID(), itemID: entry.id,
    expectedVersion: entry.version, action: 'reject' as const, reason: 'private queue explanation' };
  queue.control(operation); queue.purgeHistory({ local: [taskID], remote: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM node_queue_operations').get()?.count, 0);
  assert.throws(() => queue.control(operation), { status: 410 }); db.close();
});
