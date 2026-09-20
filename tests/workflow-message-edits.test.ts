import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import type { WorkflowRuntime } from '../server/workflow-runtime.ts';
import type { NodeNetwork } from '../server/node-network.ts';
import { validWorkflowMessageEdit, workflowPendingMessages } from '../shared/workflows.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { WorkflowService, type WorkflowExecutionAdapter } from '../server/workflow-service.ts';
import { listenHttp } from '../server/http-ports.ts';

function setup() {
  const db = new DatabaseSync(':memory:'), store = new WorkflowStore(db);
  const sideEffects: string[] = [];
  const adapter: WorkflowExecutionAdapter = {
    candidates: () => [], evidence: () => '', lookup: async () => { sideEffects.push('lookup'); return null; },
    dispatch: async () => { sideEffects.push('dispatch'); return { state: 'accepted' }; },
    stop: async () => { sideEffects.push('stop'); return 'stopped'; }, query: async () => { sideEffects.push('query'); return []; },
    materialize: async () => { sideEffects.push('materialize'); return []; }, stageInputs: async (_value, _key, files) => files,
  };
  const service = new WorkflowService(store, adapter);
  const value = service.create({ requestID: randomUUID(), creatorID: 'owner', title: 'Original task', description: 'Keep original request',
    projectID: null, model: null, approvalMode: 'ask', target: { mode: 'automatic' }, inputFiles: [] });
  const id = value.id;
  return { db, store, adapter, service, id, sideEffects, async close() { await service.close(); db.close(); } };
}

test('editing changes only queued text and keeps identity, files, ordering, pause state and current work', async () => {
  const f = setup();
  try {
    const requestID = randomUUID(), later = randomUUID();
    const file = { id: randomUUID(), name: 'keep.txt', bytes: 8, sha256: 'a'.repeat(64), mime: 'application/octet-stream' };
    f.service.enqueue(f.id, requestID, 'Original queued message', [file]); f.service.enqueue(f.id, later, 'Later queued message', []);
    f.service.messageControl(f.id, 'pause'); const before = f.store.get(f.id)!;
    const after = f.service.editMessage(f.id, { requestID, expectedText: 'Original queued message', text: '  Updated request\nwith formatting.  ' });
    assert.deepEqual(after.messages![0], { ...before.messages![0], text: '  Updated request\nwith formatting.  ' });
    assert.deepEqual(after.messages![1], before.messages![1]); assert.equal(after.queuePaused, true);
    for (const key of ['requestID', 'description', 'state', 'planner', 'steps', 'rounds', 'inputFiles', 'target', 'approvalMode', 'projectID', 'model'] as const)
      assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(f.sideEffects, []);
    assert.equal(new WorkflowStore(f.db).get(f.id)!.messages![0].text, after.messages![0].text);
  } finally { await f.close(); }
});

test('a stale editor cannot overwrite another edit, cancellation, current execution or archived execution', async () => {
  const f = setup();
  try {
    const requestID = randomUUID(); f.service.enqueue(f.id, requestID, 'Original', []);
    const request = { requestID, expectedText: 'Original', text: 'Edited elsewhere' };
    f.service.editMessage(f.id, request); const afterEdit = f.store.get(f.id)!;
    assert.throws(() => f.service.editMessage(f.id, { ...request, text: 'Stale overwrite' }), /workflow_message_edit_conflict/);
    assert.deepEqual(f.store.get(f.id), afterEdit);
    f.service.messageControl(f.id, 'cancel', requestID); const cancelled = f.store.get(f.id)!;
    assert.throws(() => f.service.editMessage(f.id, { ...request, expectedText: request.text }), /workflow_message_not_queued/);
    assert.deepEqual(f.store.get(f.id), cancelled);
    const current = randomUUID(); f.service.enqueue(f.id, current, 'Now running', []);
    f.store.update(f.id, value => { value.roundRequestID = current; });
    assert.throws(() => f.service.editMessage(f.id, { requestID: current, expectedText: 'Now running', text: 'Too late' }), /workflow_message_not_queued/);
    f.store.update(f.id, value => { value.rounds = [{ ...value, requestID: current }]; value.roundRequestID = randomUUID(); });
    assert.throws(() => f.service.editMessage(f.id, { requestID: current, expectedText: 'Now running', text: 'Too late' }), /workflow_message_not_queued/);
    assert.throws(() => f.service.editMessage(f.id, { requestID: randomUUID(), expectedText: 'Missing', text: 'Unknown' }), /workflow_message_not_queued/);
    assert.deepEqual(f.sideEffects, []);
  } finally { await f.close(); }
});

