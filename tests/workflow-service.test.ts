import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore, workflowStep, type WorkflowRequest } from '../server/workflows.ts';
import { WorkflowService, type WorkflowExecutionAdapter, type WorkflowExecutionSnapshot } from '../server/workflow-service.ts';
import type { ExecutionOutcome, WorkflowAttempt, WorkflowPlan, WorkflowStepPlan } from '../shared/workflows.ts';

const A = 'A'.repeat(32); const B = 'B'.repeat(32); const C = 'C'.repeat(32);

test('queued thinking choices persist across restart, fence replays and reach each round independently', async () => {
  const f = setup();
  try {
    f.adapter.candidates = value => [{ nodeID: A, kind: 'local', waitingCount: 0,
      localConfig: { projectID: 'project', model: value.model!, reasoningEffort: value.reasoningEffort } }];
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] }, { reasoningEffort: 'high' });
    const next = randomUUID(), final = randomUUID();
    f.service.enqueue(id, next, 'Use low', [], f.request.model, 'low');
    f.service.enqueue(id, next, 'Use low', [], f.request.model, 'low');
    assert.throws(() => f.service.enqueue(id, next, 'Use low', [], f.request.model, null), /conflict/);
    f.service.enqueue(id, final, 'Use automatic', [], f.request.model, null);
    assert.equal(f.store.get(id)!.reasoningEffort, 'high');
    f.restart();
    assert.equal(f.store.get(id)!.messages![0].reasoningEffort, 'low');
    f.finish(f.starts[1], complete()); await f.service.advance(id); await f.service.tick(); await f.service.tick();
    assert.equal(f.store.get(id)!.rounds![0].reasoningEffort, 'high');
    assert.equal(f.starts[2].localConfig?.reasoningEffort, 'low');
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'Next', steps: [step('next')] } }); await f.service.advance(id);
    assert.equal(f.starts[3].localConfig?.reasoningEffort, 'low');
    f.finish(f.starts[3], complete()); await f.service.advance(id); await f.service.tick(); await f.service.tick();
    assert.equal(f.store.get(id)!.rounds![1].reasoningEffort, 'low');
    assert.equal(f.starts[4].localConfig?.reasoningEffort, null);
    const request = { ...f.request, requestID: randomUUID(), reasoningEffort: 'high' };
    f.service.create(request); assert.throws(() => f.service.create({ ...request, reasoningEffort: null }), /conflict/);
    const legacy = { ...f.request, requestID: randomUUID() };
    const original = f.service.create(legacy); assert.equal(f.service.create(legacy).contentDigest, original.contentDigest);
  } finally { await f.service.close(); f.db.close(); }
});
const step = (id: string, dependsOn: string[] = [], nodeID: string | null = null): WorkflowStepPlan =>
  ({ id, title: id, instructions: `Complete ${id}`, dependsOn, nodeID, resources: [], software: [], requirements: {} });
function setup() {
  const db = new DatabaseSync(':memory:'); const store = new WorkflowStore(db);
  const executions = new Map<string, WorkflowExecutionSnapshot>(); const starts: WorkflowAttempt[] = [];
  let queries = 0; let waitingCount = 0; let dropAfterAdmission = false; let stopUnknown = false;
  let beforeDispatch: (() => void) | null = null;
  const adapter: WorkflowExecutionAdapter = {
    candidates: () => [A, B, C].map((nodeID) => ({ nodeID, kind: nodeID === A ? 'local' : 'remote', waitingCount })),
    evidence: () => 'catalog version 1',
    lookup: async (_value, attempt) => executions.get(attempt.executionID) || null,
    dispatch: async (value, _step, attempt, mayStart) => {
      beforeDispatch?.();
      if (!mayStart()) return { state: 'blocked', reason: 'cancelled' };
      if (executions.has(attempt.executionID)) return { state: 'accepted' };
      if (waitingCount >= 10 && !value.confirmations.some((c) => c.nodeID === attempt.nodeID)) return { state: 'confirmation', waitingCount };
      starts.push(structuredClone(attempt));
      executions.set(attempt.executionID, { phase: 'queued', summary: '', error: null, outcome: null, outputFiles: [], safeToTransfer: false });
      if (dropAfterAdmission) throw new Error('lost_ack');
      return { state: 'accepted' };
    },
    stop: async (_value, attempt) => {
      if (stopUnknown) return 'unknown';
      executions.set(attempt.executionID, { phase: 'stopped', summary: '', error: null, outcome: null, outputFiles: [], safeToTransfer: true });
      return 'stopped';
    },
    query: async () => { queries++; return { results: ['B has the required resource'], status: 'complete' }; },
    materialize: async () => [],
    stageInputs: async (_value, _key, files) => files,
    retryReady: async (_value, attempt) => executions.get(attempt.executionID)?.safeToTransfer === true,
  };
  let service = new WorkflowService(store, adapter);
  const request: WorkflowRequest = { requestID: randomUUID(), creatorID: 'owner', title: 'Make a short film',
    description: 'Write a script, find material and edit the film', projectID: 'project', model: 'fixture/model',
    approvalMode: 'ask', target: { mode: 'automatic' }, inputFiles: [] };
  const create = (patch: Partial<WorkflowRequest> = {}) => service.create({ ...request, ...patch });
  const finish = (attempt: WorkflowAttempt, outcome: WorkflowAttempt['outcome'], safeToTransfer = true) => {
    executions.set(attempt.executionID, { phase: 'completed', summary: 'finished', error: null, outcome, outputFiles: [], safeToTransfer });
  };
  const planned = async (plan: WorkflowPlan, patch: Partial<WorkflowRequest> = {}) => {
    const value = create(patch); await service.advance(value.id);
    finish(starts[0], { kind: 'plan', plan }); await service.advance(value.id); return value.id;
  };
  return { db, store, adapter, executions, starts, request, create, finish, planned,
    get service() { return service; }, get queries() { return queries; },
    setQueue(value: number) { waitingCount = value; }, dropAck() { dropAfterAdmission = true; },
    uncertainStop(value: boolean) { stopUnknown = value; }, beforeDispatch(callback: () => void) { beforeDispatch = callback; },
    restart() { service = new WorkflowService(new WorkflowStore(db), adapter); },
  };
}
const complete = (summary = 'done'): ExecutionOutcome => ({ kind: 'completed', summary, files: [] });

