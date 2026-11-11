import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../shared/conversations.ts';
import type { BrainTask, RemoteTaskInvite, Task } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import type { ActivityTransfer } from '../src/conversation-activity.ts';
import { activityTransfers } from '../src/conversation-activity.ts';
import { conversationIdentityIndex, conversationJourney, journeyConnections, journeyTransferGroups } from '../src/conversation-journey.ts';

const file = (overrides: Partial<ActivityTransfer> = {}): ActivityTransfer => ({
  key: 'remote:run:inputs:file:send:worker', route: { scope: 'remote', taskID: 'run' },
  fileID: 'file', name: 'source.txt', peerNodeID: 'worker', direction: 'send', state: 'sending',
  bytes: 40, total: 100, fresh: true, ...overrides,
});
const attempt = (overrides: Partial<WorkflowAttempt> = {}): WorkflowAttempt => ({
  number: 1, executionID: 'run', nodeID: 'worker', kind: 'remote', phase: 'running', createdAt: '', updatedAt: '',
  summary: '', outcome: null, inputFiles: [], outputFiles: [], error: null, handled: false,
  context: { workflowID: 'workflow', stepID: 'work', attempt: 1, role: 'executor',
    target: { mode: 'automatic' }, instructions: '', evidence: '', priorContext: '' }, ...overrides,
});
const step = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id: 'work', title: 'Work', instructions: '', dependsOn: [], nodeID: 'preferred-but-not-used',
  resources: [], software: [], requirements: {}, state: 'running', attempts: [attempt()],
  checkpoint: '', queryRounds: 0, materials: [], evidence: '', continuation: null, ...overrides,
});
const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow', requestID: 'round-one', roundRequestID: 'round-one', contentDigest: '', creatorID: '', title: 'One task',
  originNodeID: 'local', description: '', criteria: '', projectID: null, model: null, approvalMode: 'ask',
  target: { mode: 'automatic' }, state: 'running', version: 1, planVersion: 1, summary: '',
  planner: step({ id: 'planner', title: 'Plan', state: 'completed',
    attempts: [attempt({ kind: 'local', executionID: 'plan', nodeID: 'local', phase: 'completed' })] }),
  steps: [step()], events: [], handoffs: [], inputFiles: [], confirmations: [], pendingConfirmation: null,
  createdAt: '', updatedAt: '', error: null, ...overrides,
});
const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  key: 'remote:run', title: 'One task', description: '', updatedAt: '', createdAt: '',
  sourceNodeID: 'local', incoming: false, attempts: [], ...overrides,
});
const remote = (overrides: Partial<RemoteTaskInvite> = {}): RemoteTaskInvite => ({
  id: 'run', direction: 'outgoing', ownerNodeID: 'local', targetNodeID: 'worker',
  status: 'accepted', executionState: 'running', remoteApprovals: [], remoteQuestions: [],
  controlPending: false, deliveryPending: false, deliveryError: null, ...overrides,
} as RemoteTaskInvite);
const localTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'local-task', title: 'Local work', state: 'running', sessionID: 'session', runAfter: 1,
  approvals: [], questions: [], ...overrides,
} as Task);
const journey = (value: Workflow, transfers: ActivityTransfer[] = [], options: { fresh?: boolean; historical?: boolean } = {}) =>
  conversationJourney({ conversationKey: 'workflow:workflow', localNodeID: 'local', workflow: value, transfers, ...options });

test('groups parallel files by original route and direction, while one visual edge retains both owners', () => {
  const files = Array.from({ length: 10 }, (_, i) => file({ key: 'file-' + i, fileID: 'file-' + i,
    route: { scope: 'remote', taskID: i < 5 ? 'run-a' : 'run-b' } }));
  const groups = journeyTransferGroups([...files, files[0]], 'local');
  assert.equal(groups.length, 2); assert.deepEqual(groups.map(group => group.fileCount), [5, 5]);
  const [connection] = journeyConnections(groups);
  assert.equal(connection.fileCount, 10); assert.equal(connection.groupKeys.length, 2);
  assert.equal(connection.transferKeys.length, 10); assert.equal(connection.counts.active, 10);
  assert.equal(connection.fromNodeID, 'local'); assert.equal(connection.toNodeID, 'worker');
});

test('parallel peers and receive direction remain independent instead of becoming a serial route', () => {
  const groups = journeyTransferGroups([file(), file({ key: 'second', peerNodeID: 'second-worker' }),
    file({ key: 'result', direction: 'receive', state: 'receiving' })], 'local');
  const edges = journeyConnections(groups);
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map(edge => [edge.fromNodeID, edge.toNodeID]), [
    ['local', 'worker'], ['local', 'second-worker'], ['worker', 'local'],
  ]);
  const value = journey(workflow(), [file(), file({ key: 'second', peerNodeID: 'second-worker' })]);
  assert(value.stages.filter(stage => stage.kind === 'transfer').every(stage => stage.dependsOn.length === 0));
});