test('editing while async round context is being prepared cannot admit stale text', async () => {
  const f = setup();
  try {
    f.store.update(f.id, value => { value.state = 'completed'; });
    const requestID = randomUUID(); f.service.enqueue(f.id, requestID, 'Before edit', []);
    const context = { id: randomUUID(), name: 'conversation.json', bytes: 2, sha256: 'a'.repeat(64), mime: 'application/octet-stream' };
    let release!: () => void;
    f.adapter.conversationContext = () => new Promise(resolve => { release = () => resolve(context); });
    const preparing = f.service.advance(f.id);
    assert.equal(typeof release, 'function');
    f.service.editMessage(f.id, { requestID, expectedText: 'Before edit', text: 'Use the new request' });
    release(); await preparing;
    let value = f.store.get(f.id)!;
    assert.equal(value.roundRequestID, undefined); assert.equal(value.rounds, undefined);
    assert.equal(value.queuePaused, undefined); assert.equal(value.queueError, undefined);
    assert.equal(workflowPendingMessages(value)[0].text, 'Use the new request');
    f.adapter.conversationContext = async () => context;
    await f.service.advance(f.id); value = f.store.get(f.id)!;
    assert.equal(value.roundRequestID, requestID); assert.equal(value.description, 'Use the new request');
    assert.equal(value.planner.instructions, 'Use the new request');
    assert.equal(value.rounds!.length, 1); assert.equal(value.rounds![0].description, 'Keep original request');
    assert.throws(() => f.service.editMessage(f.id, { requestID, expectedText: 'Use the new request', text: 'Already admitted' }), /workflow_message_not_queued/);
    assert.deepEqual(f.sideEffects, []);
  } finally { await f.close(); }
});

test('unrelated workflow updates do not block a current message edit, and edits never resume paused queues', async () => {
  const f = setup();
  try {
    const requestID = randomUUID(); f.service.enqueue(f.id, requestID, 'Original', []);
    f.service.messageControl(f.id, 'pause');
    f.store.update(f.id, value => { value.state = 'completed'; value.summary = 'A concurrent current-round progress update'; });
    f.service.editMessage(f.id, { requestID, expectedText: 'Original', text: 'Edited while current work updates' });
    await f.service.advance(f.id);
    const value = f.store.get(f.id)!; assert.equal(value.queuePaused, true); assert.equal(value.roundRequestID, undefined);
    assert.equal(value.summary, 'A concurrent current-round progress update'); assert.deepEqual(f.sideEffects, []);
  } finally { await f.close(); }
});

test('message edits enforce bounded exact input, reject authority fields and cannot revive retired conversations', async () => {
  const f = setup();
  try {
    const requestID = randomUUID(); f.service.enqueue(f.id, requestID, 'Original', []);
    const valid = { requestID, expectedText: 'Original', text: '🙂'.repeat(6000) };
    assert(validWorkflowMessageEdit(valid)); f.service.editMessage(f.id, valid);
    const after = f.store.get(f.id)!;
    for (const request of [{ ...valid, text: 'x'.repeat(12001) }, { ...valid, text: ' \n ' }, { ...valid, text: 'a\0b' },
      { ...valid, expectedText: '' }, { ...valid, expectedText: 'x'.repeat(12001) }, { ...valid, requestID: '../escape' },
      { ...valid, inputFiles: [] }, { ...valid, approvalMode: 'full' }]) {
      assert.equal(validWorkflowMessageEdit(request), false);
      assert.throws(() => f.service.editMessage(f.id, request), /workflow_message_edit_invalid/);
      assert.deepEqual(f.store.get(f.id), after);
    }
    f.db.prepare('INSERT INTO conversation_retired(kind,id,conversation_key) VALUES (?,?,?)').run('workflow', f.id, `workflow:${f.id}`);
    assert.throws(() => f.service.editMessage(f.id, { requestID, expectedText: valid.text, text: 'Revive' }), /回收站|删除/);
    assert.deepEqual(f.store.get(f.id), after);
  } finally { await f.close(); }
});

