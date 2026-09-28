import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, User } from '../shared/types.ts';

test('official session telemetry persists through polls, failures, stops, new runs and restart recovery', async () => {
  mkdirSync(resolve('.data/verification'), { recursive: true });
  const root = mkdtempSync(resolve('.data/verification/task-telemetry-engine-'));
  const engineURL = new URL('../server/engine.ts', import.meta.url).href;
  const key = `telemetry-${randomUUID()}`;
  let messages: unknown[] = [], todos: unknown = [], todoReads = 0, failTodos = false, promptRequests = 0;
  let statuses: Record<string, { type: string }> = { session: { type: 'busy' } };
  const engine = { child: new EventEmitter(), close() {}, client: {
    provider: { list: async () => ({ data: { all: [], connected: [] } }) },
    event: { subscribe: async (_parameters: unknown, { signal }: { signal: AbortSignal }) => ({ stream: (async function* () {
      yield { type: 'server.connected', properties: {} };
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    })() }) },
    session: { messages: async () => ({ data: messages }), status: async () => ({ data: statuses }),
      todo: async () => { todoReads++; if (failTodos) throw new Error('fixture read failure'); return { data: todos }; },
      diff: async () => ({ data: [] }), abort: async () => { statuses = {}; return {}; }, promptAsync: async () => { promptRequests++; return {}; } },
    permission: { list: async () => ({ data: [] }) }, question: { list: async () => ({ data: [] }) },
  } };
  Object.assign(globalThis, { [key]: engine });
  const fixtureModule = 'data:text/javascript,' + encodeURIComponent(
    `export const dataRoot=${JSON.stringify(root)}; export const engineRoot=${JSON.stringify(join(root, 'engine'))};
    export const ENGINE_VERSION='test'; export const sessionPermissions=()=>[];
    export const startEngine=async()=>globalThis[${JSON.stringify(key)}];`);
  const hook = registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    return result.url === engineURL ? { url: fixtureModule, shortCircuit: true } : result;
  } });
  const service = await import('../server/task-service.ts');
  const store = await import('../server/store.ts');
  const { readTaskTelemetry } = await import('../server/task-telemetry.ts');
  const { readNodeModelActivity } = await import('../server/node-model-activity.ts');
  const owner: User = { id: randomUUID(), username: 'fixture', name: 'Fixture', owner: true };
  store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(owner.id, owner.username, owner.name, 1, 'unused');
  const projectID = randomUUID();
  store.saveProject({ id: projectID, name: 'Telemetry fixture', directory: join(root, 'project'), createdAt: new Date().toISOString() });
  const value: Task = { id: randomUUID(), number: 1, projectID, title: 'Telemetry', description: 'Fixture', criteria: 'Fixture',
    creatorID: owner.id, assigneeID: owner.id, approverID: owner.id, reviewerID: owner.id, acceptedBy: null,
    state: 'ready', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    model: 'fixture/model', approvalMode: 'ask', sessionID: 'session', runAfter: 100,
    messages: [], approvals: [], questions: [], artifacts: [], diffSource: '', error: null };
  const message = (runAfter: number, id = 'message') => ({ info: { id, sessionID: 'session', role: 'assistant', time: { created: runAfter + 1 },
    cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } } },
  parts: [{ id: `tool-${id}`, type: 'tool', tool: 'todowrite', state: { status: 'completed', time: { end: runAfter + 2 }, output: 'Todo written' } }] });
  try {
    store.saveTask(value);
    await service.initializeEngine();
    store.patchTask(value.id, { state: 'running' });
    messages = [message(100)];
    todos = [{ content: 'Check sk-12345678901234567890', status: 'in_progress', priority: 'high' }];
    await service.sync(value.id);
    let current = store.task(value.id);
    assert.equal(current.state, 'running');
    assert.equal(current.telemetry?.usage?.cost, 0.25);
    assert.equal(current.telemetry?.usage?.tokens.total, null);
    assert.equal(current.telemetry?.todos.items[0].content, 'Check [REDACTED]');
    assert.equal(todoReads, 1);
    await service.sync(value.id);
    assert.equal(store.task(value.id).version, current.version, 'unchanged telemetry does not rewrite the task');
    assert.equal(todoReads, 1, 'a stable official todo revision does not add requests every poll');
    const corrected = message(100);
    corrected.info.cost = 0.3;
    messages = [corrected];
    await service.sync(value.id);
    assert.equal(store.task(value.id).telemetry?.usage?.cost, 0.3, 'usage-only message updates persist even when visible message text is unchanged');
    assert.equal(todoReads, 1);

    messages = [message(100), message(100, 'next')];
    failTodos = true;
    await service.sync(value.id);
    current = store.task(value.id);
    assert.equal(current.state, 'running', 'an optional read failure must not fail execution');
    assert.equal(current.telemetry?.usage?.cost, 0.5);
    assert.equal(current.telemetry?.todos.state, 'unavailable');
    assert.deepEqual(current.telemetry?.todos.items, [], 'a failed new revision must not display the old plan');
    await service.sync(value.id);
    assert.equal(todoReads, 2, 'failed optional reads have a cooldown');
    failTodos = false;
    const retry = await readTaskTelemetry({ sessionID: 'session', runAfter: 100, state: 'running', messages,
      previous: current.telemetry, now: current.telemetry!.todos.retryAt!, readTodos: async () => todos });
    assert.equal(retry.todos.state, 'available', 'transient reads recover on a later existing poll');
    store.patchTask(value.id, { telemetry: retry });
    await service.stopTask(value.id, owner);
    current = store.task(value.id);
    assert.equal(current.state, 'stopped');
    assert.equal(current.telemetry?.usage?.cost, 0.5);
    assert.equal(current.telemetry?.todos.state, 'inactive');
    assert.deepEqual(current.telemetry?.todos.items, []);

    service.engineStatus.models = [{ id: 'fixture/model', name: 'Fixture' }];
    await service.runTask(value.id, owner, 'Continue with a new task');
    current = store.task(value.id);
    assert.equal(current.telemetry?.runAfter, current.runAfter);
    assert.equal(current.telemetry?.todos.state, 'not_reported');
    const readCount = todoReads;
    await service.sync(value.id);
    assert.equal(todoReads, readCount, 'old todo writes cannot trigger a new-run plan read');
    assert.equal(store.task(value.id).telemetry?.todos.state, 'not_reported');
    messages = [...messages, message(current.runAfter, 'new-run')];
    await service.sync(value.id);
    assert.equal(store.task(value.id).telemetry?.todos.state, 'available');
    assert.equal(readNodeModelActivity().inputTokensPerSecond, null, 'unfinished and historical snapshots are not new confirmed input');
    const terminal = message(current.runAfter, 'new-run');
    Object.assign(terminal.info.time, { completed: current.runAfter + 3 });
    messages = [...messages.slice(0, -1), terminal];
    // A completed step can be observed while the session is still busy. Repeated
    // ordinary active-task polls must not re-add that completed message's usage.
    statuses = { session: { type: 'busy' } };
    await service.sync(value.id);
    let nodeActivity = readNodeModelActivity();
    assert.equal(nodeActivity.inputTokensPerSecond, 100 / 60, 'the production sync hook counts only the new run, excluding cached history and cache counters');
    assert.equal(nodeActivity.inputComplete, true);
    assert.equal(nodeActivity.counts.active, 1, 'runTask registered the actual local execution');
    assert.equal(nodeActivity.connections.length, 1);
    assert.equal(nodeActivity.connections[0].id, 'fixture');
    assert.equal(nodeActivity.connections[0].inputTokensPerSecond, 100 / 60);
    assert.equal(nodeActivity.outputTokensPerSecond, null, 'HTTP message snapshots never become measured output deltas');
    await service.sync(value.id);
    assert.equal(readNodeModelActivity().inputTokensPerSecond, 100 / 60, 'a second active poll replaces rather than adds the same usage');
    statuses = {};
    await service.sync(value.id);
    assert.equal(store.task(value.id).state, 'accepted');
    assert.equal(store.task(value.id).telemetry?.todos.items[0].status, 'in_progress', 'engine completion never invents completion of its remaining checklist items');
    nodeActivity = readNodeModelActivity();
    assert.equal(nodeActivity.inputTokensPerSecond, 100 / 60, 'the terminal sync retains the same recent input without counting it twice');
    assert.equal(nodeActivity.counts.active, 0, 'the production terminal hook retires active execution counts');
    assert.equal(nodeActivity.counts.generating, 0);
    assert.equal(nodeActivity.countsComplete, true);
    assert.equal(nodeActivity.connections[0].counts.active, 0);
    assert.equal(nodeActivity.connections[0].countsComplete, true);
    assert.equal(promptRequests, 1, 'sampling and repeat polls never resubmit a model prompt');
    store.patchTask(value.id, { state: 'running' });
    await service.initializeEngine();
    current = store.task(value.id);
    assert.equal(current.state, 'interrupted');
    assert.equal(current.telemetry?.todos.state, 'inactive');
    assert.deepEqual(current.telemetry?.todos.items, []);
    assert.equal(current.telemetry?.usage?.cost, 0.75, 'restart preserves official session usage');
    const decoded = (await import('../server/task-queries.ts')).decodeTask(JSON.stringify(value));
    assert.equal(decoded.telemetry, undefined, 'old persisted records require no migration');
  } finally {
    await service.shutdownEngine(); store.db.close(); hook.deregister(); Reflect.deleteProperty(globalThis, key);
  }
});
