import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore, workflowStep, type WorkflowRequest } from '../server/workflows.ts';
import { WorkflowService, type WorkflowExecutionAdapter, type WorkflowExecutionSnapshot } from '../server/workflow-service.ts';
import { validWorkflowExecutionContext, type ExecutionOutcome, type WorkflowAttempt, type WorkflowPlan, type WorkflowStepPlan } from '../shared/workflows.ts';
import { workflowUsesPlacementContract } from '../shared/workflow-origin.ts';

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
const placedStep = (id: string, required: string | null = null, dependsOn: string[] = [], preferred: string | null = null): WorkflowStepPlan => ({
  ...step(id, dependsOn, preferred), instructions: JSON.stringify(required ?
    { rivloomPlacement: 1, mode: 'required', nodeID: required, reason: 'Model determined the required device' } :
    { rivloomPlacement: 1, mode: 'free', reason: 'Model determined this work is portable' }) + `\nComplete ${id}`,
});
function setup() {
  const db = new DatabaseSync(':memory:'); const store = new WorkflowStore(db);
  const executions = new Map<string, WorkflowExecutionSnapshot>(); const starts: WorkflowAttempt[] = [];
  let queries = 0; let waitingCount = 0; let dropAfterAdmission = false; let stopUnknown = false;
  let beforeDispatch: (() => void) | null = null;
  const adapter: WorkflowExecutionAdapter = {
    placementNodes: () => [A, B, C].map(nodeID => ({ nodeID, name: `Fixture ${nodeID[0]}` })),
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

function idleRemoteBusyOrigin(f: ReturnType<typeof setup>, includeOrigin = true, backlog = 5) {
  f.adapter.candidates = () => [{ nodeID: B, kind: 'remote', waitingCount: 0 },
    ...(includeOrigin ? [{ nodeID: A, kind: 'local' as const, waitingCount: backlog }] : [])];
}

test('remote planning binds only the model-selected business step, its continuation and retry to the origin', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const value = f.create({ originNodeID: A, placementPolicy: 'placement-v1', description: '看下这台机器信息' });
    await f.service.advance(value.id);
    assert.equal(f.starts[0].nodeID, B);
    assert.deepEqual(f.starts[0].context.target, { mode: 'automatic' });
    assert(workflowUsesPlacementContract(f.starts[0].context));
    assert(validWorkflowExecutionContext(f.starts[0].context), 'wire context retains its exact existing fields');
    assert.match(f.starts[0].context.priorContext, new RegExp(`发起任务的 Node：${A}`));
    const raw = { kind: 'plan' as const, plan: { summary: 'Machine information', steps: [placedStep('inspect', 'origin', [], B)] } };
    f.finish(f.starts[0], raw);
    await f.service.advance(value.id);
    assert.equal(f.starts[1].nodeID, A, 'soft preference B cannot escape the independently required origin');
    assert.deepEqual(f.starts[1].context.target, { mode: 'locked', nodeID: A });
    assert.equal(f.starts[1].context.instructions, 'Complete inspect');
    assert.deepEqual(f.store.get(value.id)!.planner.attempts[0].outcome, raw, 'raw outcome remains bound and unmodified');
    assert.equal(f.store.get(value.id)!.steps[0].instructions, 'Complete inspect');
    assert.equal(f.store.get(value.id)!.steps[0].placement?.mode, 'required');
    f.finish(f.starts[1], { kind: 'query', query: { text: 'Machine capabilities', kinds: [], limit: 5 }, reason: 'Need facts', checkpoint: 'pending', files: [] });
    await f.service.advance(value.id);
    assert.equal(f.starts[2].nodeID, A);
    f.executions.set(f.starts[2].executionID, { phase: 'failed', summary: '', error: 'fixture failure', outcome: null, outputFiles: [], safeToTransfer: true });
    await f.service.advance(value.id);
    const failed = f.store.get(value.id)!;
    await f.service.retryStep(value.id, { version: failed.version, roundRequestID: failed.requestID, stepID: 'inspect', attempt: 2, requestID: randomUUID() });
    f.restart(); await f.service.advance(value.id);
    assert.equal(f.starts.at(-1)!.nodeID, A);
    f.finish(f.starts.at(-1)!, { kind: 'handoff', nodeID: B, reason: 'Another Node is idle', checkpoint: 'No changes', processesStopped: true, files: [] });
    await f.service.advance(value.id);
    assert.equal(f.store.get(value.id)!.error, 'workflow_locked_handoff');
    assert(f.starts.slice(1).every(a => a.nodeID === A));
  } finally { await f.service.close(); f.db.close(); }
});

test('a missing local model does not block remote planning but a required local business step waits for its device', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f, false);
    const value = f.create({ originNodeID: A, placementPolicy: 'placement-v1', description: '查看本机系统信息' });
    await f.service.advance(value.id);
    assert.equal(f.starts[0].nodeID, B); assert.equal(f.store.get(value.id)!.state, 'planning');
    f.finish(f.starts[0], { kind: 'plan', plan: { summary: 'Check origin', steps: [placedStep('inspect', 'origin')] } });
    await f.service.advance(value.id);
    assert.equal(f.starts.length, 1, 'missing local model/capability cannot move a business step to a remote machine');
    assert.equal(f.store.get(value.id)!.steps[0].state, 'ready');
    assert.throws(() => f.service.editStep(value.id, f.store.get(value.id)!.version, step('inspect', [], B)), /placement_conflict/);
    f.service.editStep(value.id, f.store.get(value.id)!.version, { ...step('inspect'), instructions: 'Updated business detail' });
    assert.equal(f.store.get(value.id)!.steps[0].placement?.mode, 'required');
    idleRemoteBusyOrigin(f, true, 12); await f.service.advance(value.id);
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(value.id)!.pendingConfirmation?.nodeID, A);
    f.service.confirm(value.id, A); await f.service.advance(value.id);
    assert.equal(f.starts[1].nodeID, A);
  } finally { await f.service.close(); f.db.close(); }
});

