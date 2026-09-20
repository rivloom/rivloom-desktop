import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import { visibleWorkflowActivity, workflowActivityItems, workflowAttemptDuration, workflowDurationLabel } from '../src/workflow-activity.ts';
import type { Bootstrap, RemoteTaskInvite, Task } from '../shared/types.ts';
import type { WorkflowDiagnosticSnapshot, WorkflowStepDiagnostic } from '../shared/workflow-diagnostics.ts';
import { healthyWorkflowDiagnostics, recentWorkflowExecutions, workflowAttentionExecutions, workflowExecutionAttention, workflowLatestExecutions } from '../src/workflow-recent.ts';

const start = '2026-09-19T01:00:00.000Z', end = '2026-09-19T01:01:30.000Z';
const attempt = (phase: WorkflowAttempt['phase'] = 'completed', number = 1): WorkflowAttempt => ({ number, phase, createdAt: start, updatedAt: end,
  executionID: `execution-${number}`, nodeID: `actual-${number}`, kind: 'local', summary: '', outcome: null, inputFiles: [], outputFiles: [], error: null, handled: true,
  context: { workflowID: 'test', stepID: 'a', attempt: number, role: 'executor', target: { mode: 'automatic' }, instructions: '', evidence: '', priorContext: '' } });
const step = (id: string, state: WorkflowStep['state'] = 'completed', attempts = [attempt()]): WorkflowStep => ({ id, state, attempts, title: id,
  instructions: '', nodeID: 'preferred-only', dependsOn: [], resources: [], software: [], requirements: {}, checkpoint: '', queryRounds: 0, materials: [], evidence: '', continuation: null });
const value = (steps: WorkflowStep[], planVersion = 1): Pick<Workflow, 'steps' | 'planner' | 'planVersion'> => ({ steps, planVersion, planner: step('planner', 'running', [attempt('running')]) });

test('activity uses the current plan and latest attempts without treating planned preference as an executing Node', () => {
  const planning = workflowActivityItems(value([step('not-yet-in-plan')], 0));
  assert.equal(planning.length, 1); assert.equal(planning[0].step.id, 'planner'); assert.equal(planning[0].durationMilliseconds, null);
  const current = step('work', 'running', [attempt(), attempt('queued', 2)]);
  const items = workflowActivityItems(value([current, step('unassigned', 'ready', [])]));
  assert.equal(items[0].attempt?.number, 2); assert.equal(items[0].nodeID, 'actual-2'); assert.equal(items[0].durationMilliseconds, null);
  assert.equal(items[1].nodeID, null); assert.equal(items[1].durationMilliseconds, null);
  assert.equal(visibleWorkflowActivity(workflowActivityItems(value([step('single')]))).length, 1);
});

test('compact activity retains attention and active work, with recent completed rows as fallback in plan order', () => {
  const items = workflowActivityItems(value([step('old'), step('running', 'running', [attempt('running')]), step('last'), step('blocked', 'blocked', []), step('failure', 'failed', [attempt('failed')])]));
  const original = items.map(item => item.step.id);
  assert.deepEqual(visibleWorkflowActivity(items).map(item => item.step.id), ['running', 'blocked', 'failure']);
  assert.deepEqual(items.map(item => item.step.id), original);
  const done = workflowActivityItems(value(['a', 'b', 'c', 'd', 'e'].map(id => step(id))));
  assert.deepEqual(visibleWorkflowActivity(done).map(item => item.step.id), ['c', 'd', 'e']);
  assert.deepEqual(visibleWorkflowActivity(done, 0), []); assert.deepEqual(visibleWorkflowActivity([], 3), []);
});

test('duration is a validated terminal recorded interval, never a live clock or previous attempt duration', () => {
  for (const phase of ['completed', 'failed', 'stopped'] as const) assert.equal(workflowAttemptDuration(attempt(phase)), 90_000);
  for (const phase of ['intent', 'queued', 'running', 'waiting', 'unknown'] as const) assert.equal(workflowAttemptDuration(attempt(phase)), null);
  assert.equal(workflowAttemptDuration(undefined), null);
  assert.equal(workflowAttemptDuration({ ...attempt(), createdAt: 'not-a-date' }), null);
  assert.equal(workflowAttemptDuration({ ...attempt(), updatedAt: 'not-a-date' }), null);
  assert.equal(workflowAttemptDuration({ ...attempt(), createdAt: end, updatedAt: start }), null);
  assert.equal(workflowAttemptDuration({ ...attempt(), updatedAt: start }), 0);
  assert.equal(workflowDurationLabel(90_000, 'en'), '1m 30s');
  assert.equal(workflowDurationLabel(3_660_000, 'en'), '1h 1m');
});

