import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from '../shared/types.ts';
import { occupiesWorkerSlot } from '../server/worker-admission.ts';
import { nodeQueueRecoveryDecision, NodeQueueStore } from '../server/node-queue.ts';

test('engine completion persists results and releases capacity automatically while approvals, questions and recovery remain explicit', async () => {
  const root = mkdtempSync(resolve('.data/verification/completion-'));
  const engineURL = new URL('../server/engine.ts', import.meta.url).href;
  const key = `completion-${randomUUID()}`;
  let messages: unknown[] = [],
    permissions: unknown[] = [],
    questions: unknown[] = [];
  let statuses: Record<string, { type: string }> = {};
  let diffCalls = 0;
  const engine = {
    child: new EventEmitter(),
    close() {},
    client: {
      provider: { list: async () => ({ data: { all: [], connected: [] } }) },
      session: {
        messages: async () => ({ data: messages }),
        status: async () => ({ data: statuses }),
        diff: async () => {
          diffCalls++;
          return {
            data: [{ file: 'RESULT.md', before: '', after: 'Done', additions: 1, deletions: 0 }],
          };
        },
        abort: async () => ({}),
      },
      permission: { list: async () => ({ data: permissions }) },
      question: { list: async () => ({ data: questions }) },
    },
  };
  Object.assign(globalThis, { [key]: engine });
  const fixtureModule =
    'data:text/javascript,' +
    encodeURIComponent(
      `export const dataRoot=${JSON.stringify(root)}; export const engineRoot=${JSON.stringify(join(root, 'engine'))}; export const ENGINE_VERSION='test';
    export const sessionPermissions=()=>[]; export const startEngine=async()=>globalThis[${JSON.stringify(key)}];`,
    );
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      return result.url === engineURL ? { url: fixtureModule, shortCircuit: true } : result;
    },
  });
  const service = await import('../server/task-service.ts');
  const store = await import('../server/store.ts');
  const queue = new NodeQueueStore(store.db);
  const projectID = randomUUID();
  store.saveProject({
    id: projectID,
    name: 'Completion fixture',
    directory: join(root, 'project'),
    createdAt: new Date().toISOString(),
  });
  const make = (state: Task['state']): Task => ({
    id: randomUUID(),
    number: store.taskQueries.nextNumber(),
    projectID,
    state,
    title: 'Deterministic completion',
    description: 'Fixture',
    criteria: 'Result',
    creatorID: 'owner',
    assigneeID: 'owner',
    approverID: 'owner',
    reviewerID: 'owner',
    acceptedBy: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'fixture/model',
    approvalMode: 'ask',
    sessionID: 'session',
    runAfter: 100,
    messages: [],
    approvals: [],
    questions: [],
    artifacts: [],
    diffSource: '',
    error: null,
  });
  const assistant = (created = 101, completed: number | undefined = 102, error?: unknown) => [
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { created, completed },
        ...(error ? { error } : {}),
      },
      parts: [{ type: 'text', text: 'Completed result retained.' }],
    },
  ];
  try {
    const legacy = make('review');
    store.saveTask(legacy);
    const interrupted = make('interrupted');
    store.saveTask(interrupted);
    const active = make('running');
    store.saveTask(active);
    await service.initializeEngine();
    assert(service.engineStatus.ready);
    assert.equal(store.task(legacy.id).state, 'accepted');
    assert.equal(store.task(legacy.id).acceptedBy, null);
    assert.equal(store.task(interrupted.id).state, 'interrupted');
    assert.equal(store.task(active.id).state, 'interrupted');
    assert.equal(store.activities(legacy.id).length, 1);

    const cases = [
      {
        name: 'success',
        expected: 'accepted',
        setup() {
          messages = assistant();
        },
      },
      {
        name: 'approval wins',
        expected: 'waiting_approval',
        setup() {
          messages = assistant();
          permissions = [{ id: 'p', sessionID: 'session' }];
        },
      },
      {
        name: 'question wins',
        expected: 'waiting_input',
        setup() {
          messages = assistant();
          questions = [{ id: 'q', sessionID: 'session', questions: [] }];
        },
      },
      {
        name: 'busy',
        expected: 'running',
        setup() {
          messages = assistant();
          statuses = { session: { type: 'busy' } };
        },
      },
      {
        name: 'old result',
        expected: 'running',
        setup() {
          messages = assistant(90, 99);
        },
      },
      {
        name: 'incomplete message',
        expected: 'running',
        setup() {
          messages = assistant(101, undefined);
          (messages[0] as any).info.time.completed = undefined;
        },
      },
      {
        name: 'engine failure',
        expected: 'failed',
        setup() {
          messages = assistant(101, 102, {
            name: 'APIError',
            data: { message: 'fixture failure' },
          });
        },
      },
    ];
    for (const scenario of cases) {
      messages = [];
      permissions = [];
      questions = [];
      statuses = {};
      const task = make('running');
      store.saveTask(task);
      const entry = queue.enqueue({ kind: 'local', taskID: task.id });
      queue.admit(entry.id, entry.version, task.id);
      scenario.setup();
      await service.sync(task.id);
      const result = store.task(task.id);
      assert.equal(result.state, scenario.expected, scenario.name);
      if (scenario.expected === 'accepted') {
        assert.equal(result.acceptedBy, null);
        assert.equal(result.messages[0].text, 'Completed result retained.');
        assert.equal(result.artifacts[0].file, 'RESULT.md');
        assert.equal(occupiesWorkerSlot(result), false);
        const decision = nodeQueueRecoveryDecision(queue.get(entry.id)!, {
          source: 'live',
          task: result,
        });
        assert.equal(decision.action, 'end');
        const version = result.version;
        await service.sync(task.id);
        assert.equal(
          store.task(task.id).version,
          version,
          'Polling completed output must not duplicate completion',
        );
      } else if (scenario.expected !== 'failed') assert(occupiesWorkerSlot(result));
      store.patchTask(task.id, { state: 'stopped' });
    }
    assert.equal(diffCalls, 1, 'Only successful completion collects results');
  } finally {
    await service.shutdownEngine();
    store.db.close();
    hook.deregister();
    Reflect.deleteProperty(globalThis, key);
  }
});
