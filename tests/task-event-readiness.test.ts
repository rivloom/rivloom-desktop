import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOpencodeClient, type Event } from '@opencode-ai/sdk/v2';
import type { Task, User } from '../shared/types.ts';
import type { EngineMessageRecord } from '../server/task-messages.ts';

test('real SDK waits for SSE readiness and recovers observation without repeating prompts', { timeout: 30_000 }, async context => {
  mkdirSync(resolve('.data/verification'), { recursive: true });
  const root = mkdtempSync(resolve('.data/verification/task-event-ready-'));
  type Connection = { scope: string; directory: string; response: ServerResponse; ready: boolean };
  const connections: Connection[] = [];
  const prompts: Array<{ scope: string; sessionID: string }> = [];
  let droppedReplies = 0;
  const messages = new Map<string, EngineMessageRecord[]>();
  const statuses: Record<string, { type: 'busy' | 'idle' }> = {};
  let nextRequest: ((connection: Connection) => void) | null = null;
  const request = () => new Promise<Connection>(resolve => { nextRequest = resolve; });
  const send = (connection: Connection, event: Event) => {
    connection.response.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const connect = (connection: Connection) => {
    connection.ready = true;
    send(connection, { id: randomUUID(), type: 'server.connected', properties: {} });
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    assert(url.pathname.endsWith('/event'), 'only the real SDK event endpoint uses HTTP');
    const connection = { scope: url.pathname.split('/')[1], directory: url.searchParams.get('directory')!, response: res, ready: false };
    connections.push(connection);
    const notify = nextRequest; nextRequest = null; notify?.(connection);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const engineScopes: string[] = [];
  function emitReply(scope: string, sessionID: string, directory: string) {
    const connection = connections.findLast(item => item.scope === scope && item.directory === directory && item.ready && !item.response.destroyed);
    // The engine cannot replay streamed deltas to a listener that has not yet
    // connected. Simulate that loss instead of buffering it in the fixture.
    if (!connection) { droppedReplies++; return; }
    const id = randomUUID(), time = Date.now();
    const info = { id, sessionID, role: 'assistant', time: { created: time }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as EngineMessageRecord['info'];
    const record: EngineMessageRecord = { info, parts: [] };
    messages.set(sessionID, [...(messages.get(sessionID) || []), record]);
    send(connection, { id: randomUUID(), type: 'message.updated', properties: { sessionID, info } });
    for (const type of ['text', 'reasoning'] as const) {
      const part = { id: randomUUID(), sessionID, messageID: id, type, text: '', time: { start: time } };
      record.parts.push(part);
      send(connection, { id: randomUUID(), type: 'message.part.updated', properties: { sessionID, part, time } });
      // Both one-chunk replies occur immediately inside prompt submission, before
      // any session poll can seed the display stream's message/part ownership.
      send(connection, { id: randomUUID(), type: 'message.part.delta', properties: {
        sessionID, messageID: id, partID: part.id, field: 'text', delta: 'Hello world!' } });
      part.text = 'Hello world!';
    }
  }
  function makeEngine() {
    const scope = `engine-${engineScopes.length}`;
    const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}/${scope}`, throwOnError: true });
    const engine = { scope, child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }), close() {}, async waitForExit() {},
      client: {
        event: sdk.event,
        provider: { list: async () => ({ data: { all: [], connected: [] } }) },
        session: {
          create: async () => ({ data: { id: randomUUID() } }),
          messages: async ({ sessionID }: { sessionID: string }) => ({ data: messages.get(sessionID) || [] }),
          status: async () => ({ data: statuses }),
          todo: async () => ({ data: [] }), diff: async () => ({ data: [] }),
          abort: async ({ sessionID }: { sessionID: string }) => { statuses[sessionID] = { type: 'idle' }; return {}; },
          promptAsync: async ({ sessionID, directory }: { sessionID: string; directory: string }) => {
            prompts.push({ scope, sessionID }); statuses[sessionID] = { type: 'busy' };
            emitReply(scope, sessionID, directory); return {};
          },
        },
        permission: { list: async () => ({ data: [] }) }, question: { list: async () => ({ data: [] }) },
        global: { dispose: async () => ({}) },
      },
    };
    engineScopes.push(scope); return engine;
  }
  const key = `event-readiness-${randomUUID()}`;
  Object.assign(globalThis, { [key]: makeEngine });
  const engineURL = new URL('../server/engine.ts', import.meta.url).href;
  const fixture = 'data:text/javascript,' + encodeURIComponent(
    `export const dataRoot=${JSON.stringify(root)}; export const engineRoot=${JSON.stringify(join(root, 'engine'))};
     export const ENGINE_VERSION='test'; export const sessionPermissions=()=>[]; export const startEngine=async()=>globalThis[${JSON.stringify(key)}]();`);
  const hook = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    return result.url === engineURL ? { url: fixture, shortCircuit: true } : result;
  } });
  const service = await import('../server/task-service.ts');
  const store = await import('../server/store.ts');
  const { providerAccounts } = await import('../server/account-engines.ts');
  const { readNodeModelActivity } = await import('../server/node-model-activity.ts');
  const owner: User = { id: randomUUID(), username: 'fixture', name: 'Fixture', owner: true };
  store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(owner.id, owner.username, owner.name, 1, 'unused');
  const projectID = randomUUID(), directory = join(root, 'project');
  store.saveProject({ id: projectID, name: 'Readiness fixture', directory, createdAt: new Date().toISOString() });
  const createTask = (model = 'fixture/model', separateProject = false) => {
    let targetProject = projectID;
    if (separateProject) {
      targetProject = randomUUID();
      store.saveProject({ id: targetProject, name: 'Isolated feed', directory: join(root, targetProject), createdAt: new Date().toISOString() });
    }
    const value: Task = { id: randomUUID(), number: store.taskQueries.nextNumber(), projectID: targetProject, model,
      title: 'Readiness', description: 'Fixture', criteria: 'Fixture', creatorID: owner.id, assigneeID: owner.id,
      approverID: owner.id, reviewerID: owner.id, acceptedBy: null, state: 'ready', version: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), approvalMode: 'ask', sessionID: null,
      runAfter: 0, messages: [], approvals: [], questions: [], artifacts: [], diffSource: '', error: null };
    store.saveTask(value); return value;
  };
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      assert(Date.now() < deadline, 'fixture condition timed out');
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  };
  const startPending = async (value: Task) => {
    const incoming = request();
    const started = service.runTask(value.id, owner);
    // Attach immediately so intentional close/timeout tests cannot produce an
    // unhandled rejection while the HTTP request is still being observed.
    void started.catch(() => {});
    return { connection: await incoming, started };
  };
  try {
    await service.initializeEngine();
    service.engineStatus.models = [{ id: 'fixture/model', name: 'Fixture' }];
    const first = createTask(), second = createTask();
    const pending = await startPending(first);
    const concurrent = service.runTask(second.id, owner);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    assert.equal(prompts.length, 0, 'neither concurrent task may start before server.connected');
    assert.equal(connections.length, 1, 'concurrent task starts share one pending subscription');
    assert.equal(readNodeModelActivity().counts.active, 0, 'a pending HTTP request is not an open execution feed');
    pending.connection.response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    connect(pending.connection);
    await Promise.all([pending.started, concurrent]);
    await until(() => readNodeModelActivity().outputTokensPerSecond === 4);
    assert.equal(prompts.length, 2);
    assert.equal(droppedReplies, 0, 'immediate short replies were observed without a history poll');
    assert.equal(readNodeModelActivity().counts.generating, 2);
    assert.equal(readNodeModelActivity().inputTokensPerSecond, null, 'unreported input does not hide measured output');

    const account = providerAccounts.create('fixture', 'Named fixture');
    const named = createTask(`${account.id}/model`);
    service.engineStatus.models.push({ id: named.model, name: 'Named fixture', accountName: account.name });
    const namedPending = await startPending(named);
    assert.equal(prompts.length, 2);
    namedPending.connection.response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    connect(namedPending.connection); await namedPending.started;
    await until(() => readNodeModelActivity().connections.find(item => item.id === account.id)?.outputTokensPerSecond === 2);

    // A broken live SDK stream must invalidate observation immediately. The
    // normal monitoring loop then reconnects while keeping existing tasks alive.
    const reconnectRequest = request();
    pending.connection.response.destroy();
    await until(() => !readNodeModelActivity().connections.find(item => item.id === 'fixture')?.countsComplete);
    const reconnect = await reconnectRequest;
    assert.equal(store.task(first.id).state, 'running');
    assert.equal(prompts.length, 3, 'a reconnect never resubmits existing prompts');
    await service.sync(first.id);
    assert.equal(store.task(first.id).state, 'running', 'HTTP reconciliation continues during a pending reconnect');
    reconnect.response.writeHead(200, { 'Content-Type': 'text/event-stream' }); connect(reconnect);
    await until(() => !!readNodeModelActivity().connections.find(item => item.id === 'fixture')?.countsComplete);
    emitReply(engineScopes[0], store.task(first.id).sessionID!, directory);
    emitReply(engineScopes[0], store.task(second.id).sessionID!, directory);
    await until(() => readNodeModelActivity().connections.find(item => item.id === 'fixture')?.outputTokensPerSecond === 4);
    assert.equal(prompts.length, 3);

    const closed = createTask('fixture/model', true);
    const closedPending = await startPending(closed);
    closedPending.connection.response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    closedPending.connection.response.end();
    await assert.rejects(closedPending.started, /event stream/);
    assert.equal(store.task(closed.id).state, 'ready');
    assert.equal(store.task(closed.id).sessionID, null);
    const retried = await startPending(closed);
    retried.connection.response.writeHead(200, { 'Content-Type': 'text/event-stream' }); connect(retried.connection);
    await retried.started;
    assert.equal(prompts.length, 4, 'an explicit retry after a failed handshake submits exactly once');

    const failed = createTask('fixture/model', true);
    const failedPending = await startPending(failed);
    failedPending.connection.response.writeHead(503); failedPending.connection.response.end();
    await assert.rejects(failedPending.started, /event stream/);
    assert.equal(prompts.length, 4, 'SDK SSE HTTP failures cannot trigger a prompt');

    const timedOut = createTask('fixture/model', true);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const timedPending = await startPending(timedOut);
      context.mock.timers.tick(10_001);
      await assert.rejects(timedPending.started, /did not become ready/);
      assert.equal(store.task(timedOut.id).state, 'ready');
      assert.equal(prompts.length, 4);
    } finally { context.mock.timers.reset(); }
    const timeoutRetry = await startPending(timedOut);
    timeoutRetry.connection.response.writeHead(200, { 'Content-Type': 'text/event-stream' }); connect(timeoutRetry.connection);
    await timeoutRetry.started;
    assert.equal(prompts.length, 5, 'a timed-out handshake is removed so an explicit retry can proceed');
    for (const value of [first, second, named, closed, timedOut]) {
      store.patchTask(value.id, { state: 'stopped' }); service.changed(value.id);
    }

    const refreshed = createTask('fixture/model', true);
    const refreshedPending = await startPending(refreshed);
    await service.refreshEngineConfiguration();
    await assert.rejects(refreshedPending.started, /event stream/);
    assert.equal(prompts.length, 5, 'configuration disposal releases waiters without submitting a prompt');

    const cancelled = createTask('fixture/model', true);
    service.engineStatus.models = [{ id: 'fixture/model', name: 'Fixture' }];
    const cancelledPending = await startPending(cancelled);
    await service.shutdownEngine();
    await assert.rejects(cancelledPending.started, /event stream/);
    assert.equal(prompts.length, 5, 'shutdown releases readiness waiters without starting work');
  } finally {
    context.mock.timers.reset();
    await service.shutdownEngine(); store.db.close(); hook.deregister(); Reflect.deleteProperty(globalThis, key);
    for (const connection of connections) connection.response.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
