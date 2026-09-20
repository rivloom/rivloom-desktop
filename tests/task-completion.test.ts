import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, User, Message } from '../shared/types.ts';
import { canContinueTask } from '../shared/task-continuation.ts';
import { taskContinuationContext, taskContinuationContextBytes, taskMessageDigest, taskVisibleMessages } from '../server/task-continuation.ts';
import { occupiesWorkerSlot } from '../server/worker-admission.ts';
import { nodeQueueRecoveryDecision, NodeQueueStore } from '../server/node-queue.ts';

test('ordinary continuation states exclude active, unknown and externally managed executions', () => {
  for (const state of ['ready', 'stopped', 'failed', 'review', 'accepted'] as const) assert(canContinueTask({ state }));
  for (const state of ['open', 'running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted'] as const)
    assert(!canContinueTask({ state }));
  assert(!canContinueTask({ state: 'accepted', remoteOrigin: { remoteTaskID: 'r', ownerNodeID: 'n', ownerBrainID: 'b' } }));
  assert(!canContinueTask({ state: 'accepted', collaboration: {} as Task['collaboration'] }));
});

test('cross-account context preserves all visible records, rejects excessive bytes and excludes unrelated stored fields', () => {
  const message: Message = { id: 'old', role: 'assistant', text: 'History with ``` fences and 中文',
    tools: [{ name: 'read', status: 'completed', title: 'Result', output: 'Saved tool output' }] };
  const value = { title: 'Task', description: 'Original request', criteria: 'Acceptance', credential: 'SHOULD_NOT_EXPORT', config: { auth: 'SECRET' } };
  const context = taskContinuationContext(value, [message]);
  assert(context.includes(message.text)); assert(context.includes(message.tools[0].output));
  assert(!context.includes(value.credential)); assert(!context.includes('SECRET'));
  assert.throws(() => taskContinuationContext(value, [{ ...message, text: '中'.repeat(taskContinuationContextBytes / 2) }]), /too large/);
  assert.deepEqual(taskVisibleMessages({ priorMessages: [message] }, [{ ...message, id: 'new' }]).map(item => item.id), ['old', 'new']);
  const request = { requestID: randomUUID(), text: 'Follow up', model: 'account/org/model' };
  assert.equal(taskMessageDigest(request), taskMessageDigest({ ...request, requestID: randomUUID() }));
  assert.notEqual(taskMessageDigest(request), taskMessageDigest({ ...request, model: 'account/other/model' }));
  assert.notEqual(taskMessageDigest(request), taskMessageDigest({ ...request, text: 'Another request' }));
});

