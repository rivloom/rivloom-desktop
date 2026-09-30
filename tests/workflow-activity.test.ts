import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import { visibleWorkflowActivity, workflowActivityItems, workflowActivityPresentation, workflowActivityStepLabel, workflowAttemptDuration, workflowDurationLabel } from '../src/workflow-activity.ts';
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
  assert.equal(planning[0].role, 'planner');
  const current = step('work', 'running', [attempt(), attempt('queued', 2)]);
  const items = workflowActivityItems(value([current, step('unassigned', 'ready', [])]));
  assert.equal(items[0].attempt?.number, 2); assert.equal(items[0].nodeID, 'actual-2'); assert.equal(items[0].durationMilliseconds, null);
  assert.equal(items[0].role, 'executor');
  assert.equal(items[1].nodeID, null); assert.equal(items[1].durationMilliseconds, null);
  assert.equal(visibleWorkflowActivity(workflowActivityItems(value([step('single')]))).length, 1);
});

test('stopped remote planning is attributed to planning before any business steps exist', () => {
  const source = value([], 0);
  source.planner = step('planner', 'cancelled', [{ ...attempt('stopped'), kind: 'remote', nodeID: 'planning-device',
    updatedAt: new Date(Date.parse(start) + 3489).toISOString() }]);
  source.planner.title = 'Read the timezone of this device';
  const item = workflowActivityItems(source)[0];
  const presentation = workflowActivityPresentation(item, 'winserver2');
  assert.equal(item.role, 'planner'); assert.equal(item.nodeID, 'planning-device');
  assert.equal(item.durationMilliseconds, 3489);
  assert.equal(presentation.attribution, '规划 Node：winserver2');
  assert.equal(presentation.label, '规划已停止');
  assert.equal(presentation.elapsed, '本次规划用时 3.4秒');
  assert.equal(presentation.detailsTitle, '查看规划状态与记录');
  assert.equal(presentation.completed, false);
  assert(!Object.values(presentation).join(' ').includes('执行'));
});

test('planning progress, transport waits, failure and completion never claim business execution', () => {
  const source = value([], 0);
  let presentation = workflowActivityPresentation(workflowActivityItems(source)[0], 'Planner');
  assert.equal(presentation.label, '正在分析与规划'); assert.equal(presentation.elapsed, '规划详情');
  for (const [phase, label] of [['queued', '已入队'], ['waiting', '等待处理'], ['unknown', '状态待确认']] as const) {
    source.planner.attempts[0].phase = phase;
    presentation = workflowActivityPresentation(workflowActivityItems(source)[0], 'Planner');
    assert.equal(presentation.label, label); assert.equal(presentation.elapsed, '规划详情');
  }
  source.planner = step('planner', 'failed', [attempt('failed')]);
  assert.equal(workflowActivityPresentation(workflowActivityItems(source)[0], 'Planner').label, '规划失败');
  source.planner = step('planner', 'completed');
  presentation = workflowActivityPresentation(workflowActivityItems(source)[0], 'Planner');
  assert.equal(presentation.attribution, '由 Planner 完成规划'); assert.equal(presentation.label, '规划已完成');
  assert.equal(presentation.completed, true);
  source.planner = step('planner', 'ready', []);
  presentation = workflowActivityPresentation(workflowActivityItems(source)[0], '');
  assert.equal(presentation.attribution, '待分配规划 Node'); assert.equal(presentation.label, '等待规划条件');
});

test('an accepted plan uses only its business attempts and retains execution labels', () => {
  const source = value([step('work', 'ready', [])]);
  source.planner = step('planner', 'completed', [{ ...attempt(), nodeID: 'planning-device' }]);
  let item = workflowActivityItems(source)[0];
  assert.equal(item.role, 'executor'); assert.equal(item.nodeID, null);
  assert.equal(workflowActivityPresentation(item, '').attribution, '待分配');
  source.steps[0] = step('work', 'running', [{ ...attempt('running'), nodeID: 'business-device' }]);
  item = workflowActivityItems(source)[0];
  let presentation = workflowActivityPresentation(item, 'Worker');
  assert.equal(item.nodeID, 'business-device'); assert.equal(presentation.attribution, '执行 Node：Worker');
  assert.equal(presentation.label, '执行中'); assert.equal(presentation.elapsed, '执行详情');
  source.steps[0].state = 'completed'; source.steps[0].attempts[0].phase = 'completed';
  presentation = workflowActivityPresentation(workflowActivityItems(source)[0], 'Worker');
  assert.equal(presentation.attribution, '由 Worker 完成'); assert.equal(presentation.completed, true);
  assert(presentation.elapsed.startsWith('本次用时 '));
});

test('selected earlier planning records keep their own phase after a later attempt stops', () => {
  const earlier = attempt('completed'), latest = attempt('stopped', 2);
  const planner = step('planner', 'cancelled', [earlier, latest]);
  assert.equal(workflowActivityStepLabel('planner', planner, earlier), '规划已完成');
  assert.equal(workflowActivityStepLabel('planner', planner, latest), '规划已停止');
  earlier.phase = 'failed';
  assert.equal(workflowActivityStepLabel('planner', planner, earlier), '规划失败');
  earlier.phase = 'completed';
  earlier.outcome = { kind: 'handoff', nodeID: null, reason: 'Continue planning elsewhere', checkpoint: '', files: [], processesStopped: true };
  assert.equal(workflowActivityStepLabel('planner', planner, earlier), '规划转交');
  assert.equal(workflowActivityStepLabel('executor', planner, earlier), '已转交');
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
  for (const entry of entries) {
    entry.remote!.executionState = 'running';
    entry.remote!.executionSummary = 'OpenCode 正在执行任务。';
  }
  assert.deepEqual(recentWorkflowExecutions(entries, 'running'), []);
  entries[0].remote!.executionSummary = '已查到本机时区 UTC+8';
  assert.deepEqual(recentWorkflowExecutions(entries, 'running').map(entry => entry.text), ['已查到本机时区 UTC+8']);
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