test('arbitrary wording and criteria reach the model while its placement decision controls dispatch', async () => {
  for (const criteria of ['完成会话要求，说明结果、验证情况和仍需处理的问题。',
    "Complete the conversation's requirements. Describe the result, verification, and any remaining issues.", 'Compare this computer with the server and write a report']) {
    const f = setup();
    try {
      idleRemoteBusyOrigin(f);
      const value = f.create({ originNodeID: A, placementPolicy: 'placement-v1', description: 'Can you tell me about the computer I am using, then prepare something useful?', criteria });
      await f.service.advance(value.id); assert.equal(f.starts[0].nodeID, B);
      f.finish(f.starts[0], { kind: 'plan', plan: { summary: 'Local information', steps: [placedStep('inspect', 'origin')] } });
      await f.service.advance(value.id); assert.equal(f.starts[1].nodeID, A);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('a new contract never treats missing placement as free and format correction is bounded', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const value = f.create({ originNodeID: A, placementPolicy: 'placement-v1', description: '任意用户请求' }); await f.service.advance(value.id);
    for (let index = 0; index < 3; index++) {
      f.finish(f.starts.at(-1)!, { kind: 'plan', plan: { summary: 'Missing placement', steps: [step('inspect', [], B)] } });
      await f.service.advance(value.id);
    }
    assert.equal(f.store.get(value.id)!.error, 'workflow_placement_header_invalid'); assert.equal(f.starts.length, 3);
    assert(f.starts.every(attempt => attempt.context.role === 'planner' && attempt.nodeID === B));
    assert.equal(f.store.get(value.id)!.steps.length, 0);
    f.service.control(value.id, 'retry_planning'); f.restart(); await f.service.advance(value.id);
    assert.equal(f.starts.at(-1)!.nodeID, B); assert.equal(f.starts.at(-1)!.placementPolicy, 'placement-v1');
  } finally { await f.service.close(); f.db.close(); }
});

test('origin binding is per current round and preserves explicit targets and legacy request retries', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const id = await f.planned({ summary: 'Local', steps: [placedStep('inspect', 'origin')] }, { originNodeID: A, placementPolicy: 'placement-v1', description: '查看本机信息' });
    f.finish(f.starts[1], complete()); await f.service.advance(id);
    f.service.enqueue(id, randomUUID(), '为服务器生成一份报告', [], undefined, undefined, A, 'placement-v1'); await f.service.tick(); await f.service.tick();
    assert.equal(f.starts[2].nodeID, B, 'historical local request cannot lock an unrelated round');
    assert.deepEqual(f.starts[2].context.target, { mode: 'automatic' });
    assert.equal(f.store.get(id)!.originNodeID, A);
    assert.match(f.starts[2].context.priorContext, new RegExp(`发起任务的 Node：${A}`));
    assert.match(f.starts[2].context.priorContext, new RegExp(`本次实际执行 Node：${B}`));
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'Portable report', steps: [placedStep('report')] } });
    await f.service.advance(id); assert.equal(f.starts[3].nodeID, B, 'model output cannot establish a new origin constraint');
    f.finish(f.starts[3], complete()); await f.service.advance(id);
    f.service.enqueue(id, randomUUID(), '列出本机当前目录', [], undefined, undefined, A, 'placement-v1'); await f.service.tick(); await f.service.tick();
    assert.equal(f.starts[4].nodeID, B, 'planner remains freely schedulable for another local query');
    f.finish(f.starts[4], { kind: 'plan', plan: { summary: 'Local directory', steps: [placedStep('directory', 'origin')] } });
    await f.service.advance(id); assert.equal(f.starts[5].nodeID, A);
    for (const mode of ['preferred', 'locked'] as const) {
      const value = f.create({ requestID: randomUUID(), originNodeID: A, description: '查看本机信息', target: { mode, nodeID: B } });
      await f.service.advance(value.id); assert.equal(f.starts.at(-1)!.nodeID, B, mode);
    }
    const request = { ...f.request, requestID: randomUUID(), description: '查看本机信息' };
    const legacy = f.service.create(request);
    assert.equal(f.service.create({ ...request, originNodeID: A }).contentDigest, legacy.contentDigest);
    assert.equal(f.store.get(legacy.id)!.originNodeID, undefined, 'an idempotent retry cannot rewrite a legacy origin');
    await f.service.advance(legacy.id); assert.equal(f.starts.at(-1)!.nodeID, B);
    assert.match(f.starts.at(-1)!.context.priorContext, /未记录发起 Node/);
    assert.throws(() => f.create({ requestID: randomUUID(), originNodeID: 'invalid' }), /invalid_workflow_request/);
  } finally { await f.service.close(); f.db.close(); }
});