test('the real workflow HTTP route fences other accounts and authority fields without scheduling execution', async () => {
  // workflow-api imports the application store. Isolate that import before it can
  // open any database, even when this test runs from a real developer checkout.
  const previousDataRoot = process.env.RIVLOOM_DATA_DIR;
  process.env.RIVLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), 'rivloom-message-edit-api-'));
  const { installWorkflowAPI } = await import('../server/workflow-api.ts');
  const applicationStore = await import('../server/store.ts');
  if (previousDataRoot === undefined) delete process.env.RIVLOOM_DATA_DIR; else process.env.RIVLOOM_DATA_DIR = previousDataRoot;
  const f = setup(), app = express(); app.use(express.json());
  app.use((req, res, next) => { if (!req.headers['x-test-user']) { res.status(401).json({ error: 'unauthorized' }); return; } next(); });
  let kicks = 0;
  installWorkflowAPI(app, { store: f.store, service: f.service, kick: () => { kicks++; } } as unknown as WorkflowRuntime,
    { files: { uploaded: () => [] } } as unknown as NodeNetwork, req => ({ id: String(req.headers['x-test-user']), name: 'Fixture', username: 'fixture', owner: false }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status || (error.name === 'ZodError' ? 400 : 500)).json({ error: error.message }); };
  app.use(errors);
  const server = createServer(app);
  try {
    await listenHttp(server, '127.0.0.1');
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/workflows/${f.id}/messages/edit`;
    const requestID = randomUUID(); f.service.enqueue(f.id, requestID, 'Before', []);
    const body = { requestID, expectedText: 'Before', text: 'After' };
    async function send(user: string, request: unknown = body) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await send('')).status, 401); assert.equal((await send('another-account')).status, 404);
    assert.equal((await send('owner', { ...body, attachmentIDs: [] })).status, 400);
    assert.equal((await send('owner', { ...body, action: 'resume', approvalMode: 'full' })).status, 400);
    assert.equal(f.store.get(f.id)!.messages![0].text, 'Before');
    const saved = await send('owner'); assert.equal(saved.status, 200); assert.equal(saved.body.messages[0].text, 'After');
    assert.deepEqual(await send('owner'), { status: 409, body: { error: 'workflow_message_edit_conflict' } });
    f.service.messageControl(f.id, 'cancel', requestID);
    assert.deepEqual(await send('owner', { ...body, expectedText: 'After' }), { status: 409, body: { error: 'workflow_message_not_queued' } });
    assert.equal(kicks, 0); assert.deepEqual(f.sideEffects, []);
    const enqueueURL = url.replace(/\/edit$/, '');
    const next = { requestID: randomUUID(), text: 'Use this next model', model: 'fixture/org/model' };
    const enqueue = async (user: string, payload: unknown) => {
      const response = await fetch(enqueueURL, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-test-user': user,
      }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await enqueue('another-account', next)).status, 404);
    assert.equal((await enqueue('owner', { ...next, model: 'invalid' })).status, 400);
    const originalModel = f.store.get(f.id)!.model;
    const pending = await enqueue('owner', next);
    assert.equal(pending.status, 201);
    assert.equal(pending.body.messages.at(-1).model, next.model, 'HTTP schema forwards exact selected model');
    assert.equal(pending.body.model, originalModel, 'acceptance cannot change the active round');
    assert.equal((await enqueue('owner', next)).status, 201);
    assert.equal((await enqueue('owner', { ...next, model: 'fixture/another' })).status, 409);
    const legacy = await enqueue('owner', { requestID: randomUUID(), text: 'Legacy no model' });
    assert.equal(legacy.status, 201);
    assert.equal(Object.hasOwn(legacy.body.messages.at(-1), 'model'), false);
    assert.deepEqual(f.sideEffects, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); applicationStore.db.close();
  }
});