test('aggregate state and counts retain simultaneous waiting, error and stale evidence', () => {
  const groups = journeyTransferGroups([file(), file({ key: 'wait', state: 'waiting' }),
    file({ key: 'done', state: 'complete', bytes: 100 }), file({ key: 'fail', state: 'failed' }),
    file({ key: 'stale', fresh: false })], 'local');
  assert.equal(groups[0].state, 'failed'); assert.equal(groups[0].fresh, false);
  assert.deepEqual(groups[0].counts, { active: 1, waiting: 1, complete: 1, failed: 1, unknown: 1, stopped: 0 });
  assert.equal(journeyConnections(groups)[0].counts.waiting, 1);
});

test('unknown endpoints are retained as unknown groups without inventing a wire or a self transfer', () => {
  const groups = journeyTransferGroups([file({ peerNodeID: null }), file({ key: 'self', peerNodeID: 'local' })], 'local');
  assert.equal(groups.length, 2); assert.equal(groups[0].toNodeID, null);
  assert.deepEqual(journeyConnections(groups), []);
  assert.deepEqual(journeyConnections(journeyTransferGroups([file()], null)), []);
  const value = conversationJourney({ conversationKey: 'local:task', localNodeID: 'local', transfers: [],
    conversation: conversation({ localTask: localTask() }) });
  assert.deepEqual(value.devices, [{ id: 'local', local: true, executing: true }]);
  assert.deepEqual(value.connections, []);
});

test('execution devices come from actual attempts and actual incoming owners, not placement hints', () => {
  const value = journey(workflow());
  assert(value.devices.some(device => device.id === 'worker' && device.executing));
  assert(!value.devices.some(device => device.id === 'preferred-but-not-used'));
  const received = conversationJourney({ conversationKey: 'remote:run', localNodeID: 'receiver', transfers: [],
    conversation: conversation({ incoming: true, sourceNodeID: 'sender',
      remote: remote({ direction: 'incoming', ownerNodeID: 'sender', targetNodeID: 'receiver' }), localTask: localTask() }) });
  assert.equal(received.stages[0].fromNodeID, 'sender');
  assert.equal(received.stages[0].nodeID, 'receiver');
  const unknown = journey(workflow({ originNodeID: undefined }));
  assert(unknown.stages.every(stage => stage.fromNodeID === null));
});

test('a local workflow has one device and no implied round trip', () => {
  const value = journey(workflow({ steps: [step({ attempts: [attempt({ kind: 'local', nodeID: 'local' })] })] }));
  assert.equal(value.devices.length, 1); assert.equal(value.devices[0].id, 'local');
  assert.equal(value.connections.length, 0);
});

test('parallel execution dependencies are explicit and independent of array order', () => {
  const a = step({ id: 'a', attempts: [attempt({ executionID: 'a', nodeID: 'worker-a' })] });
  const b = step({ id: 'b', attempts: [attempt({ executionID: 'b', nodeID: 'worker-b' })] });
  const join = step({ id: 'join', dependsOn: ['a', 'b'], state: 'waiting', attempts: [] });
  const value = journey(workflow({ steps: [b, a, join] }));
  const execution = value.stages.filter(stage => stage.kind === 'execution');
  assert.deepEqual(execution.find(stage => stage.stepID === 'a')!.dependsOn, []);
  assert.deepEqual(execution.find(stage => stage.stepID === 'b')!.dependsOn, []);
  assert.equal(execution.find(stage => stage.stepID === 'join')!.dependsOn.length, 2);
  assert.equal(value.devices.filter(device => device.executing).length, 2);
  assert.equal(value.canSettle, false);
});

test('completion needs every branch and exact full-file evidence; partial, stale and waiting branches stay visible', () => {
  const done = workflow({ state: 'completed', steps: [step({ state: 'completed',
    attempts: [attempt({ phase: 'completed' })] })] });
  assert.equal(journey(done, [file({ state: 'complete', bytes: 100 })]).canSettle, true);
  for (const unfinished of [file(), file({ state: 'waiting' }), file({ state: 'failed' }),
    file({ state: 'complete', bytes: 99 }), file({ state: 'complete', bytes: 100, fresh: false })]) {
    assert.equal(journey(done, [unfinished]).canSettle, false);
  }
  assert.equal(journey({ ...done, steps: [...done.steps, step({ id: 'parallel' })] }).canSettle, false);
  assert.equal(journey(done, [], { fresh: false }).canSettle, false);
});