test('retry restores only a failed branch and its blocked descendants, preserving results, queue pause and durable receipts', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Branches', steps: [step('ready'), step('bad'), step('join', ['ready', 'bad'])] });
    const success = f.starts.find((a) => a.context.stepID === 'ready')!, failed = f.starts.find((a) => a.context.stepID === 'bad')!;
    f.finish(success, complete('Keep this answer'));
    f.executions.set(failed.executionID, { phase: 'failed', summary: 'Failed first try', error: 'synthetic_failure', outcome: null, outputFiles: [], safeToTransfer: true });
    await f.service.advance(id);
    f.service.enqueue(id, randomUUID(), 'Do not start the next round', []);
    const before = f.store.get(id)!;
    const request = { version: before.version, roundRequestID: before.requestID, stepID: 'bad', attempt: 1, requestID: randomUUID() };
    f.restart(); const retried = await f.service.retryStep(id, request);
    assert.equal(retried.queuePaused, true); assert.equal(retried.steps[2].state, 'waiting');
    assert.deepEqual(retried.steps[0], before.steps[0]); assert.deepEqual(retried.steps[1].attempts, before.steps[1].attempts);
    assert.deepEqual(await f.service.retryStep(id, request), retried);
    f.restart(); await f.service.advance(id);
    const second = f.starts.at(-1)!; assert.equal(second.context.stepID, 'bad'); assert.equal(second.number, 2);
    assert.notEqual(second.executionID, failed.executionID); assert.equal(f.starts.filter((a) => a.context.stepID === 'ready').length, 1);
    f.finish(second, complete('Recovered')); await f.service.advance(id);
    assert.equal(f.starts.at(-1)!.context.stepID, 'join'); f.finish(f.starts.at(-1)!, complete('All done'));
    await f.service.advance(id); await f.service.tick();
    const done = f.store.get(id)!; assert.equal(done.state, 'completed'); assert.equal(done.rounds, undefined);
    assert.equal(done.steps[1].attempts[0].error, 'synthetic_failure');
  } finally { await f.service.close(); f.db.close(); }
});

test('retry refuses unconfirmed execution, stale identity, unknown phases and races with a new round', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Fail', steps: [step('work')] });
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', error: 'failure', outcome: null, outputFiles: [], safeToTransfer: false });
    await f.service.advance(id);
    const value = f.store.get(id)!;
    const request = { version: value.version, roundRequestID: value.requestID, stepID: 'work', attempt: 1, requestID: randomUUID() };
    await assert.rejects(f.service.retryStep(id, request), /unconfirmed/); assert.equal(f.starts.length, 2);
    for (const patch of [{ version: 1 }, { roundRequestID: randomUUID() }, { attempt: 0 }, { stepID: 'planner' }])
      await assert.rejects(f.service.retryStep(id, { ...request, ...patch }), /changed/);
    let release!: (ready: boolean) => void;
    f.adapter.retryReady = () => new Promise((resolve) => { release = resolve; });
    const pending = f.service.retryStep(id, request);
    f.service.enqueue(id, randomUUID(), 'Next round', []); f.service.messageControl(id, 'resume'); await f.service.advance(id);
    release(true); await assert.rejects(pending, /version_conflict|changed/);
    assert.equal(f.starts.length, 2);
  } finally { await f.service.close(); f.db.close(); }
});

test('retry of one failed branch keeps an independent failure and shared dependents blocked', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Two failures', steps: [step('a'), step('b'), step('join', ['a', 'b'])] });
    for (const attempt of f.starts.slice(1)) f.executions.set(attempt.executionID, { phase: 'failed', summary: '', error: 'failure', outcome: null, outputFiles: [], safeToTransfer: true });
    await f.service.advance(id); const value = f.store.get(id)!;
    await f.service.retryStep(id, { version: value.version, roundRequestID: value.requestID, stepID: 'a', attempt: 1, requestID: randomUUID() });
    await f.service.advance(id); f.finish(f.starts.at(-1)!, complete()); await f.service.advance(id);
    assert.deepEqual(f.store.get(id)!.steps.map((s) => s.state), ['completed', 'failed', 'blocked']);
    assert.equal(f.starts.filter((a) => a.context.stepID === 'b').length, 1);
  } finally { await f.service.close(); f.db.close(); }
});

test('material preparation waits without dispatch and retains negotiated output policy on restart', async () => {
  const f = setup();
  try {
    f.adapter.candidates = () => [{ nodeID: B, kind: 'remote', waitingCount: 0, resultDelivery: 'on-demand' }];
    let ready = false;
    f.adapter.prepareInputs = async (_w, files, role) => role === 'planner' || ready ? files : null;
    const id = await f.planned({ summary: 'Remote files', steps: [step('consume')] });
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(id)!.steps[0].state, 'ready');
    const waiting = f.store.get(id)!;
    assert.equal(f.service.preparation(waiting, waiting.steps[0])?.nodeID, B);
    assert.deepEqual(f.store.get(id), waiting, 'Reading preparation does not mutate workflow state');
    f.restart(); await f.service.advance(id); assert.equal(f.starts.length, 1);
    ready = true; await f.service.advance(id);
    assert.equal(f.starts[1].resultDelivery, 'on-demand'); assert.equal(f.store.get(id)!.steps[0].attempts[0].resultDelivery, 'on-demand');
    const started = f.store.get(id)!;
    assert.equal(f.service.preparation(started, started.steps[0]), null);
  } finally { await f.service.close(); f.db.close(); }
});

