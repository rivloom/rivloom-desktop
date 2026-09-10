// Complete owned services with the official engine and a loopback-only model.
// Does not invoke a desktop installer or read the installed application's data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Task } from '../shared/types.ts';

const root = resolve('.data', 'desktop-update-service', `${Date.now()}-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const fixture = await modelFixture();
const client = new ServiceClient(join(root, 'application'));
const assertions: string[] = [];
const pass = (value: string) => { assertions.push(value); console.log('PASS', value); };
let status = 'failed';
try {
  fixture.configure(client.root); loadNodeIdentity(client.root);
  await client.start({ logPath: join(root, 'service.log') });
  const tokenHeader = () => ({ 'X-Rivloom-Desktop-Token': readFileSync(join(client.root, 'desktop-auth-token.txt'), 'utf8').trim() });
  const native = (path: string, body: unknown, status = 200) => client.call(`/desktop-update/${path}`, body, status, tokenHeader());
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403);
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403, { 'X-Rivloom-Desktop-Token': 'invalid' });
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403, { ...tokenHeader(), Origin: 'https://evil.example' });
  pass('A browser session, incorrect native token and foreign origin cannot start update maintenance');
  const prepared = await native('prepare', { version: '0.1.6' });
  assert.equal(prepared.ready, true); assert(prepared.lease);
  await native('prepare', { version: '0.1.6' }, 409);
  await client.call('/network/execution-concurrency', { maxConcurrent: 4 }, 503);
  await native('cancel', { lease: randomUUID() }, 409);
  await native('cancel', { lease: prepared.lease });
  await client.call('/network/execution-concurrency', { maxConcurrent: 4 });
  await native('commit', { lease: prepared.lease }, 409);
  pass('Preparation fences writes, rejects duplicate or stale callers and cancellation restores the original service');
  const initial = await client.bootstrap(); const owner = initial.user.id;
  const directory = join(root, 'project'); mkdirSync(directory);
  const project = await client.call('/projects', { name: 'Updater fixture project', directory, trusted: true }, 201);
  const task = await client.call<Task>('/tasks', { requestID: randomUUID(), runRequested: true,
    projectID: project.id, title: 'UPDATE_LOCAL_FIXTURE', description: 'Reply briefly. Do not use tools.', criteria: 'Return a response.',
    assigneeID: owner, approverID: owner, reviewerID: owner, model: 'fixture/m34', approvalMode: 'ask' }, 201);
  await until(async () => fixture.pendingRequests, (value) => value > 0, 'loopback model request');
  const blocked = await native('prepare', { version: '0.1.6' });
  assert.equal(blocked.ready, false); assert(blocked.blockers.tasks > 0); assert.equal(blocked.lease, null);
  await client.call('/network/execution-concurrency', { maxConcurrent: 5 });
  assert.equal((await client.bootstrap()).tasks.find((t) => t.id === task.id)?.state, 'running');
  pass('Active official-engine execution blocks installation without stopping its task, and failed preparation releases intake');
  await client.call(`/tasks/${task.id}/stop`, {});
  await until(() => client.bootstrap(), (b) => b.tasks.find((t) => t.id === task.id)?.state === 'stopped', 'controlled task stop');
  const session = (await client.bootstrap()).tasks.find((t) => t.id === task.id)!.sessionID;
  assert(session);
  const final = await until(() => native('prepare', { version: '0.1.6' }), (value) => value.ready, 'safe update readiness');
  const identity = (await client.network()).local!.id;
  const exit = new Promise<number | null>((done) => client.child!.once('exit', done));
  await native('commit', { lease: final.lease });
  assert.equal(await exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(client.root, 'update-shutdown.json'), 'utf8')), { lease: final.lease, version: '0.1.6', closed: true });
  assert.equal(existsSync(join(client.root, 'desktop-auth-token.txt')), false);
  const database = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); database.close();
  pass('Commit waits for the owned service and engine, closes SQLite cleanly and leaves the exact lease shutdown receipt');
  fixture.release();
  await client.start({ logPath: join(root, 'restart.log') });
  const restored = await client.bootstrap();
  assert.equal(restored.executionPolicy.maxConcurrent, 5);
  assert.equal((await client.network()).local!.id, identity);
  assert.equal(restored.projects.find((p) => p.id === project.id)?.directory, directory);
  assert.equal(restored.tasks.find((t) => t.id === task.id)?.sessionID, session);
  assert.equal(restored.tasks.find((t) => t.id === task.id)?.state, 'stopped');
  pass('Restart retains the same identity, project, task session and execution policy');
  status = 'passed';
} finally {
  fixture.release(); await client.stop(); await fixture.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify({ status, assertions, scope: 'isolated services; no installer; no external model' }, null, 2));
}