test('a new user round upgrades a legacy conversation with its trusted origin without rewriting old work', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const id = await f.planned({ summary: 'Legacy', steps: [step('old')] });
    f.finish(f.starts[1], complete()); await f.service.advance(id);
    const previous = structuredClone(f.store.get(id)!);
    const requestID = randomUUID();
    f.service.enqueue(id, requestID, '你看下这台机器信息', [], undefined, undefined, A, 'placement-v1');
    assert.equal(f.store.get(id)!.originNodeID, undefined, 'active/historical round is not retrofitted on receipt');
    assert.equal(f.store.get(id)!.messages![0].originNodeID, A);
    f.service.enqueue(id, requestID, '你看下这台机器信息', [], undefined, undefined, B, 'placement-v1');
    assert.equal(f.store.get(id)!.messages![0].originNodeID, A, 'replays preserve the originally captured trusted identity');
    f.restart(); await f.service.tick(); await f.service.tick();
    const current = f.store.get(id)!;
    assert.equal(current.originNodeID, A); assert.equal(current.rounds![0].originNodeID, undefined);
    assert.equal(current.placementPolicy, 'placement-v1'); assert.equal(current.rounds![0].placementPolicy, undefined);
    assert.deepEqual(current.rounds![0].planner, previous.planner); assert.deepEqual(current.rounds![0].steps, previous.steps);
    assert.equal(f.starts[2].nodeID, B); assert.deepEqual(f.starts[2].context.target, { mode: 'automatic' });
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'New bound step', steps: [placedStep('inspect', 'origin')] } });
    await f.service.advance(id); assert.equal(f.starts[3].nodeID, A);
    assert.throws(() => f.service.enqueue(id, randomUUID(), '查看本机信息', [], undefined, undefined, 'bad'), /invalid_workflow_request/);
  } finally { await f.service.close(); f.db.close(); }
});

test('one semantic plan can require different devices and freely schedule a portable branch', async () => {
  const f = setup();
  try {
    f.adapter.candidates = () => [{ nodeID: B, kind: 'remote', waitingCount: 0 }, { nodeID: A, kind: 'local', waitingCount: 5 }, { nodeID: C, kind: 'remote', waitingCount: 7 }];
    const id = await f.planned({ summary: 'Inspect two devices and prepare a portable report', steps: [
      placedStep('origin', 'origin', [], B), placedStep('named', C, [], A), placedStep('portable', null, [], C),
    ] }, { originNodeID: A, placementPolicy: 'placement-v1', description: '检查我正在使用的电脑和另一台服务器，再整理建议', criteria: 'Use any suitable device for the portable work' });
    assert.equal(f.starts[0].nodeID, B, 'planning may use the idle remote model');
    const starts = new Map(f.starts.slice(1).map(a => [a.context.stepID, a]));
    assert.equal(starts.get('origin')!.nodeID, A); assert.equal(starts.get('named')!.nodeID, C);
    assert.equal(starts.get('portable')!.nodeID, B, 'free uses current load rather than a soft preference');
    assert.deepEqual(starts.get('named')!.context.target, { mode: 'locked', nodeID: C });
    assert.deepEqual(starts.get('portable')!.context.target, { mode: 'automatic' });
    assert(f.store.get(id)!.steps.every(s => !s.instructions.includes('rivloomPlacement')));
  } finally { await f.service.close(); f.db.close(); }
});

test('required expansion cannot weaken its parent while free clarification can expand into independently placed work', async () => {
  for (const escape of [placedStep('child'), placedStep('child', B)]) {
    const f = setup();
    try {
      idleRemoteBusyOrigin(f);
      const id = await f.planned({ summary: 'Required origin', steps: [placedStep('inspect', 'origin')] }, { originNodeID: A, placementPolicy: 'placement-v1' });
      f.finish(f.starts[1], { kind: 'expand', plan: { summary: 'Would escape', steps: [escape] }, checkpoint: 'Saved', files: [] });
      await f.service.advance(id);
      assert.equal(f.store.get(id)!.error, 'workflow_placement_conflict');
      assert.equal(f.starts.length, 2); assert.equal(f.store.get(id)!.steps.length, 1);
    } finally { await f.service.close(); f.db.close(); }
  }
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const id = await f.planned({ summary: 'Clarify first', steps: [placedStep('clarify')] }, { originNodeID: A, placementPolicy: 'placement-v1' });
    f.executions.get(f.starts[1].executionID)!.phase = 'waiting';
    await f.service.advance(id); assert.equal(f.starts.length, 2);
    f.service.recordAnswers(f.starts[1].executionID, 'question-1', ['Which machine?'], [['Origin and the named server']]);
    f.finish(f.starts[1], { kind: 'expand', plan: { summary: 'Answered', steps: [placedStep('origin', 'origin'), placedStep('named', B)] }, checkpoint: 'User clarified', files: [] });
    await f.service.advance(id);
    assert.equal(f.store.get(id)!.steps.length, 3);
    assert.deepEqual(new Set(f.starts.slice(2).map(a => a.nodeID)), new Set([A, B]));
    assert(f.store.get(id)!.steps.slice(1).every(s => s.placement?.mode === 'required'));
  } finally { await f.service.close(); f.db.close(); }
});

test('legacy attempts do not acquire placement semantics from header-like text or later queued rounds', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const value = f.create({ originNodeID: A, description: '看下这台机器信息' });
    await f.service.advance(value.id);
    f.service.enqueue(value.id, randomUUID(), 'A future contract round', [], undefined, undefined, A, 'placement-v1');
    const oldQueued = randomUUID(); f.service.enqueue(value.id, oldQueued, 'A legacy queued message', []);
    const legacyPlan = { summary: 'Legacy header-like business text', steps: [placedStep('work', 'origin', [], A)] };
    f.finish(f.starts[0], { kind: 'plan', plan: legacyPlan }); await f.service.advance(value.id);
    assert.equal(f.starts[1].nodeID, B); assert.equal(f.starts[0].placementPolicy, undefined);
    assert.equal(f.store.get(value.id)!.steps[0].placement, undefined);
    assert.equal(f.store.get(value.id)!.steps[0].instructions, legacyPlan.steps[0].instructions);
    f.finish(f.starts[1], complete()); await f.service.advance(value.id); await f.service.tick(); await f.service.tick();
    assert.equal(f.starts[2].placementPolicy, 'placement-v1');
    f.finish(f.starts[2], { kind: 'plan', plan: { summary: 'New round', steps: [placedStep('new')] } }); await f.service.advance(value.id);
    f.finish(f.starts[3], complete()); await f.service.advance(value.id); await f.service.tick(); await f.service.tick();
    const current = f.store.get(value.id)!;
    assert.equal(current.roundRequestID, oldQueued); assert.equal(current.placementPolicy, undefined); assert.equal(current.originNodeID, undefined);
    assert.equal(f.starts[4].placementPolicy, undefined); assert(!workflowUsesPlacementContract(f.starts[4].context));
    assert.deepEqual(current.rounds?.map(round => round.placementPolicy), [undefined, 'placement-v1']);
  } finally { await f.service.close(); f.db.close(); }
});