test('conversation messages queue through questions and restart, preserve rounds and never interrupt current work', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'First plan', steps: [step('work')] });
    const second = randomUUID(), third = randomUUID();
    f.service.enqueue(id, second, 'Change the color to green', []);
    f.service.enqueue(id, third, 'Then export the result', []);
    f.service.enqueue(id, second, 'Change the color to green', []);
    assert.equal(f.store.get(id)!.messages!.length, 2);
    assert.throws(() => f.service.enqueue(id, second, 'Changed duplicate', []), /conflict/);
    f.executions.get(f.starts[1].executionID)!.phase = 'waiting';
    await f.service.tick(); assert.equal(f.starts.length, 2); assert.equal(f.store.get(id)!.rounds, undefined);
    f.service.recordAnswers(f.starts[1].executionID, 'question-1', ['Which format?'], [['SVG']]);
    f.restart(); await f.service.tick(); assert.equal(f.starts.length, 2);
    f.finish(f.starts[1], complete('Original result')); await f.service.advance(id); await f.service.tick();
    let value = f.store.get(id)!;
    assert.equal(value.id, id); assert.equal(value.requestID, f.request.requestID);
    assert.equal(value.roundRequestID, second); assert.equal(value.description, 'Change the color to green');
    assert.equal(value.projectID, f.request.projectID); assert.equal(value.model, f.request.model);
    assert.equal(value.rounds![0].description, f.request.description);
    assert.equal(value.rounds![0].steps[0].checkpoint, 'Original result');
    assert.deepEqual(value.rounds![0].steps[0].attempts[0].clarifications![0].answers, [['SVG']]);
    assert.equal(f.starts.length, 2, 'next round is durable before any dispatch');
    f.service.enqueue(id, second, 'Change the color to green', []); f.restart(); await f.service.tick();
    assert.equal(f.starts.length, 3); assert.notEqual(f.starts[2].executionID, f.starts[0].executionID);
    assert.throws(() => f.service.messageControl(id, 'cancel', second), /started/);
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'Update', steps: [step('edit')] } }); await f.service.advance(id);
    f.finish(f.starts[3], complete('Green result')); await f.service.advance(id); await f.service.tick();
    value = f.store.get(id)!; assert.equal(value.rounds!.length, 2); assert.equal(value.roundRequestID, third);
    assert.equal(value.rounds![1].steps[0].checkpoint, 'Green result');
  } finally { await f.service.close(); f.db.close(); }
});

test('message cancellation, stop and failures hold the queue until explicitly resumed', async () => {
  for (const action of ['stop', 'failure', 'planner_failure'] as const) {
    const f = setup();
    try {
      const id = action === 'planner_failure' ? f.create().id : await f.planned({ summary: 'Plan', steps: [step('work')] });
      if (action === 'planner_failure') await f.service.advance(id);
      const cancelled = randomUUID(), next = randomUUID();
      f.service.enqueue(id, cancelled, 'Do not run this', []); f.service.enqueue(id, next, 'Continue from saved work', []);
      f.service.messageControl(id, 'cancel', cancelled); f.service.enqueue(id, cancelled, 'Do not run this', []);
      if (action === 'stop') f.service.control(id, 'stop');
      else f.executions.set(f.starts.at(-1)!.executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: true, error: 'execution_failed' });
      await f.service.advance(id); f.restart(); await f.service.tick();
      assert.equal(f.store.get(id)!.queuePaused, true, action); assert.equal(f.store.get(id)!.rounds, undefined);
      f.service.messageControl(id, 'resume'); await f.service.tick();
      assert.equal(f.store.get(id)!.roundRequestID, next, action);
      assert.equal(f.store.get(id)!.messages![0].state, 'cancelled');
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('queued model choices are durable per message and only change the admitted round', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Original plan', steps: [step('work')] });
    const second = randomUUID(), third = randomUUID();
    const nextModel = 'rivloom-account-example/vendor/model-two';
    f.adapter.candidates = value => [{ nodeID: A, kind: 'local', waitingCount: 0,
      localConfig: { projectID: 'project', model: value.model || 'fixture/default' } }];
    f.service.enqueue(id, second, 'Continue with another model', [], nextModel);
    f.service.enqueue(id, third, 'Then use the configured default', [], null);
    assert.equal(f.store.get(id)!.model, f.request.model, 'active execution keeps its model');
    f.restart();
    assert.equal(f.store.get(id)!.messages![0].model, nextModel);
    assert.equal(f.store.get(id)!.messages![1].model, null);
    f.finish(f.starts[1], complete('Preserved original result'));
    await f.service.advance(id); await f.service.tick();
    let value = f.store.get(id)!;
    assert.equal(value.model, nextModel);
    assert.equal(value.rounds![0].model, f.request.model);
    assert.equal(value.rounds![0].steps[0].checkpoint, 'Preserved original result');
    await f.service.tick();
    assert.equal(f.starts[2].localConfig?.model, nextModel, 'dispatch receives the exact account and slash model');
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'Second plan', steps: [step('second')] } });
    await f.service.advance(id);
    assert.equal(f.starts[3].localConfig?.model, nextModel);
    f.finish(f.starts[3], complete('Second result')); await f.service.advance(id); await f.service.tick();
    value = f.store.get(id)!;
    assert.equal(value.model, null);
    assert.equal(value.rounds![1].model, nextModel);
    await f.service.tick();
    assert.equal(f.starts[4].localConfig?.model, 'fixture/default');
  } finally { await f.service.close(); f.db.close(); }
});

test('queued model choices participate in idempotency without rewriting saved messages or current work', async () => {
  const f = setup();
  try {
    const value = f.create(), id = randomUUID(), legacy = randomUUID();
    f.service.enqueue(value.id, id, 'Next round', [], 'fixture/org/model');
    f.service.enqueue(value.id, id, 'Next round', [], 'fixture/org/model');
    for (const choice of [undefined, null, 'fixture/other'])
      assert.throws(() => f.service.enqueue(value.id, id, 'Next round', [], choice), /conflict/);
    f.service.enqueue(value.id, legacy, 'Old client', []);
    assert.throws(() => f.service.enqueue(value.id, legacy, 'Old client', [], null), /conflict/);
    assert.equal(f.store.get(value.id)!.messages!.length, 2);
    assert.equal(f.store.get(value.id)!.model, value.model);
    assert.equal(Object.hasOwn(f.store.get(value.id)!.messages![1], 'model'), false);
    f.service.messageControl(value.id, 'cancel', id);
    assert.equal(f.store.get(value.id)!.messages![0].state, 'cancelled');
    assert.equal(f.store.get(value.id)!.model, value.model);
  } finally { await f.service.close(); f.db.close(); }
});