test('recent execution content comes only from the exact latest attempt and never from historical rounds or user messages', () => {
  const old = { ...attempt('running', 1), executionID: 'old' }, latest = { ...attempt('waiting', 2), executionID: 'latest' };
  const tool = (name: string) => ({ name, title: name, status: 'completed', output: name });
  const local = { id: 'latest', approvals: [{ id: 'approval' }], questions: [], messages: [
    { id: 'private', role: 'user', text: 'PRIVATE_ENGINE_CONTEXT', tools: [tool('private-tool')] },
    { id: 'a', role: 'assistant', text: 'earlier', tools: [tool('first'), tool('second')] },
    { id: 'b', role: 'assistant', text: 'current assistant output', tools: [tool('third')] },
  ] } as unknown as Task;
  const data = { tasks: [{ ...local, id: 'old', messages: [{ id: 'old-message', role: 'assistant', text: 'STALE_ATTEMPT', tools: [] }] }, local],
    network: { remoteTasks: [] } } as unknown as Pick<Bootstrap, 'tasks' | 'network'>;
  const source = value([step('running', 'running', [old, latest])]);
  assert.deepEqual(workflowLatestExecutions(source, data, true), []);
  const entries = workflowLatestExecutions(source, data); assert.equal(entries[0].local, local); assert(workflowExecutionAttention(entries[0]));
  assert.equal(workflowAttentionExecutions(entries, 'running').length, 1);
  const recent = recentWorkflowExecutions(entries, 'running');
  assert.equal(recent[0].text, 'current assistant output'); assert.deepEqual(recent[0].tools.map(item => item.tool.name), ['second', 'third']);
  for (const state of ['completed', 'failed', 'stopped'] as const) assert.deepEqual(recentWorkflowExecutions(entries, state), []);
  for (const state of ['completed', 'failed', 'stopped'] as const) assert.deepEqual(workflowAttentionExecutions(entries, state), []);
  for (const phase of ['completed', 'failed', 'stopped'] as const) assert(!workflowExecutionAttention({ ...entries[0], attempt: { ...latest, phase } }), 'Stale approval arrays on finished attempts cannot be actionable');
  source.steps[0].attempts.at(-1)!.executionID = 'not-synced'; assert.deepEqual(recentWorkflowExecutions(workflowLatestExecutions(source, data), 'running'), []);
});

test('remote recent output is only the matching remote summary and recent content is bounded to two active executions', () => {
  const steps = ['a', 'b', 'c'].map((id, index) => step(id, 'running', [{ ...attempt('running', index + 1), kind: 'remote', executionID: id }]));
  const data = { tasks: [{ id: 'a', messages: [{ role: 'assistant', text: 'WRONG_KIND', tools: [] }] }],
    network: { remoteTasks: steps.map(item => ({ id: item.id, executionSummary: `summary-${item.id}`, remoteApprovals: [], remoteQuestions: [] } as unknown as RemoteTaskInvite)) } } as unknown as Pick<Bootstrap, 'tasks' | 'network'>;
  const entries = workflowLatestExecutions(value(steps), data), recent = recentWorkflowExecutions(entries, 'running');
  assert.equal(recent.length, 2); assert.equal(recent[0].local, undefined); assert.match(recent[0].text, /^summary-/); assert.deepEqual(recent[0].tools, []);
});

test('healthy diagnosis may fold only after a complete response without adverse phase, queue, or device evidence', () => {
  const healthy = { stepID: 'a', phase: 'running', recovery: 'none', dependencies: [], nodes: [], queue: null } as unknown as WorkflowStepDiagnostic;
  const snapshot = (entry: WorkflowStepDiagnostic): WorkflowDiagnosticSnapshot => ({ workflowID: 'test', workflowVersion: 1, roundRequestID: 'round', sampledAt: end, steps: [entry] });
  assert(healthyWorkflowDiagnostics(snapshot(healthy), false)); assert(!healthyWorkflowDiagnostics(null, false)); assert(!healthyWorkflowDiagnostics(snapshot(healthy), true));
  for (const recovery of ['user_action', 'wait_original_execution', 'automatic_check'] as const)
    assert(!healthyWorkflowDiagnostics(snapshot({ ...healthy, recovery }), false));
  for (const phase of ['held', 'rejected', 'unknown', 'attention', 'confirmation', 'failed', 'placement', 'queued'] as const)
    assert(!healthyWorkflowDiagnostics(snapshot({ ...healthy, phase }), false));
  assert(!healthyWorkflowDiagnostics(snapshot({ ...healthy, nodes: [{ nodeID: 'worker', reasons: [{ code: 'report_stale', certainty: 'unknown', observedAt: null }] }] }), false));
  assert(!healthyWorkflowDiagnostics(snapshot({ ...healthy, queue: { state: 'held', position: 1, code: null, reason: 'review required', observedAt: end, local: true } }), false));
});