test('unknown origin blocks a required-origin result without treating the planner host as the origin', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const id = await f.planned({ summary: 'Unknown origin', steps: [placedStep('inspect', 'origin')] }, { placementPolicy: 'placement-v1' });
    assert.equal(f.starts[0].nodeID, B); assert.equal(f.starts.length, 1);
    assert.equal(f.store.get(id)!.error, 'workflow_placement_origin_unknown');
    assert.equal(f.store.get(id)!.steps.length, 0);
  } finally { await f.service.close(); f.db.close(); }
});

test('the placement contract preserves near-limit original requirements through execution and handoff', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const description = 'R'.repeat(11_980) + ' END-ORIGINAL-SCOPE';
    const criteria = 'C'.repeat(200) + ' END-CRITERIA';
    f.adapter.evidence = () => 'Resource fact '.repeat(2000);
    const id = await f.planned({ summary: 'Portable work', steps: [placedStep('work')] },
      { originNodeID: A, placementPolicy: 'placement-v1', description, criteria });
    assert.equal(f.starts.length, 2, f.store.get(id)!.error || 'executor should fit');
    const context = f.starts[1].context;
    assert(context.priorContext.includes(description)); assert(context.priorContext.includes(criteria));
    assert(workflowUsesPlacementContract(context)); assert(validWorkflowExecutionContext(context));
    assert(context.priorContext.length <= 16_000);
    f.adapter.candidates = () => [A, B, C].map(nodeID => ({ nodeID, kind: nodeID === A ? 'local' : 'remote', waitingCount: 0 }));
    f.finish(f.starts[1], { kind: 'handoff', nodeID: C, reason: 'Suitable eligible machine', checkpoint: 'Saved work', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts.length, 3, f.store.get(id)!.error || JSON.stringify(f.store.get(id)!.steps[0])); assert.equal(f.starts[2].nodeID, C);
    assert(f.starts[2].context.priorContext.includes(description)); assert(f.starts[2].context.priorContext.includes(criteria));
  } finally { await f.service.close(); f.db.close(); }
});

test('combined maximum text that cannot fit the old context bound fails without dropping original constraints', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [placedStep('work')] },
      { originNodeID: A, placementPolicy: 'placement-v1', description: 'D'.repeat(12_000), criteria: 'C'.repeat(4000) });
    assert.equal(f.starts.length, 1); assert.equal(f.store.get(id)!.error, 'workflow_context_limit');
    assert.equal(f.store.get(id)!.description.length, 12_000); assert.equal(f.store.get(id)!.criteria.length, 4000);
    assert.equal(f.store.get(id)!.steps[0].attempts.length, 0, 'oversized business context is not dispatched');
  } finally { await f.service.close(); f.db.close(); }
});