test('invalid continuation model identities cannot enter the durable workflow queue', async () => {
  const f = setup();
  try {
    const value = f.create();
    for (const model of ['', 'missing-provider', '/model', 'provider/', 'provider/with space', 'provider/model\n', 'a/'.padEnd(201, 'x')])
      assert.throws(() => f.service.enqueue(value.id, randomUUID(), 'Follow up', [], model), /invalid_workflow_request/);
    assert.equal(f.store.get(value.id)!.messages, undefined);
  } finally { await f.service.close(); f.db.close(); }
});

test('round admission rechecks cancellation during context preparation and archives only quiescent executions', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    const next = randomUUID(); f.service.enqueue(id, next, 'Follow up', []);
    f.executions.get(f.starts[1].executionID)!.phase = 'unknown'; await f.service.advance(id); await f.service.tick();
    assert.equal(f.store.get(id)!.rounds, undefined);
    f.finish(f.starts[1], complete(), true); await f.service.advance(id);
    const descriptor = { id: randomUUID(), name: 'history.json', bytes: 2, sha256: 'a'.repeat(64), mime: 'application/octet-stream' };
    f.adapter.conversationContext = async () => { f.service.messageControl(id, 'cancel', next); return descriptor; };
    await f.service.tick(); assert.equal(f.store.get(id)!.rounds, undefined);
    const later = randomUUID(); f.service.enqueue(id, later, 'New follow up', []);
    f.adapter.conversationContext = async () => descriptor;
    await f.service.tick(); assert.equal(f.store.get(id)!.roundRequestID, later);
    await f.service.tick(); assert(f.starts.at(-1)!.context.priorContext.includes('history.json'));
  } finally { await f.service.close(); f.db.close(); }
});

test('round input files preserve original material, newest results and explicitly report quota errors', async () => {
  const f = setup();
  try {
    const file = (name: string) => ({ id: randomUUID(), name, bytes: 4, sha256: 'a'.repeat(64), mime: 'application/octet-stream' });
    const old = file('result.txt'), original = file('original.txt'), updated = file('result.txt'), newInput = file('new.txt');
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] }, { inputFiles: [old, original] });
    f.service.enqueue(id, randomUUID(), 'Use the latest files', [newInput]);
    f.finish(f.starts[1], complete()); f.executions.get(f.starts[1].executionID)!.outputFiles = [updated];
    await f.service.advance(id); await f.service.tick();
    assert.deepEqual(f.store.get(id)!.inputFiles.map((v) => v.id), [updated.id, original.id, newInput.id]);
    f.store.update(id, (w) => { w.state = 'completed'; w.planner.attempts = []; w.inputFiles = Array.from({ length: 10 }, (_, i) => file(`material-${i}.txt`)); });
    const next = randomUUID(); f.service.enqueue(id, next, 'Keep every original file', []);
    f.adapter.conversationContext = async () => file('history.json');
    await f.service.tick();
    assert.equal(f.store.get(id)!.queuePaused, true); assert.equal(f.store.get(id)!.queueError, 'workflow_input_quota');
    assert.notEqual(f.store.get(id)!.roundRequestID, next); assert.equal(f.store.get(id)!.inputFiles.length, 10);
    f.restart(); await f.service.tick(); assert.equal(f.store.get(id)!.queuePaused, true);
  } finally { await f.service.close(); f.db.close(); }
});

const readyPlan = (f: ReturnType<typeof setup>, steps: WorkflowStepPlan[], target: WorkflowRequest['target'] = { mode: 'automatic' }) => {
  const value = f.create({ requestID: randomUUID(), target });
  f.store.update(value.id, (w) => { w.state = 'running'; w.planVersion = 1; w.summary = 'Automatic placement'; w.steps = steps.map(workflowStep); });
  return value.id;
};
const resource = { nodeID: B, workspaceID: '00000000-0000-4000-8000-000000000001', id: 'a'.repeat(64), revision: 'b'.repeat(64) };
const inputFile = { id: '00000000-0000-4000-8000-000000000002', name: 'material.txt', bytes: 4, sha256: 'c'.repeat(64), mime: 'text/plain' };