test('stopped, cancelled or expired work is never presented as natural completion', () => {
  for (const state of ['stopped', 'stopping', 'failed'] as const) assert.equal(journey(workflow({ state })).completed, false);
  for (const status of ['cancelled', 'expired', 'declined'] as const) {
    const value = conversationJourney({ conversationKey: 'remote:run', localNodeID: 'local', transfers: [],
      conversation: conversation({ remote: remote({ status, executionState: 'not_started' }) }) });
    assert.equal(value.completed, false); assert.equal(value.canSettle, false);
  }
});

test('retry identity changes without repainting the conversation, and old attempts or rounds are not replayed', () => {
  const old = attempt({ executionID: 'old', phase: 'failed' }), next = attempt({ executionID: 'next', number: 2 });
  const value = workflow({ steps: [step({ attempts: [old, next] })] });
  const before = journey(workflow({ steps: [step({ attempts: [old] })] }));
  const after = journey(value, [file({ route: { scope: 'remote', taskID: 'old' } }),
    file({ key: 'next-file', route: { scope: 'remote', taskID: 'next' } }),
    file({ key: 'past-round', route: { scope: 'remote', taskID: 'historic' } })]);
  assert.notEqual(before.key, after.key); assert.equal(before.identityIndex, after.identityIndex);
  assert.deepEqual(after.groups.map(group => group.route.taskID), ['next']);
  assert.notEqual(after.key, journey({ ...value, roundRequestID: 'next-round' }).key);
});

test('historical receipts stay static even if their saved state was running', () => {
  const value = journey(workflow(), [file()], { historical: true });
  assert.equal(value.historical, true); assert.equal(value.fresh, false); assert.equal(value.canSettle, false);
  assert(value.groups.every(group => !group.fresh)); assert(value.stages.every(stage => stage.historical));
  assert(value.devices.every(device => !device.executing));
});

test('remote result metadata creates neither an incoming group nor evidence of a returned file', () => {
  const transfers = activityTransfers([{ route: { scope: 'remote', taskID: 'run' }, fresh: true,
    loading: false, error: null, revision: 1, value: { inputs: [], canPublish: false, canRetry: false, canSave: true,
      results: [{ id: 'result', name: 'remote.txt', bytes: 100, sha256: 'hash', mime: 'text/plain',
        state: 'remote', sourceNodeID: 'worker', receivedBytes: 0, deliveries: [], updatedAt: '', error: null }] } }]);
  const value = journey(workflow(), transfers);
  assert.equal(value.groups.length, 0); assert.equal(value.connections.length, 0);
  assert.equal(value.handoffCount, undefined);
});

test('handoff counts require real completed records bound to both attempts, never file batches', () => {
  const from = attempt({ number: 1, executionID: 'old', phase: 'completed', nodeID: 'first' });
  const to = attempt({ number: 2, executionID: 'next', phase: 'completed', nodeID: 'second' });
  const value = workflow({ state: 'completed', steps: [step({ state: 'completed', attempts: [from, to] })],
    handoffs: [{ id: 'handoff', stepID: 'work', fromAttempt: 1, toAttempt: 2, fromNodeID: 'first',
      toNodeID: 'second', reason: '', phase: 'completed', at: '' }] });
  assert.equal(journey(value).handoffCount, 1);
  assert.equal(journey({ ...value, handoffs: [{ ...value.handoffs[0], phase: 'transferring' }] }).handoffCount, undefined);
  assert.equal(journey({ ...value, handoffs: [{ ...value.handoffs[0], toNodeID: 'unverified' }] }).handoffCount, undefined);
  assert.equal(journey({ ...value, handoffs: [] }, [file({ route: { scope: 'remote', taskID: 'next' }, state: 'complete', bytes: 100 })]).handoffCount, undefined);
});

test('Brain execution uses its recorded execution identity and does not guess from selectedWorkerID', () => {
  const brain = { id: 'brain', submitterNodeID: 'submitter', masterNodeID: 'coordinator',
    selectedWorkerID: 'planned-worker', executionID: 'actual', executionAttempt: 2, status: 'running',
    executions: [{ executionID: 'actual', attempt: 2, workerNodeID: 'actual-worker', status: 'running' }],
    deliveryPending: false, deliveryError: null } as BrainTask;
  const value = conversationJourney({ conversationKey: 'brain:brain', localNodeID: 'coordinator', transfers: [],
    conversation: conversation({ brainTask: brain }) });
  assert.equal(value.stages[0].nodeID, 'actual-worker');
  assert.equal(value.stages[0].fromNodeID, 'submitter');
  assert(!value.devices.some(device => device.id === 'planned-worker'));
  const unknown = conversationJourney({ conversationKey: 'brain:brain', localNodeID: 'coordinator', transfers: [],
    conversation: conversation({ brainTask: { ...brain, executions: [] } }) });
  assert.equal(unknown.stages[0].nodeID, null); assert.equal(unknown.stages[0].state, 'unknown');
});