test('engine completion persists results and releases capacity automatically while approvals, questions and recovery remain explicit', async () => {
  const root = mkdtempSync(resolve('.data/verification/completion-'));
  const engineURL = new URL('../server/engine.ts', import.meta.url).href;
  const key = `completion-${randomUUID()}`;
  let messages: unknown[] = [],
    permissions: unknown[] = [],
    questions: unknown[] = [];
  let statuses: Record<string, { type: string }> = {};
  let diffCalls = 0;
  let createCalls = 0, failPrompt = false, failCreate = false;
  let currentAccount = () => '';
  const prompts: Array<{ account: string; input: { sessionID: string; model: { providerID: string; modelID: string }; system: string; parts: Array<{ text: string }> } }> = [];
  const engine = {
    child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
    close() {},
    waitForExit: async () => {},
    client: {
      provider: { list: async () => ({ data: { all: [], connected: [] } }) },
      event: { subscribe: async () => ({ stream: (async function* () {})() }) },
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
        create: async () => { createCalls++; if (failCreate) throw new Error('Uncertain create response'); return { data: { id: `new-session-${createCalls}` } }; },
        promptAsync: async (input: (typeof prompts)[number]['input']) => {
          prompts.push({ account: currentAccount(), input });
          if (failPrompt) throw new Error('Uncertain prompt response');
          return {};
        },
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
  const { accountEngines, providerAccounts } = await import('../server/account-engines.ts');
  currentAccount = () => accountEngines.current();
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

    const owner: User = { id: 'owner', username: 'owner', name: 'Owner', owner: true };
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(owner.id, owner.username, owner.name, 1, 'unused');
    const account = providerAccounts.create('fixture', 'Alternate');
    service.engineStatus.models = ['fixture/model', 'fixture/org/beta', `${account.id}/org/beta`].map(id => ({ id, name: id }));
    statuses = {}; questions = []; permissions = []; messages = assistant();
    const conversation = make('accepted'); conversation.messages = [{ id: 'answer', role: 'assistant', text: 'Completed result retained.', tools: [] }];
    store.saveTask(conversation);
    const first = { requestID: randomUUID(), text: 'Continue using beta', model: 'fixture/org/beta' };
    await assert.rejects(service.sendTaskMessage(conversation.id, { ...owner, id: 'someone-else' }, first), /只有接受人/);
    const continued = await service.sendTaskMessage(conversation.id, owner, first);
    assert.equal(continued.state, 'running'); assert.equal(continued.model, first.model);
    assert.equal(continued.sessionID, 'session'); assert.equal(createCalls, 0);
    assert.deepEqual(prompts.at(-1)!.input.model, { providerID: 'fixture', modelID: 'org/beta' });
    assert.equal(prompts.length, 1);
    assert.equal((await service.sendTaskMessage(conversation.id, owner, first)).state, 'running');
    await service.sendTaskMessage(conversation.id, owner, first, () => { throw new Error('New execution temporarily locked'); });
    assert.equal(prompts.length, 1, 'Lost HTTP response replay does not call the model twice');
    store.db.prepare("INSERT INTO conversation_retired VALUES('local',?,?,0)").run(conversation.id, `local:${conversation.id}`);
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, first), (error: unknown) => (error as { status: number }).status === 410);
    store.db.prepare("DELETE FROM conversation_retired WHERE kind='local' AND id=?").run(conversation.id);
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, { ...first, text: 'Changed' }), /different content or model/);
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, { ...first, model: 'fixture/model' }), /different content or model/);
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, { ...first, requestID: randomUUID() }), /must be idle/);

    store.patchTask(conversation.id, { state: 'accepted' });
    const cross = { requestID: randomUUID(), text: 'Use the other account', model: `${account.id}/org/beta` };
    statuses = { session: { type: 'busy' } };
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, cross), /引擎仍在执行/);
    assert.equal(createCalls, 0); assert.equal(store.task(conversation.id).model, first.model);
    statuses = {}; permissions = [{ id: 'approval', sessionID: 'session' }];
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, cross), /pending approval or question/);
    permissions = [];
    messages = [{ info: { id: 'huge', role: 'assistant', time: { created: 101, completed: 102 } },
      parts: [{ type: 'text', text: '中'.repeat(taskContinuationContextBytes / 2) }] }];
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, cross), /too large/);
    assert.equal(createCalls, 0); assert.equal(store.task(conversation.id).sessionID, 'session');
    messages = assistant();
    const switched = await service.sendTaskMessage(conversation.id, owner, cross);
    assert.equal(createCalls, 1); assert.equal(switched.sessionID, 'new-session-1');
    assert.equal(prompts.at(-1)!.account, account.id);
    assert.deepEqual(prompts.at(-1)!.input.model, { providerID: 'fixture', modelID: 'org/beta' });
    assert.match(prompts.at(-1)!.input.system, /Completed result retained/);
    assert.equal(prompts.at(-1)!.input.parts[0].text, cross.text, 'Archived context does not replace the new user message');
    assert.equal(switched.priorMessages?.[0].text, 'Completed result retained.');
    assert.equal(switched.messages[0].text, 'Completed result retained.');
    messages = [{ info: { id: 'new-answer', role: 'assistant', time: { created: switched.runAfter + 1, completed: switched.runAfter + 2 } },
      parts: [{ type: 'text', text: 'New account result.' }] }];
    await service.sync(conversation.id);
    assert.deepEqual(store.task(conversation.id).messages.map(message => message.text), ['Completed result retained.', 'New account result.']);
    const third = { requestID: randomUUID(), text: 'Retain both accounts history' };
    await service.sendTaskMessage(conversation.id, owner, third);
    assert.equal(createCalls, 1, 'Next turn on the same account keeps the new session');
    assert.match(prompts.at(-1)!.input.system, /Completed result retained/, 'Prior system context is supplied again for the next prompt');

    store.patchTask(conversation.id, { state: 'stopped' });
    failPrompt = true;
    const uncertain = { requestID: randomUUID(), text: 'Uncertain transport response' };
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, uncertain), /submission is uncertain/);
    const afterUncertain = prompts.length;
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, uncertain), /submission is uncertain/);
    assert.equal(prompts.length, afterUncertain);
    failPrompt = false;

    store.patchTask(conversation.id, { state: 'stopped' });
    failCreate = true;
    const uncertainCreate = { requestID: randomUUID(), text: 'Switch back safely', model: 'fixture/model' };
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, uncertainCreate), /submission is uncertain/);
    assert.equal(store.task(conversation.id).sessionID, null);
    assert.equal(store.db.prepare('SELECT state FROM task_engine_intents WHERE task_id=?').get(conversation.id)!.state, 'creating');
    const createdCount = createCalls;
    await assert.rejects(service.sendTaskMessage(conversation.id, owner, uncertainCreate), /submission is uncertain/);
    assert.equal(createCalls, createdCount, 'Uncertain session creation never creates a second session');
    assert.deepEqual(store.task(conversation.id).messages.map(message => message.text), ['Completed result retained.', 'New account result.']);
    const crashTask = make('accepted'), crashRequest = { requestID: randomUUID(), text: 'Transport interrupted at restart' };
    store.saveTask(crashTask);
    store.db.prepare("INSERT INTO task_message_requests VALUES(?,?,?,'pending',NULL,NULL)")
      .run(crashTask.id, crashRequest.requestID, taskMessageDigest(crashRequest));
    await service.initializeEngine();
    assert.equal(store.task(crashTask.id).state, 'interrupted');
    await assert.rejects(service.sendTaskMessage(crashTask.id, owner, crashRequest), /submission is uncertain/);
    assert.equal(prompts.length, afterUncertain);
    assert.equal(createCalls, createdCount, 'Restart recovery keeps unresolved session creation fenced');
    store.db.prepare('DELETE FROM activities WHERE task_id=?').run(conversation.id);
    store.db.prepare('DELETE FROM task_engine_intents WHERE task_id=?').run(conversation.id);
    store.db.prepare('DELETE FROM tasks WHERE id=?').run(conversation.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_message_requests WHERE task_id=?').get(conversation.id)!.n, 0,
      'Permanent task deletion cascades its idempotency journal');
  } finally {
    await service.shutdownEngine();
    store.db.close();
    hook.deregister();
    Reflect.deleteProperty(globalThis, key);
  }
});