test('automatic branches choose separate Nodes across asynchronous retrieval, staging and admission with stale load reports', async () => {
  for (const waitingAt of ['materialize', 'stageInputs', 'dispatch'] as const) {
    const f = setup();
    try {
      f.adapter.candidates = () => [B, C].map((nodeID) => ({ nodeID, kind: 'remote', waitingCount: 0 }));
      const dispatch = f.adapter.dispatch;
      f.adapter.dispatch = async (...args) => { if (waitingAt === 'dispatch') await Promise.resolve(); return dispatch(...args); };
      f.adapter.materialize = async () => { if (waitingAt === 'materialize') await Promise.resolve(); return [inputFile]; };
      f.adapter.stageInputs = async (_w, _key, files) => { if (waitingAt === 'stageInputs') await Promise.resolve(); return files; };
      const id = readyPlan(f, [step('video'), step('audio')].map((s) => ({ ...s, resources: [resource] })));
      await f.service.advance(id);
      assert.deepEqual(f.starts.map((a) => a.nodeID), [B, C], waitingAt);
      assert.equal(new Set(f.starts.map((a) => a.executionID)).size, 2);
      assert(f.store.get(id)!.steps.every((s) => s.attempts.length === 1 && s.attempts[0].phase === 'queued'));
      // Already admitted executions also count while a subsequent remote report still says zero.
      const next = readyPlan(f, [step('image'), step('text')]); await f.service.advance(next);
      assert.deepEqual(f.starts.slice(2).map((a) => a.nodeID), [B, C]);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('placement reservations are shared across concurrently advancing workflows', async () => {
  const f = setup();
  try {
    f.adapter.candidates = () => [B, C].map((nodeID) => ({ nodeID, kind: 'remote', waitingCount: 0 }));
    f.adapter.materialize = async () => { await Promise.resolve(); return []; };
    for (let i = 0; i < 4; i++) readyPlan(f, [{ ...step('independent'), resources: [resource] }]);
    await f.service.tick();
    assert.equal(f.starts.filter((a) => a.nodeID === B).length, 2);
    assert.equal(f.starts.filter((a) => a.nodeID === C).length, 2);
  } finally { await f.service.close(); f.db.close(); }
});

test('preferred Nodes break load ties while locked targets and bound continuations stay on their required Node', async () => {
  for (const mode of ['preferred', 'planned', 'locked', 'continuation'] as const) {
    const f = setup();
    try {
      f.adapter.candidates = () => [B, C].map((nodeID) => ({ nodeID, kind: 'remote', waitingCount: 0 }));
      const steps = [step('video', [], mode === 'planned' ? B : null), step('audio', [], mode === 'planned' ? B : null)];
      const id = readyPlan(f, steps, mode === 'preferred' || mode === 'locked' ? { mode, nodeID: B } : { mode: 'automatic' });
      if (mode === 'continuation') f.store.update(id, (w) => { for (const s of w.steps) s.continuation = { nodeID: B, reason: 'Continue on the same Node', handoff: false }; });
      await f.service.advance(id);
      assert.deepEqual(f.starts.map((a) => a.nodeID), mode === 'locked' || mode === 'continuation' ? [B, B] : [B, C], mode);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('restart retains unacknowledged execution load and stopping releases it without duplicating work', async () => {
  const f = setup();
  try {
    f.adapter.candidates = () => [B, C].map((nodeID) => ({ nodeID, kind: 'remote', waitingCount: 0 }));
    f.dropAck(); const first = readyPlan(f, [step('first')]); await f.service.advance(first);
    assert.equal(f.store.get(first)!.steps[0].attempts[0].phase, 'intent');
    f.restart(); const second = readyPlan(f, [step('second')]); await f.service.advance(second);
    assert.deepEqual(f.starts.map((a) => a.nodeID), [B, C]);
    await f.service.advance(first); assert.equal(f.starts.length, 2);
    f.service.control(first, 'stop'); await f.service.advance(first);
    const third = readyPlan(f, [step('third')]); await f.service.advance(third);
    assert.equal(f.starts.at(-1)!.nodeID, B); assert.equal(f.store.get(first)!.state, 'stopped');
  } finally { await f.service.close(); f.db.close(); }
});

test('stopping or failing during preparation releases its reservation and rechecks capability after retrieval', async () => {
  for (const change of ['stop', 'failure', 'capability'] as const) {
    const f = setup();
    try {
      let eligible = [B, C];
      f.adapter.candidates = () => eligible.map((nodeID) => ({ nodeID, kind: 'remote', waitingCount: 0 }));
      let entered!: () => void, release!: () => void;
      const preparing = new Promise<void>((ok) => { entered = ok; }), held = new Promise<void>((ok) => { release = ok; });
      f.adapter.materialize = async () => { entered(); await held; if (change === 'failure') throw new Error('input_failed'); return []; };
      const id = readyPlan(f, [{ ...step('held'), resources: [resource] }]); const pending = f.service.advance(id); await preparing;
      if (change === 'stop') f.service.control(id, 'stop');
      if (change === 'capability') eligible = [C];
      release(); await pending;
      assert.deepEqual(f.starts.map((a) => a.nodeID), change === 'capability' ? [C] : []);
      eligible = [B, C]; const next = readyPlan(f, [step('next')]); await f.service.advance(next);
      assert.equal(f.starts.at(-1)!.nodeID, B);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('pending placements count toward queue confirmation without inventing an admitted execution', async () => {
  const f = setup();
  try {
    f.adapter.candidates = () => [{ nodeID: B, kind: 'remote', waitingCount: 9 }];
    f.adapter.materialize = async () => { await Promise.resolve(); return []; };
    const id = readyPlan(f, [step('video'), step('audio')].map((s) => ({ ...s, resources: [resource] })));
    await f.service.advance(id);
    assert.equal(f.starts.length, 1); const pending = f.store.get(id)!;
    assert.equal(pending.pendingConfirmation?.nodeID, B); assert.equal(pending.pendingConfirmation?.waitingCount, 10);
    assert.equal(pending.steps[1].attempts.length, 0);
    f.service.confirm(id, B); await f.service.advance(id); assert.equal(f.starts.length, 2);
  } finally { await f.service.close(); f.db.close(); }
});

test('planner format correction is bounded, persists across restart and stays on the original Node', async () => {
  const f = setup();
  try {
    const value = f.create({ target: { mode: 'preferred', nodeID: B } }); await f.service.advance(value.id);
    for (let round = 0; round < 3; round++) {
      const attempt = f.starts.at(-1)!;
      f.executions.set(attempt.executionID, { phase: 'failed', summary: '', error: 'workflow_invalid_outcome', outcome: null, outputFiles: [], safeToTransfer: false });
      await f.service.advance(value.id); f.restart(); await f.service.advance(value.id);
      assert.equal(f.starts.length, Math.min(round + 2, 3));
    }
    const failed = f.store.get(value.id)!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.planner.validationRounds, 2); assert.equal(failed.steps.length, 0);
    assert(f.starts.every((a) => a.nodeID === B && a.context.role === 'planner'));
    assert.match(f.starts[1].context.priorContext, /1\/2/); assert.match(f.starts[2].context.priorContext, /2\/2/);
    assert(failed.planner.attempts.every((a) => a.handled && a.error === 'workflow_invalid_outcome'));
    const retried = f.service.control(value.id, 'retry_planning');
    assert.equal(retried.id, value.id); assert.equal(retried.planner.attempts.length, 3);
    assert.throws(() => f.service.control(value.id, 'retry_planning'), /invalid_control/);
    await f.service.advance(value.id); assert.equal(f.starts.length, 4);
    f.finish(f.starts[3], { kind: 'plan', plan: { summary: 'Recovered', steps: [step('business')] } });
    await f.service.advance(value.id);
    assert.deepEqual(f.starts.map((a) => a.context.role), ['planner', 'planner', 'planner', 'planner', 'executor']);
    assert.throws(() => f.service.control(value.id, 'retry_planning'), /invalid_control/);
  } finally { f.db.close(); }
});

test('paused format correction waits for resume and stop cancels the undispatched correction', async () => {
  for (const action of ['resume', 'stop'] as const) {
    const f = setup();
    try {
      const value = f.create(); await f.service.advance(value.id); f.service.control(value.id, 'pause');
      f.finish(f.starts[0], null); await f.service.advance(value.id);
      assert.equal(f.store.get(value.id)!.state, 'paused'); assert.equal(f.store.get(value.id)!.planner.state, 'ready');
      f.restart(); await f.service.advance(value.id); assert.equal(f.starts.length, 1);
      f.service.control(value.id, action); await f.service.advance(value.id);
      assert.equal(f.starts.length, action === 'resume' ? 2 : 1);
      if (action === 'stop') assert.equal(f.store.get(value.id)!.state, 'stopped');
    } finally { f.db.close(); }
  }
});

test('format handling never retries business execution or unknown planner delivery', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Work', steps: [step('business')] });
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', error: 'workflow_invalid_outcome', outcome: null, outputFiles: [], safeToTransfer: false });
    await f.service.advance(id); f.restart(); await f.service.advance(id);
    assert.equal(f.starts.length, 2); assert.equal(f.store.get(id)!.state, 'failed');
    assert.throws(() => f.service.control(id, 'retry_planning'), /invalid_control/);
    const value = f.create({ requestID: randomUUID() }); await f.service.advance(value.id);
    f.executions.set(f.starts[2].executionID, { phase: 'unknown', summary: '', error: 'workflow_invalid_outcome', outcome: null, outputFiles: [], safeToTransfer: false });
    await f.service.advance(value.id); f.restart(); await f.service.advance(value.id);
    assert.equal(f.starts.length, 3); assert.equal(f.store.get(value.id)!.planner.attempts.length, 1);
  } finally { f.db.close(); }
});

test('original user constraints survive narrowed plans, handoff and evidence trimming', async () => {
  const f = setup();
  try {
    const description = '范围说明。'.repeat(1800) + '\n禁止运行目录命令；只能写合成目录。END-CONSTRAINT';
    f.adapter.evidence = () => '目录事实。'.repeat(5000);
    const id = await f.planned({ summary: 'Narrowed plan', steps: [{ ...step('handoff'), instructions: '保存进度。'.repeat(700) }] },
      { description, criteria: '最终文件必须叫 final.mp4' });
    assert(f.starts[1].context.priorContext.includes(description)); assert.match(f.starts[1].context.priorContext, /最终文件必须叫 final\.mp4/);
    assert(f.starts[1].context.priorContext.startsWith(`本次实际执行 Node：${f.starts[1].nodeID}`));
    f.finish(f.starts[1], { kind: 'handoff', nodeID: B, reason: 'Required tool', checkpoint: 'Saved progress', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts[2].nodeID, B); assert(f.starts[2].context.priorContext.includes(description));
    assert(f.starts[2].context.priorContext.startsWith(`本次实际执行 Node：${B}`));
    assert.match(f.starts[2].context.priorContext, /本次接收上一个 Node 的转交/);
    assert.equal(f.starts[2].context.instructions, 'Saved progress', 'The target continues the checkpoint instead of repeating source instructions');
    assert.equal(f.store.get(id)!.steps[0].instructions, '保存进度。'.repeat(700), 'The original plan stays available in history');
    assert.match(f.starts[2].context.priorContext, /Saved progress/); assert(Buffer.byteLength(JSON.stringify(f.starts[2].context)) <= 55_000);
  } finally { f.db.close(); }
});

test('history capability selects legacy attachments while structured handoff preserves confirmed constraints', async () => {
  const f = setup();
  try {
    let legacy = true;
    const descriptor = { id: randomUUID(), name: 'rivloom-conversation-1.json', bytes: 10, sha256: 'a'.repeat(64), mime: 'application/octet-stream' };
    f.adapter.candidates = () => [{ nodeID: B, kind: 'remote', waitingCount: 0, history: !legacy }];
    f.adapter.legacyHistory = async (_value, candidate) => candidate.history === false ? descriptor : undefined;
    const value = f.create();
    const state = f.store.history.state(value);
    f.store.history.note(value, { requestID: randomUUID(), expectedVersion: state.version, kind: 'constraint', text: 'Preserve material',
      source: { id: state.goal.id, revision: state.goal.revision, quote: 'material' } }, 'user');
    await f.service.advance(value.id);
    assert(f.starts[0].inputFiles.some(file => file.id === descriptor.id));
    assert.match(f.starts[0].context.priorContext, /Preserve material/);
    assert.match(f.starts[0].context.priorContext, /不支持历史检索工具/);
    assert(!f.starts[0].context.priorContext.includes('Use rivloom_history'));
    f.finish(f.starts[0], { kind: 'plan', plan: { summary: 'Plan', steps: [step('work')] } });
    legacy = false; await f.service.advance(value.id);
    assert.equal(f.starts[1].inputFiles.length, 0); assert.match(f.starts[1].context.priorContext, /Use rivloom_history/);
    assert.match(f.starts[1].context.priorContext, /"authority":"user"/);
  } finally { await f.service.close(); f.db.close(); }
});

test('late clarification after round admission refreshes historical sources without losing the previous revision', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    const oldExecution = f.starts[1].executionID, question = randomUUID();
    f.service.recordAnswers(oldExecution, question, ['Format?'], [['PNG']]);
    f.finish(f.starts[1], complete()); f.service.enqueue(id, randomUUID(), 'Next round', []);
    await f.service.advance(id); await f.service.tick();
    let value = f.store.get(id)!; assert.equal(value.rounds?.length, 1);
    const before = f.store.history.query(value, { action: 'search', text: 'Format?', round: 1 }) as { entries: { id: string; revision: string }[] };
    assert.equal(before.entries.length, 1);
    f.service.recordAnswers(oldExecution, question, ['Format?'], [['JPG']]);
    value = f.store.get(id)!;
    const after = f.store.history.query(value, { action: 'search', text: 'JPG', round: 1 }) as typeof before;
    assert.equal(after.entries[0].id, before.entries[0].id); assert.notEqual(after.entries[0].revision, before.entries[0].revision);
    const old = f.store.history.query(value, { action: 'read', id: before.entries[0].id, revision: before.entries[0].revision }) as { content: string };
    assert(old.content.includes('PNG'));
  } finally { await f.service.close(); f.db.close(); }
});

test('requests that cannot fit with step instructions fail instead of trimming original constraints', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Too large', steps: [{ ...step('large'), instructions: '文'.repeat(12_000) }] }, { description: '界'.repeat(12_000) });
    await f.service.advance(id); assert.equal(f.starts.length, 1);
    assert.equal(f.store.get(id)!.state, 'failed'); assert.equal(f.store.get(id)!.error, 'workflow_context_limit');
  } finally { f.db.close(); }
});

test('editing an unstarted step during material retrieval discards the old preparation', async () => {
  const f = setup();
  try {
    let entered!: () => void; const preparing = new Promise<void>((ok) => { entered = ok; });
    let release!: () => void; const held = new Promise<void>((ok) => { release = ok; });
    f.adapter.materialize = async () => { entered(); await held; return []; };
    const plannedStep = step('edit'); plannedStep.resources = [{ nodeID: B, workspaceID: randomUUID(), id: 'a'.repeat(64), revision: 'b'.repeat(64) }];
    const value = f.create(); await f.service.advance(value.id); f.finish(f.starts[0], { kind: 'plan', plan: { summary: 'edit', steps: [plannedStep] } });
    const pending = f.service.advance(value.id); await preparing;
    const current = f.store.get(value.id)!;
    f.service.editStep(value.id, current.version, { ...plannedStep, instructions: 'Updated requirements', resources: [] });
    release(); await pending; assert.equal(f.starts.length, 1);
    await f.service.advance(value.id); assert.equal(f.starts.length, 2); assert.equal(f.starts[1].context.instructions, 'Updated requirements');
  } finally { f.db.close(); }
});

test('workflow creation is idempotent per owner and content; admission ACK loss and restart reuse the execution', async () => {
  const f = setup();
  try {
    const value = f.create(); assert.equal(f.create().id, value.id);
    assert.throws(() => f.create({ description: 'different' }), /workflow_request_conflict/);
    assert.notEqual(f.create({ creatorID: 'other' }).id, value.id);
    f.dropAck(); await f.service.advance(value.id);
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(value.id)!.planner.attempts[0].phase, 'intent');
    f.restart(); await f.service.advance(value.id); await f.service.advance(value.id);
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(value.id)!.planner.attempts[0].phase, 'queued');
    f.executions.delete(f.starts[0].executionID); await f.service.advance(value.id); await f.service.advance(value.id);
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(value.id)!.planner.attempts[0].phase, 'unknown');
  } finally { f.db.close(); }
});
test('parallel branches start independently, joins require every dependency and failures block only descendants', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'parallel', steps: [step('script'), step('video', ['script'], B), step('audio', ['script'], C), step('edit', ['video', 'audio'])] });
    assert.deepEqual(f.starts.map((a) => a.context.stepID), ['planner', 'script']);
    f.finish(f.starts[1], complete() as never); await f.service.advance(id);
    assert.deepEqual(f.starts.slice(2).map((a) => [a.context.stepID, a.nodeID]), [['video', B], ['audio', C]]);
    const video = f.starts[2]; const audio = f.starts[3];
    f.executions.set(video.executionID, { phase: 'failed', error: 'missing material', summary: '', outcome: null, outputFiles: [], safeToTransfer: true });
    await f.service.advance(id);
    assert.equal(f.store.get(id)!.steps.find((s) => s.id === 'edit')!.state, 'blocked');
    assert.equal(f.store.get(id)!.state, 'running');
    f.finish(audio, complete() as never); await f.service.advance(id);
    assert.equal(f.store.get(id)!.state, 'failed'); assert.equal(f.starts.length, 4);
  } finally { f.db.close(); }
});
test('pause accepts finished results without dispatching dependents; stale graph edits are rejected', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'sequence', steps: [step('first'), step('second', ['first'])] });
    const version = f.store.get(id)!.version;
    f.service.control(id, 'pause'); f.finish(f.starts[1], complete('checkpoint') as never); await f.service.advance(id);
    assert.equal(f.starts.length, 2); assert.equal(f.store.get(id)!.state, 'paused');
    assert.throws(() => f.service.editStep(id, version, step('second', ['first'], B)), /workflow_version_conflict/);
    f.service.editStep(id, f.store.get(id)!.version, step('second', ['first'], B));
    f.service.control(id, 'resume'); await f.service.advance(id);
    assert.equal(f.starts[2].nodeID, B); assert.match(f.starts[2].context.priorContext, /checkpoint/);
    f.finish(f.starts[2], complete() as never); await f.service.advance(id); assert.equal(f.store.get(id)!.state, 'completed');
  } finally { f.db.close(); }
});
test('stop fences dispatch races, retains unknown stops and never continues a stopped graph', async () => {
  const f = setup();
  try {
    const value = f.create(); f.beforeDispatch(() => f.service.control(value.id, 'stop'));
    await f.service.advance(value.id); assert.equal(f.starts.length, 0);
    f.uncertainStop(true); await f.service.advance(value.id);
    assert.equal(f.store.get(value.id)!.state, 'stopping'); assert.equal(f.store.get(value.id)!.planner.attempts[0].phase, 'unknown');
    f.restart(); f.uncertainStop(false); await f.service.advance(value.id);
    assert.equal(f.store.get(value.id)!.state, 'stopped'); await f.service.advance(value.id); assert.equal(f.starts.length, 0);
  } finally { f.db.close(); }
});
test('queue confirmation belongs to the actual target and locked plans cannot escape through a handoff', async () => {
  const f = setup();
  try {
    f.setQueue(10); const value = f.create({ target: { mode: 'locked', nodeID: B } });
    await f.service.advance(value.id); assert.equal(f.starts.length, 0); assert.equal(f.store.get(value.id)!.pendingConfirmation?.nodeID, B);
    assert.throws(() => f.service.confirm(value.id, A), /workflow_confirmation_changed/);
    f.service.confirm(value.id, B); await f.service.advance(value.id); assert.equal(f.starts[0].nodeID, B);
    f.finish(f.starts[0], { kind: 'plan', plan: { summary: 'one step', steps: [step('edit')] } });
    await f.service.advance(value.id); assert.equal(f.starts[1].nodeID, B);
    f.finish(f.starts[1], { kind: 'handoff', nodeID: C, reason: 'needs gpu', checkpoint: '', files: [], processesStopped: true });
    await f.service.advance(value.id); assert.equal(f.store.get(value.id)!.state, 'failed'); assert.equal(f.starts.length, 2);
    assert.equal(f.store.get(value.id)!.steps[0].attempts[0].error, 'workflow_locked_handoff');
  } finally { f.db.close(); }
});
test('planner queries are data operations and bounded continuations preserve the execution node', async () => {
  const f = setup();
  try {
    const value = f.create({ target: { mode: 'preferred', nodeID: B } }); await f.service.advance(value.id);
    const query = { text: 'video', kinds: [], limit: 10 };
    // Query uses the actual shared shape, no execution is created by the adapter query.
    for (let round = 0; round < 5; round++) {
      f.finish(f.starts.at(-1)!, { kind: 'query', query, reason: 'Find material' } as never);
      await f.service.advance(value.id);
      if (round < 4) assert.equal(f.starts.at(-1)!.nodeID, B);
    }
    assert.equal(f.queries, 4); assert.equal(f.starts.length, 5); assert.equal(f.store.get(value.id)!.state, 'failed');
  } finally { f.db.close(); }
});
test('handoff persists source/target attempts, excludes previous nodes and waits for independent quiescence', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'edit', steps: [step('edit')] });
    f.finish(f.starts[1], { kind: 'handoff', nodeID: B, reason: 'ffmpeg available on B', checkpoint: 'script written', files: [], processesStopped: true });
    await f.service.advance(id); const transferred = f.starts[2]; assert.equal(transferred.nodeID, B);
    assert.match(transferred.context.priorContext, /script written/); assert.equal(f.store.get(id)!.handoffs[0].phase, 'queued');
    // A late source result cannot replace the current execution outcome.
    f.finish(f.starts[1], complete('late source') as never); await f.service.advance(id);
    assert.equal(f.store.get(id)!.steps[0].state, 'running');
    f.finish(transferred, { kind: 'handoff', nodeID: C, reason: 'more memory', checkpoint: '', files: [], processesStopped: true }, false);
    await f.service.advance(id); assert.equal(f.starts.length, 3);
    assert.equal(f.store.get(id)!.steps[0].attempts[1].error, 'workflow_source_not_quiescent');
  } finally { f.db.close(); }
});
test('execution expansion rewires pending dependents through the new leaves and retains one workflow', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'expand', steps: [step('prepare'), step('publish', ['prepare'])] });
    f.finish(f.starts[1], { kind: 'expand', plan: { summary: 'need two materials', steps: [step('video', [], B), step('audio', [], C)] }, checkpoint: 'script ready', files: [] });
    await f.service.advance(id);
    const value = f.store.get(id)!; const added = value.steps.slice(2);
    assert.deepEqual(value.steps[1].dependsOn, added.map((s) => s.id)); assert(added.every((s) => s.dependsOn[0] === 'prepare'));
    assert.equal(f.starts.length, 4); assert.equal(f.store.list().length, 1);
    f.finish(f.starts[2], complete() as never); await f.service.advance(id); assert.equal(f.starts.length, 4);
    f.finish(f.starts[3], complete() as never); await f.service.advance(id); assert.equal(f.starts[4].context.stepID, 'publish');
  } finally { f.db.close(); }
});

test('a completed three-node handoff chain closes each transfer without rewriting earlier attempts', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Relay', steps: [step('relay')] });
    f.finish(f.starts[1], { kind: 'handoff', nodeID: B, reason: 'Second Node', checkpoint: 'A read the history', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts[2].nodeID, B);
    const firstAttempt = structuredClone(f.store.get(id)!.steps[0].attempts[0]);
    f.finish(f.starts[2], { kind: 'handoff', nodeID: C, reason: 'Third Node', checkpoint: 'B read the history', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts[3].nodeID, C);
    assert.deepEqual(f.store.get(id)!.handoffs.map(h => h.phase), ['completed', 'queued']);
    f.restart(); f.finish(f.starts[3], complete('All three Nodes read the history'));
    await f.service.advance(id); await f.service.tick();
    const done = f.store.get(id)!;
    assert.equal(done.state, 'completed');
    assert.deepEqual(done.handoffs.map(h => h.phase), ['completed', 'completed']);
    assert.deepEqual(done.steps[0].attempts[0], firstAttempt);
    assert.deepEqual(done.steps[0].attempts.map(a => a.nodeID), [A, B, C]);
  } finally { await f.service.close(); f.db.close(); }
});