test('a later handoff that outgrows the fixed context limit does not truncate the original request or dispatch', async () => {
  const f = setup();
  try {
    idleRemoteBusyOrigin(f);
    const description = 'R'.repeat(11_980) + ' END-ORIGINAL-SCOPE', criteria = 'C'.repeat(980) + ' END-CRITERIA';
    const id = await f.planned({ summary: 'Portable work', steps: [placedStep('work')] },
      { originNodeID: A, placementPolicy: 'placement-v1', description, criteria });
    assert.equal(f.starts.length, 2); assert(f.starts[1].context.priorContext.includes(description));
    f.adapter.candidates = () => [A, B, C].map(nodeID => ({ nodeID, kind: nodeID === A ? 'local' : 'remote', waitingCount: 0 }));
    f.finish(f.starts[1], { kind: 'handoff', nodeID: C, reason: 'Suitable machine', checkpoint: 'Saved work', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts.length, 2); assert.equal(f.store.get(id)!.error, 'workflow_context_limit');
    assert.equal(f.store.get(id)!.description, description); assert.equal(f.store.get(id)!.criteria, criteria);
  } finally { await f.service.close(); f.db.close(); }
});

test('retry restores only a failed branch and its blocked descendants, preserving results, queue pause and durable receipts', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Branches', steps: [step('ready'), step('bad'), step('join', ['ready', 'bad'])] });
    const success = f.starts.find((a) => a.context.stepID === 'ready')!, failed = f.starts.find((a) => a.context.stepID === 'bad')!;
    f.finish(success, complete('Keep this answer'));
    f.executions.set(failed.executionID, { phase: 'failed', summary: 'Failed first try', error: 'synthetic_failure', outcome: null, outputFiles: [], safeToTransfer: true });
    await f.service.advance(id);
    f.service.enqueue(id, randomUUID(), 'Do not start the next round', []);
    f.service.messageControl(id, 'pause');
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

test('cancelled messages stay cancelled while failures advance and stop waits for a fresh send', async () => {
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
      if (action === 'stop') {
        assert.equal(f.store.get(id)!.queuePaused, true); assert.equal(f.store.get(id)!.queuePauseReason, 'stopped');
        assert.equal(f.store.get(id)!.rounds, undefined);
        f.service.enqueue(id, randomUUID(), 'Continue with this new request', []);
        assert.equal(f.store.get(id)!.queuePaused, false); await f.service.tick();
      } else {
        assert.equal(!!f.store.get(id)!.queuePaused, false, action);
        assert.equal(f.store.get(id)!.rounds![0].state, 'failed');
        assert.equal(f.store.get(id)!.rounds![0].error, 'execution_failed');
      }
      assert.equal(f.store.get(id)!.roundRequestID, next, action);
      assert.equal(f.store.get(id)!.messages![0].state, 'cancelled');
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('a fresh message after planner or executor failure starts one new round without retrying failed work', async () => {
  for (const role of ['planner', 'executor'] as const) {
    const f = setup();
    try {
      const id = role === 'planner' ? f.create().id : await f.planned({ summary: 'Original plan', steps: [step('work')] });
      if (role === 'planner') await f.service.advance(id);
      const failed = f.starts.at(-1)!, count = f.starts.length;
      f.executions.set(failed.executionID, { phase: 'failed', summary: 'Preserve this failure', outcome: null,
        outputFiles: [], safeToTransfer: false, error: 'execution_failed' });
      await f.service.advance(id);
      const before = f.store.get(id)!;
      assert.equal(before.state, 'failed'); assert.equal(!!before.queuePaused, false);
      const next = randomUUID(); f.service.enqueue(id, next, 'A separate next request', []);
      f.service.enqueue(id, next, 'A separate next request', []); f.restart();
      await Promise.all([f.service.advance(id), f.service.advance(id)]);
      const admitted = f.store.get(id)!;
      assert.equal(admitted.roundRequestID, next); assert.equal(admitted.rounds!.length, 1);
      assert.deepEqual(admitted.rounds![0].planner, before.planner); assert.deepEqual(admitted.rounds![0].steps, before.steps);
      assert.equal(admitted.rounds![0].state, 'failed'); assert.equal(f.starts.length, count);
      f.restart(); await Promise.all([f.service.tick(), f.service.tick()]); await f.service.tick();
      assert.equal(f.starts.length, count + 1); assert.equal(f.starts.at(-1)!.context.role, 'planner');
      assert.notEqual(f.starts.at(-1)!.executionID, failed.executionID);
      assert.equal(f.starts.filter(attempt => attempt.executionID === failed.executionID).length, 1);
      f.service.enqueue(id, next, 'A separate next request', []);
      assert.equal(f.store.get(id)!.messages!.length, 1); assert.equal(f.store.get(id)!.rounds!.length, 1);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('manual queue pause survives failure and replay but a fresh terminal send resumes FIFO', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    const first = randomUUID(); f.service.enqueue(id, first, 'Already queued', []); f.service.messageControl(id, 'pause');
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: true, error: 'execution_failed' });
    await f.service.advance(id); f.restart();
    f.service.enqueue(id, first, 'Already queued', []); await f.service.tick();
    const paused = f.store.get(id)!;
    assert.equal(paused.state, 'failed'); assert.equal(paused.queuePaused, true); assert.equal(paused.queuePauseReason, 'manual');
    assert.equal(paused.rounds, undefined); assert.equal(f.starts.length, 2);
    const next = randomUUID(); f.service.enqueue(id, next, 'New continuation intent', []);
    assert.equal(f.store.get(id)!.queuePaused, false);
    f.service.messageControl(id, 'pause'); f.service.enqueue(id, next, 'New continuation intent', []);
    await f.service.tick(); assert.equal(f.store.get(id)!.rounds, undefined);
    assert.equal(f.store.get(id)!.queuePauseReason, 'manual', 'A replay cannot undo a newer manual pause');
    f.service.enqueue(id, randomUUID(), 'Continue after the later pause', []); await f.service.tick();
    assert.equal(f.store.get(id)!.roundRequestID, first); assert.equal(f.store.get(id)!.queuePauseReason, undefined);
  } finally { await f.service.close(); f.db.close(); }
});

test('legacy failure holds require a fresh message and never resume merely on startup, polling or replay', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Old plan', steps: [step('work')] });
    const queued = randomUUID(); f.service.enqueue(id, queued, 'Previously queued', []);
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: false, error: 'workflow_invalid_outcome' });
    await f.service.advance(id);
    // Older versions stored the same boolean for automatic failure holds and manual queue pause.
    f.store.update(id, value => { value.queuePaused = true; delete value.queuePauseReason; });
    f.restart(); await f.service.tick(); f.service.enqueue(id, queued, 'Previously queued', []); await f.service.tick();
    assert.equal(f.store.get(id)!.queuePaused, true); assert.equal(f.store.get(id)!.rounds, undefined);
    const next = randomUUID(); const resumed = f.service.enqueue(id, next, 'Explicit new continuation intent', []);
    assert.equal(resumed.queuePaused, false);
    f.restart(); await f.service.tick();
    const current = f.store.get(id)!;
    assert.equal(current.roundRequestID, queued, 'The fresh message does not jump ahead of already queued work');
    assert.equal(current.rounds![0].state, 'failed'); assert.equal(current.rounds![0].steps[0].attempts.length, 1);
    assert.equal(current.messages!.length, 2); assert.equal(f.starts.length, 2);
    f.service.messageControl(id, 'pause'); f.service.enqueue(id, next, 'Explicit new continuation intent', []);
    assert.equal(f.store.get(id)!.queuePaused, true, 'A retry of that send cannot undo a later explicit pause');
    assert.equal(f.store.get(id)!.queuePauseReason, 'manual');
  } finally { await f.service.close(); f.db.close(); }
});

