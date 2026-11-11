import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTransfers, advancingTransfers, conversationActivitySummary, workflowActivityFileRoutes, workflowActivitySelection } from '../src/conversation-activity.ts';
import type { TaskFileState } from '../src/task-file-state.ts';
import type { Workflow, WorkflowAttempt } from '../shared/workflows.ts';

function state(overrides: Partial<TaskFileState> = {}): TaskFileState {
  return { route: { scope: 'local', taskID: 'task' }, fresh: true, loading: false, error: null, revision: 1,
    value: { canSave: true, canRetry: false, canPublish: false, results: [], inputs: [{ id: 'file', name: 'example.txt', bytes: 100,
      mime: 'text/plain', sha256: 'hash', state: 'complete', receivedBytes: 100, error: null, updatedAt: '',
      deliveries: [{ peerNodeID: 'worker', state: 'sending', bytes: 40, error: null }] }] }, ...overrides };
}
test('deduplicates repeated snapshots but preserves separate targets, directions and routes', () => {
  const a = state(); a.value!.inputs[0].deliveries.push({ peerNodeID: 'second-worker', state: 'waiting', bytes: 0, error: null });
  const b = state({ route: { scope: 'remote', taskID: 'another' } });
  const items = activityTransfers([a, a, b]);
  assert.equal(items.length, 3);
  assert.equal(items.filter(file => file.direction === 'receive').length, 0);
  const summary = conversationActivitySummary({ label: 'Running', tone: 'active', files: [a, a] });
  assert.equal(summary.transferring, 1); assert.equal(summary.waiting, 1); assert.equal(summary.detail.includes('%'), false);
});
test('remote result metadata does not imply reception, while retrieval after task completion stays visible', () => {
  const remote = state(); remote.value!.inputs = [];
  remote.value!.results = [{ id: 'output', name: 'result.md', bytes: 100, mime: 'text/plain', sha256: 'hash',
    state: 'remote', sourceNodeID: 'worker', receivedBytes: 0, error: null, updatedAt: '', deliveries: [] }];
  assert.equal(activityTransfers([remote]).length, 0);
  remote.value!.results[0].state = 'receiving';
  const summary = conversationActivitySummary({ label: 'Completed', tone: 'settled', files: [remote] });
  assert.equal(summary.tone, 'active'); assert.equal(summary.transferring, 1);
  assert.notEqual(summary.label, 'Completed');
});
test('stale data stops transfer feedback and never means successful completion', () => {
  const previous = activityTransfers([state()]);
  const stale = state({ fresh: false, error: 'offline' }); stale.value!.inputs[0].deliveries[0].bytes = 90;
  assert.deepEqual(advancingTransfers(previous, activityTransfers([stale])), []);
  const summary = conversationActivitySummary({ label: 'Completed', tone: 'settled', files: [stale] });
  assert.equal(summary.tone, 'unavailable'); assert.equal(summary.transferring, 0);
  assert.notEqual(summary.label, 'Completed');
});
test('only confirmed byte advances animate, never initial snapshots, duplicates, resets or old routes', () => {
  const a = activityTransfers([state()]);
  assert.deepEqual(advancingTransfers([], a), []);
  assert.deepEqual(advancingTransfers(a, a), []);
  const b = state(); b.value!.inputs[0].deliveries[0].bytes = 60;
  assert.equal(advancingTransfers(a, activityTransfers([b])).length, 1);
  b.route.taskID = 'new-attempt';
  assert.deepEqual(advancingTransfers(a, activityTransfers([b])), []);
  b.route.taskID = 'task'; b.value!.inputs[0].deliveries[0].state = 'waiting';
  assert.deepEqual(advancingTransfers(a, activityTransfers([b])), []);
});
test('a partial failure or attention is not hidden by simultaneous healthy work', () => {
  const a = state(); a.value!.inputs[0].deliveries.push({ peerNodeID: 'broken', state: 'failed', bytes: 80, error: 'integrity' });
  const summary = conversationActivitySummary({ label: 'Running', tone: 'active', files: [a], attentionCount: 1 });
  assert.equal(summary.tone, 'attention'); assert.equal(summary.failures, 1); assert.equal(summary.transferring, 1);
});
test('only explicit historical retrieval belongs in the current summary, and stays bound to its owner', () => {
  const attempt = (id: string): WorkflowAttempt => ({ executionID: id, kind: 'remote', inputFiles: [{ id: 'input' }], outputFiles: [] } as unknown as WorkflowAttempt);
  const old = { id: 'old', attempts: [attempt('past')] };
  const step = { id: 'step', attempts: [attempt('retry-old'), attempt('current')] };
  const value = { planVersion: 1, planner: { attempts: [] }, steps: [step], rounds: [{ planner: { attempts: [] }, steps: [old] }] } as unknown as Workflow;
  const routes = workflowActivityFileRoutes(value, [{ scope: 'remote', taskID: 'past' }, { scope: 'remote', taskID: 'unrelated' }]);
  assert.deepEqual(routes, [{ scope: 'remote', taskID: 'current' }, { scope: 'remote', taskID: 'past' }]);
});
test('dense input changes counts without producing progress percentages or duplicated items', () => {
  const snapshots = Array.from({ length: 10 }, (_, i) => state({ route: { scope: 'local', taskID: `task-${i}` } }));
  for (let i = 0; i < 1000; i++) {
    const summary = conversationActivitySummary({ label: 'Working', tone: 'active', files: snapshots });
    assert.equal(summary.transferring, 10); assert.equal(summary.transfers.length, 10); assert.equal(summary.detail.includes('%'), false);
  }
});

test('manual planning detail survives plan publication, later steps and retries without switching the reading target', () => {
  const planner = { id: 'planner', state: 'running', attempts: [{ number: 1, executionID: 'planning-one' }] };
  const value = { planVersion: 0, planner, steps: [] } as unknown as Workflow;
  const selection = { stepID: 'planner', attempt: 1 };
  assert.equal(workflowActivitySelection(value, selection).attempt?.executionID, 'planning-one');
  value.planVersion = 1;
  value.steps = [{ id: 'business', state: 'running', attempts: [{ number: 1, executionID: 'business-one' }] }] as Workflow['steps'];
  planner.state = 'completed';
  planner.attempts.push({ number: 2, executionID: 'planning-two' });
  const viewed = workflowActivitySelection(value, selection);
  assert.equal(viewed.step, planner); assert.equal(viewed.planning, true); assert.equal(viewed.attempt?.executionID, 'planning-one');
  assert.equal(workflowActivitySelection(value, null).attempt?.executionID, 'business-one');
  assert.equal(workflowActivitySelection(value, { stepID: 'removed', attempt: 1 }).step, undefined, 'do not silently select another step');
});