test('an unfinished Brain branch blocks settling after another execution completed', () => {
  const brain = { id: 'brain', submitterNodeID: 'submitter', executionID: 'done', status: 'completed',
    executions: [{ executionID: 'done', attempt: 2, workerNodeID: 'worker', status: 'completed' },
      { executionID: 'still-running', attempt: 1, workerNodeID: 'other', status: 'running' }] } as BrainTask;
  const value = conversationJourney({ conversationKey: 'brain:brain', localNodeID: 'submitter', transfers: [],
    conversation: conversation({ brainTask: brain }) });
  assert.equal(value.completed, true); assert.equal(value.canSettle, false);
});

test('identity colors remain deterministic while collection and display titles change', () => {
  assert.equal(conversationIdentityIndex('workflow:固定身份'), conversationIdentityIndex('workflow:固定身份'));
  assert.equal(journey(workflow()).identityIndex, journey(workflow({ title: 'Renamed', steps: [] })).identityIndex);
  assert(conversationIdentityIndex('workflow:固定身份') >= 0 && conversationIdentityIndex('workflow:固定身份') < 6);
});

test('only explicitly requested owned historical retrieval joins current transfers, not its old execution', () => {
  const oldStep = step({ id: 'old-step', attempts: [attempt({ executionID: 'past-round', phase: 'completed' })] });
  const value = workflow({ steps: [step({ attempts: [attempt({ executionID: 'retry-old', phase: 'failed' }), attempt()] })],
    rounds: [{ requestID: 'past', planner: step({ attempts: [] }), steps: [oldStep] }] as Workflow['rounds'] });
  const transfers = ['run', 'past-round', 'retry-old', 'foreign'].map(taskID => file({
    key: taskID, direction: 'receive', state: 'receiving', route: { scope: 'remote', taskID },
  }));
  const requested = conversationJourney({ conversationKey: 'workflow:workflow', localNodeID: 'local', workflow: value,
    transfers, requestedRoutes: ['past-round', 'retry-old', 'foreign'].map(taskID => ({ scope: 'remote', taskID })) });
  assert.deepEqual(requested.groups.map(group => group.route.taskID), ['run', 'past-round', 'retry-old']);
  assert.equal(requested.stages.filter(stage => stage.kind === 'execution').length, 2);
  assert.equal(requested.groups.find(group => group.route.taskID === 'past-round')!.fresh, true);
  assert.deepEqual(journey(value, transfers).groups.map(group => group.route.taskID), ['run']);
});

test('a verified later successful attempt retires an old blocked handoff without rewriting its history', () => {
  const from = attempt({ number: 1, executionID: 'first', phase: 'completed', nodeID: 'a' });
  const blocked = attempt({ number: 2, executionID: 'blocked', phase: 'failed', nodeID: 'b' });
  const latest = attempt({ number: 3, executionID: 'latest', phase: 'completed', nodeID: 'c' });
  const value = workflow({ state: 'completed', steps: [step({ state: 'completed', attempts: [from, blocked, latest] })],
    handoffs: [{ id: 'old-handoff', stepID: 'work', fromAttempt: 1, toAttempt: 2,
      fromNodeID: 'a', toNodeID: 'b', reason: '', phase: 'blocked', at: '' }] });
  const settled = journey(value);
  assert.equal(settled.canSettle, true);
  const old = settled.stages.find(stage => stage.kind === 'handoff')!;
  assert.equal(old.state, 'failed'); assert.equal(old.historical, true);
  const unproven = journey({ ...value, handoffs: [{ ...value.handoffs[0], toNodeID: 'unverified' }] });
  assert.equal(unproven.canSettle, false);
  assert.equal(unproven.stages.find(stage => stage.kind === 'handoff')!.state, 'unknown');
});

test('following-round queue remains unchanged while a healthy completed current round settles', () => {
  const messages: Workflow['messages'] = [{ requestID: 'next-round', state: 'queued', text: 'Follow up',
    createdAt: '', inputFiles: [] }];
  const done = workflow({ state: 'completed', messages, queuePaused: true, queueError: 'Next round needs attention',
    steps: [step({ state: 'completed', attempts: [attempt({ phase: 'completed' })] })] });
  const before = JSON.stringify(done);
  assert.equal(journey(done).canSettle, true);
  assert.equal(JSON.stringify(done), before);
  assert.equal(done.messages, messages);
  assert.equal(journey({ ...done, state: 'stopping' }).canSettle, false);
  assert.equal(journey({ ...done, pendingConfirmation: { nodeID: 'worker', stepID: 'work', waitingCount: 1 } }).canSettle, false);
  assert.equal(journey({ ...done, error: 'Current round failed' }).canSettle, false);
});