test('fresh sends resume safely ended rounds regardless of the previous pause reason', async () => {
  for (const state of ['stopped', 'failed', 'completed'] as const) for (const reason of [undefined, 'manual', 'stopped', 'context_error'] as const) {
    const f = setup();
    try {
      const id = await f.planned({ summary: 'Original plan', steps: [step('work')] });
      if (state === 'stopped') f.service.control(id, 'stop');
      else if (state === 'failed') f.executions.set(f.starts[1].executionID, {
        phase: 'failed', summary: 'Saved failure', outcome: null, outputFiles: [], safeToTransfer: false, error: 'execution_failed',
      });
      else f.finish(f.starts[1], complete('Saved result'));
      await f.service.advance(id);
      f.store.update(id, current => { current.queuePaused = true; current.queuePauseReason = reason;
        if (reason === 'context_error') current.queueError = 'workflow_context_failed'; });
      const before = f.store.get(id)!, next = randomUUID();
      const resumed = f.service.enqueue(id, next, 'Use the saved context for new work', [], 'fixture/next', 'low', A);
      assert.equal(resumed.queuePaused, false); assert.equal(resumed.queuePauseReason, undefined); assert.equal(resumed.queueError, undefined);
      f.restart(); await Promise.all([f.service.tick(), f.service.tick()]);
      const current = f.store.get(id)!;
      assert.equal(current.roundRequestID, next); assert.equal(current.rounds!.length, 1);
      assert.equal(current.rounds![0].state, state); assert.deepEqual(current.rounds![0].steps, before.steps);
      assert.deepEqual(current.rounds![0].planner, before.planner); assert.equal(current.originNodeID, A);
      assert.equal(current.model, 'fixture/next'); assert.equal(current.reasoningEffort, 'low');
      await f.service.tick(); await f.service.tick(); assert.equal(f.starts.length, 3);
      assert.equal(f.starts[2].context.role, 'planner'); assert.notEqual(f.starts[2].executionID, f.starts[1].executionID);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('a fresh send cannot resume active dispatch pause or an unconfirmed stop', async () => {
  for (const control of ['pause', 'stop'] as const) {
    const f = setup();
    try {
      const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
      f.service.control(id, control); if (control === 'stop') f.uncertainStop(true);
      const next = randomUUID(); f.service.enqueue(id, next, 'A new request while control is pending', []);
      await f.service.tick(); f.restart(); await f.service.tick();
      const value = f.store.get(id)!;
      assert.equal(value.state, control === 'pause' ? 'paused' : 'stopping');
      assert.equal(value.rounds, undefined); assert.equal(f.starts.length, 2);
      if (control === 'stop') {
        assert.equal(value.steps[0].attempts[0].phase, 'unknown'); assert.equal(value.queuePaused, true);
        f.uncertainStop(false); await f.service.tick(); await f.service.tick();
        assert.equal(f.store.get(id)!.state, 'stopped'); assert.equal(f.store.get(id)!.rounds, undefined);
        f.service.enqueue(id, next, 'A new request while control is pending', []); await f.service.tick();
        assert.equal(f.store.get(id)!.queuePaused, true, 'Replay cannot undo the later confirmed stop');
        f.service.enqueue(id, randomUUID(), 'Continue after stop confirmation', []); await f.service.tick();
        assert.equal(f.store.get(id)!.roundRequestID, next);
      }
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('saved sends after a confirmed stop recover on restart once while preserving FIFO and history', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Stopped plan', steps: [step('work')] });
    f.service.control(id, 'stop'); await f.service.advance(id);
    const before = f.store.get(id)!, first = randomUUID(), later = randomUUID(), cancelled = randomUUID();
    const stoppedAt = Date.parse(before.events.at(-1)!.at);
    // Simulate durable output from the older enqueue implementation, without using the new resume path.
    before.messages = [
      { requestID: cancelled, text: 'Cancelled send', inputFiles: [], createdAt: new Date(stoppedAt + 1).toISOString(), state: 'cancelled' },
      { requestID: first, text: 'Earlier valid queued request', inputFiles: [], createdAt: new Date(stoppedAt - 1).toISOString(), state: 'queued' },
      { requestID: later, text: 'CPU information after stop', inputFiles: [], createdAt: new Date(stoppedAt + 1).toISOString(), state: 'queued' },
    ];
    before.updatedAt = new Date(stoppedAt + 2).toISOString();
    f.db.prepare('UPDATE workflows SET body=? WHERE id=?').run(JSON.stringify(before), id);
    f.restart(); await Promise.all([f.service.tick(), f.service.tick()]);
    const current = f.store.get(id)!;
    assert.equal(current.queuePaused, false); assert.equal(current.queuePauseReason, undefined);
    assert.equal(current.roundRequestID, first, 'A later send authorizes continuation without discarding older valid messages');
    assert.equal(current.rounds!.length, 1); assert.equal(current.rounds![0].state, 'stopped');
    assert.deepEqual(current.rounds![0].planner, before.planner); assert.deepEqual(current.rounds![0].steps, before.steps);
    assert.equal(current.messages![0].state, 'cancelled'); assert.equal(current.messages![2].requestID, later);
    f.restart(); await f.service.tick(); await f.service.tick(); assert.equal(f.starts.length, 3);
    assert.equal(f.starts[2].context.role, 'planner'); assert.equal(f.starts.filter(a => a.executionID === f.starts[1].executionID).length, 1);
    f.service.messageControl(id, 'pause'); f.service.enqueue(id, later, 'CPU information after stop', []);
    assert.equal(f.store.get(id)!.queuePauseReason, 'manual', 'Replaying the recovered send does not clear later control');
  } finally { await f.service.close(); f.db.close(); }
});

test('stop compatibility recovery skips ambiguous controls, timestamps and unsettled attempts', async () => {
  const cases = ['before', 'equal', 'invalid_send', 'invalid_stop', 'invalid_updated', 'clock_rollback', 'cancelled',
    'manual', 'context_error', 'legacy', 'queue_error', 'missing_event', 'later_state', 'step_event', 'stopping', 'failed', 'unknown', 'unhandled'] as const;
  for (const boundary of cases) {
    const f = setup();
    try {
      const id = await f.planned({ summary: 'Old stopped plan', steps: [step('work')] });
      f.service.control(id, 'stop'); await f.service.advance(id);
      const value = f.store.get(id)!, stopped = value.events.at(-1)!;
      const at = Date.parse(stopped.at), requestID = randomUUID();
      value.messages = [{ requestID, text: 'Saved follow up', inputFiles: [], createdAt: new Date(at + 1).toISOString(), state: 'queued' }];
      value.updatedAt = new Date(at + 2).toISOString();
      if (boundary === 'before') value.messages[0].createdAt = new Date(at - 1).toISOString();
      if (boundary === 'equal') value.messages[0].createdAt = stopped.at;
      if (boundary === 'invalid_send') value.messages[0].createdAt = 'invalid';
      if (boundary === 'invalid_stop') stopped.at = 'invalid';
      if (boundary === 'invalid_updated') value.updatedAt = 'invalid';
      if (boundary === 'clock_rollback') value.updatedAt = stopped.at;
      if (boundary === 'cancelled') value.messages[0].state = 'cancelled';
      if (boundary === 'manual' || boundary === 'context_error') value.queuePauseReason = boundary;
      if (boundary === 'legacy') delete value.queuePauseReason;
      if (boundary === 'queue_error') value.queueError = 'workflow_context_failed';
      if (boundary === 'missing_event') value.events = [];
      if (boundary === 'later_state') value.events.push({ ...stopped, id: stopped.id + 1, text: 'paused' });
      if (boundary === 'step_event') stopped.stepID = 'work';
      if (boundary === 'stopping') { value.state = 'stopping'; value.steps[0].attempts[0].phase = 'unknown'; f.uncertainStop(true); }
      if (boundary === 'failed') value.state = 'failed';
      if (boundary === 'unknown') value.steps[0].attempts[0].phase = 'unknown';
      if (boundary === 'unhandled') value.steps[0].attempts[0].handled = false;
      f.db.prepare('UPDATE workflows SET body=? WHERE id=?').run(JSON.stringify(value), id);
      f.restart(); await f.service.tick(); await f.service.tick();
      const current = f.store.get(id)!;
      assert.equal(current.queuePaused, true, boundary); assert.equal(current.rounds, undefined, boundary);
      assert.equal(f.starts.length, 2, boundary);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('stop compatibility recovery rechecks a newer manual pause inside the durable mutation', async () => {
  const f = setup();
  try {
    const id = f.create().id;
    f.service.control(id, 'stop'); await f.service.advance(id);
    const value = f.store.get(id)!, at = Date.parse(value.events.at(-1)!.at);
    value.messages = [{ requestID: randomUUID(), text: 'Saved after stop', inputFiles: [], createdAt: new Date(at + 1).toISOString(), state: 'queued' }];
    value.updatedAt = new Date(at + 2).toISOString();
    f.db.prepare('UPDATE workflows SET body=? WHERE id=?').run(JSON.stringify(value), id);
    const update = f.store.update.bind(f.store); let interrupted = false;
    f.store.update = (id, mutate, version) => {
      if (!interrupted) { interrupted = true; update(id, current => { current.queuePaused = true; current.queuePauseReason = 'manual'; }); }
      return update(id, mutate, version);
    };
    await f.service.tick();
    assert.equal(interrupted, true); assert.equal(f.store.get(id)!.queuePauseReason, 'manual');
    assert.equal(f.store.get(id)!.rounds, undefined); assert.equal(f.starts.length, 0);
  } finally { await f.service.close(); f.db.close(); }
});

test('a planner failure after explicit dispatch pause keeps future messages paused', async () => {
  const f = setup();
  try {
    const value = f.create(); await f.service.advance(value.id);
    f.service.control(value.id, 'pause'); f.service.enqueue(value.id, randomUUID(), 'Future request', []);
    f.executions.set(f.starts[0].executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: true, error: 'execution_failed' });
    await f.service.advance(value.id); f.restart(); await f.service.tick();
    assert.equal(f.store.get(value.id)!.state, 'failed'); assert.equal(f.store.get(value.id)!.queuePauseReason, 'manual');
    assert.equal(f.store.get(value.id)!.rounds, undefined); assert.equal(f.starts.length, 1);
  } finally { await f.service.close(); f.db.close(); }
});

test('fresh terminal sends still require every recorded attempt to be terminal and handled', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    const next = randomUUID(); f.service.enqueue(id, next, 'Next request', []);
    for (const state of ['stopped', 'failed', 'completed'] as const) for (const phase of ['queued', 'running', 'waiting', 'unknown', 'failed'] as const) {
      f.store.update(id, value => {
        value.state = state; value.steps[0].state = 'failed'; value.queuePaused = true; value.queuePauseReason = 'manual';
        value.steps[0].attempts[0].phase = phase; value.steps[0].attempts[0].handled = phase !== 'failed';
      });
      f.service.enqueue(id, randomUUID(), 'Wait for old execution to be safely handled', []);
      assert.equal(f.store.get(id)!.queuePaused, true);
      await f.service.tick(); assert.equal(f.store.get(id)!.rounds, undefined, phase); assert.equal(f.starts.length, 2);
    }
    f.store.update(id, value => { value.steps[0].attempts[0].handled = true; });
    f.service.enqueue(id, randomUUID(), 'Now continue safely', []);
    await f.service.tick(); assert.equal(f.store.get(id)!.roundRequestID, next);
  } finally { await f.service.close(); f.db.close(); }
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

test('fresh terminal sends retry context preparation while request replay preserves a repeated error', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: false, error: 'execution_failed' });
    await f.service.advance(id);
    const first = randomUUID(); f.service.enqueue(id, first, 'First continuation', []);
    f.adapter.conversationContext = async () => { throw new Error('workflow_context_failed'); };
    await f.service.tick();
    assert.equal(f.store.get(id)!.queuePaused, true); assert.equal(f.store.get(id)!.queuePauseReason, 'context_error');
    assert.equal(f.store.get(id)!.queueError, 'workflow_context_failed');
    const next = randomUUID(); f.service.enqueue(id, next, 'Later continuation', []);
    assert.equal(f.store.get(id)!.queueError, undefined); assert.equal(f.store.get(id)!.queuePaused, false);
    f.restart(); await f.service.tick();
    assert.equal(f.store.get(id)!.rounds, undefined); assert.equal(f.store.get(id)!.queuePauseReason, 'context_error');
    f.service.enqueue(id, first, 'First continuation', []);
    assert.equal(f.store.get(id)!.queueError, 'workflow_context_failed');
    delete f.adapter.conversationContext;
    f.service.enqueue(id, randomUUID(), 'Retry after the context problem is resolved', []); await f.service.tick();
    assert.equal(f.store.get(id)!.roundRequestID, first); assert.equal(f.store.get(id)!.queueError, undefined);
    assert.equal(f.store.get(id)!.queuePauseReason, undefined); assert.equal(f.starts.length, 2);
  } finally { await f.service.close(); f.db.close(); }
});

test('obsolete context preparation errors cannot pause an edited, cancelled or explicitly paused queue', async () => {
  for (const change of ['edit', 'cancel', 'pause', 'round'] as const) {
    const f = setup();
    try {
      const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
      f.finish(f.starts[1], complete()); await f.service.advance(id);
      const first = randomUUID(), next = randomUUID();
      f.service.enqueue(id, first, 'Before preparation', []); f.service.enqueue(id, next, 'Later request', []);
      let reject!: (error: Error) => void;
      f.adapter.conversationContext = () => new Promise((_resolve, fail) => { reject = fail; });
      const preparing = f.service.advance(id);
      if (change === 'edit') f.service.editMessage(id, { requestID: first, expectedText: 'Before preparation', text: 'Updated request' });
      if (change === 'cancel') f.service.messageControl(id, 'cancel', first);
      if (change === 'pause') f.service.messageControl(id, 'pause');
      if (change === 'round') f.store.update(id, value => { value.roundRequestID = randomUUID(); });
      reject(new Error('obsolete_context_failure')); await preparing;
      const value = f.store.get(id)!;
      assert.equal(value.queueError, undefined, change); assert.equal(value.rounds, undefined, change);
      assert.equal(!!value.queuePaused, change === 'pause', change);
      assert.equal(value.queuePauseReason, change === 'pause' ? 'manual' : undefined, change);
      assert.equal(f.starts.length, 2);
    } finally { await f.service.close(); f.db.close(); }
  }
});

test('round admission rechecks handled terminal attempts after asynchronous context preparation', async () => {
  const f = setup();
  try {
    const id = await f.planned({ summary: 'Plan', steps: [step('work')] });
    f.executions.set(f.starts[1].executionID, { phase: 'failed', summary: '', outcome: null, outputFiles: [], safeToTransfer: false, error: 'execution_failed' });
    await f.service.advance(id);
    const next = randomUUID(); f.service.enqueue(id, next, 'Next request', []);
    const context = { id: randomUUID(), name: 'history.json', bytes: 2, sha256: 'a'.repeat(64), mime: 'application/octet-stream' };
    let release!: () => void;
    f.adapter.conversationContext = () => new Promise(resolve => { release = () => resolve(context); });
    const preparing = f.service.advance(id);
    f.store.update(id, value => { value.steps[0].attempts[0].handled = false; });
    release(); await preparing;
    assert.equal(f.store.get(id)!.rounds, undefined); assert.equal(f.starts.length, 2);
    f.store.update(id, value => { value.steps[0].attempts[0].handled = true; });
    f.adapter.conversationContext = async () => context;
    await f.service.tick(); assert.equal(f.store.get(id)!.roundRequestID, next);
    assert.equal(f.store.get(id)!.rounds![0].steps[0].attempts.length, 1);
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
    assert.equal(f.store.get(id)!.queuePaused, true); assert.equal(f.store.get(id)!.queuePauseReason, 'context_error');
    assert.equal(f.store.get(id)!.queueError, 'workflow_input_quota');
    assert.notEqual(f.store.get(id)!.roundRequestID, next); assert.equal(f.store.get(id)!.inputFiles.length, 10);
    f.restart(); await f.service.tick(); assert.equal(f.store.get(id)!.queuePaused, true);
  } finally { await f.service.close(); f.db.close(); }
});

const readyPlan = (f: ReturnType<typeof setup>, steps: WorkflowStepPlan[], target: WorkflowRequest['target'] = { mode: 'automatic' }) => {
  const value = f.create({ requestID: randomUUID(), target });
  f.store.update(value.id, (w) => { w.state = 'running'; w.planVersion = 1; w.summary = 'Automatic placement'; w.steps = steps.map(s => workflowStep(s)); });
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
    assert(f.starts[1].context.priorContext.startsWith('此旧会话未记录发起 Node'));
    assert(f.starts[1].context.priorContext.includes(`本次实际执行 Node：${f.starts[1].nodeID}`));
    f.finish(f.starts[1], { kind: 'handoff', nodeID: B, reason: 'Required tool', checkpoint: 'Saved progress', files: [], processesStopped: true });
    await f.service.advance(id);
    assert.equal(f.starts[2].nodeID, B); assert(f.starts[2].context.priorContext.includes(description));
    assert(f.starts[2].context.priorContext.startsWith('此旧会话未记录发起 Node'));
    assert(f.starts[2].context.priorContext.includes(`本次实际执行 Node：${B}`));
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
