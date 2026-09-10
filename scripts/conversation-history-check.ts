// Uses only isolated application data and an official engine with a loopback model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Task } from '../shared/types.ts';
import type { Workflow } from '../shared/workflows.ts';

const root = resolve('.data/conversation-history-service', `${Date.now()}-${randomUUID()}`); mkdirSync(root, { recursive: true });
const fixture = await modelFixture(); const client = new ServiceClient(join(root, 'application'));
const assertions: string[] = []; const pass = (value: string) => { assertions.push(value); console.log('PASS', value); };
let status = 'failed';
try {
  fixture.configure(client.root); loadNodeIdentity(client.root);
  await client.start({ logPath: join(root, 'service.log') });
  const initial = await client.bootstrap(), owner = initial.user.id;
  const directory = join(root, 'project'); mkdirSync(directory); const original = join(directory, 'keep.txt'); writeFileSync(original, 'keep original');
  const project = await client.call('/projects', { name: 'History fixture directory', directory, trusted: true }, 201);
  const request = { requestID: randomUUID(), runRequested: false, projectID: project.id, title: 'HISTORY_PRIVATE_TITLE', description: 'HISTORY_PRIVATE_BODY',
    criteria: 'Return a response.', assigneeID: owner, approverID: owner, reviewerID: owner, model: 'fixture/m34', approvalMode: 'ask' };
  const task = await client.call<Task>('/tasks', request, 201), key = `local:${task.id}`;
  const invitation = await client.call('/invitations', {}); const member = new ServiceClient(client.root); member.base = client.base;
  await member.call('/auth/join', { code: invitation.code, username: 'history_member', name: 'History fixture member', password: `fixture-${randomUUID()}` });
  for (const [path, body] of [['trash', { key }], ['restore', { key }], ['purge', { key, confirmed: true }], ['empty', { confirmed: true }]] as const)
    await member.call(`/history/${path}`, body, 403);
  await client.call('/history/trash', { key }, 403, { Origin: 'https://untrusted.example' });
  await client.call('/history/trash', { key: 'local:missing' }, 404);
  pass('Recycle-bin writes enforce workspace owner, origin, and visible conversation identity');
  const removed = await client.call('/history/trash', { key }); assert.equal(removed.directory, directory);
  const hidden = await client.bootstrap(); assert(!hidden.tasks.some((v) => v.id === task.id)); assert.equal(hidden.conversationTrash?.[0].key, key);
  await client.call(`/tasks/${task.id}/run`, {}, 410); await client.call('/tasks', request, 410);
  await client.stop(); await client.start({ logPath: join(root, 'restart.log') });
  assert.equal((await client.bootstrap()).conversationTrash?.[0].key, key);
  await client.call('/history/restore', { key }); const restored = (await client.bootstrap()).tasks.find((v) => v.id === task.id)!;
  assert.deepEqual(restored, task);
  pass('Trash hides history, blocks execution and request replay, and restores the exact conversation after restart');
  const running = await client.call<Task>('/tasks', { ...request, requestID: randomUUID(), runRequested: true, title: 'HISTORY_RUNNING' }, 201);
  await until(async () => fixture.pendingRequests, (value) => value > 0, 'loopback model request');
  await client.call('/history/trash', { key: `local:${running.id}` }, 409);
  await client.call(`/tasks/${running.id}/stop`, {});
  await until(() => client.bootstrap(), (b) => b.tasks.find((v) => v.id === running.id)?.state === 'stopped', 'task stopped');
  await until(() => client.call('/history/trash', { key: `local:${running.id}` }), () => true, 'settled task can enter recycle bin');
  pass('Running official-engine work cannot be deleted; explicitly stopped work can enter the recycle bin');
  await client.call('/history/trash', { key });
  await client.call('/history/purge', { key }, 400); await client.call('/history/purge', { key, confirmed: true });
  await client.call('/history/restore', { key }, 404); await client.call('/tasks', request, 410);
  const next = await client.call<Task>('/tasks', { ...request, requestID: randomUUID(), title: 'KEEP_VISIBLE' }, 201); assert(next.number > running.number);
  await client.call('/history/empty', { confirmed: true });
  assert.equal((await client.bootstrap()).conversationTrash?.length, 0); assert((await client.bootstrap()).tasks.some((v) => v.id === next.id));
  const db = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  assert.equal(db.prepare('SELECT 1 FROM tasks WHERE id=?').get(task.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM activities WHERE task_id=?').get(task.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM task_engine_intents WHERE task_id=?').get(running.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM node_queue WHERE local_task_id=?').get(running.id), undefined);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
  db.close(); assert.equal(readFileSync(original, 'utf8'), 'keep original');
  pass('Manual and bulk purge remove live SQL bodies, activities, engine bindings and ended queues while retaining unrelated history, project originals and monotonic numbering');
  const workflowRequest = { requestID: randomUUID(), title: 'HISTORY_WORKFLOW', description: 'History workflow fixture', projectID: project.id,
    model: 'fixture/m34', approvalMode: 'ask', target: { mode: 'automatic' } };
  const workflow = await client.call<Workflow>('/workflows', workflowRequest, 201);
  await client.call(`/workflows/${workflow.id}/control`, { action: 'stop' });
  await until(() => client.bootstrap(), (b) => b.workflows?.find((v) => v.id === workflow.id)?.state === 'stopped', 'workflow stopped');
  const workflowKey = `workflow:${workflow.id}`;
  await until(() => client.call('/history/trash', { key: workflowKey }), () => true, 'workflow settled');
  await client.call(`/workflows/${workflow.id}/control`, { action: 'resume' }, 410);
  await client.call('/history/purge', { key: workflowKey, confirmed: true });
  await client.call('/workflows', workflowRequest, 409); // Workflow API preserves its conflict response contract.
  pass('Stopped workflows enter the same recycle bin and neither resume nor creation retries can recreate purged workflows');
  await client.call('/history/trash', { key: `local:${next.id}` }); await client.stop();
  const stale = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  const row = stale.prepare('SELECT body FROM conversation_trash WHERE key=?').get(`local:${next.id}`)!;
  const entry = JSON.parse(String(row.body)); entry.expiresAt = '2000-01-01T00:00:00.000Z';
  stale.prepare('UPDATE conversation_trash SET body=? WHERE key=?').run(JSON.stringify(entry), entry.key); stale.close();
  await client.start({ logPath: join(root, 'expiry-restart.log') });
  await until(() => client.bootstrap(), (b) => !b.conversationTrash?.length, 'startup expires old trash');
  const afterExpiry = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  assert.equal(afterExpiry.prepare('SELECT 1 FROM tasks WHERE id=?').get(next.id), undefined); afterExpiry.close();
  pass('Expired recycle-bin entries are permanently cleaned on next application startup');
  status = 'passed';
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  fixture.release(); await client.stop(); await fixture.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify({ status, assertions, scope: 'isolated services; loopback model; no installed app changes' }, null, 2));
  console.log('Report:', join(root, 'result.json'));
}
