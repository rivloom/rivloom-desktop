import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import type { RemoteTaskInvite, Task, TaskState } from '../shared/types.ts';
import { inspectPhysicalHistory } from '../scripts/m34-physical-resume.ts';

const workerRoot = resolve('.data/m34-physical/11111111-1111-4111-8111-111111111111/worker');
const nodeID = 'w'.repeat(32);
const ownerNodeID = 'm'.repeat(32);
const projectID = '22222222-2222-4222-8222-222222222222';
const portableID = '33333333-3333-4333-8333-333333333333';
const executionID = '44444444-4444-4444-8444-444444444444';
const taskID = '55555555-5555-4555-8555-555555555555';
const brainID = '66666666-6666-4666-8666-666666666666';

function history(portable = true) {
  const projects = [{ id: projectID, directory: join(workerRoot, 'authorized-folder') }];
  if (portable)
    projects.push({ id: portableID, directory: join(workerRoot, 'portable-tasks', executionID) });
  const tasks = [
    {
      id: taskID,
      projectID: portable ? portableID : projectID,
      state: 'accepted',
      model: 'fixture/m34',
      sessionID: 'ses_preserved',
      approvals: [],
      questions: [],
      remoteOrigin: { remoteTaskID: executionID, ownerNodeID, ownerBrainID: brainID },
    } as unknown as Task,
  ];
  const executions = [
    {
      id: executionID,
      brainTaskID: '77777777-7777-4777-8777-777777777777',
      direction: 'incoming',
      ownerNodeID,
      ownerBrainID: brainID,
      targetNodeID: nodeID,
      requestedProjectID: portable ? null : projectID,
      status: 'accepted',
      executionStatus: 'unprepared',
      executionLeaseID: null,
      localTaskID: taskID,
      executionState: 'accepted',
      executionSequence: 4,
      deliveryPending: false,
      deliveryError: null,
      controlPending: false,
    } as RemoteTaskInvite,
  ];
  return { projects, tasks, executions };
}
function check(value: ReturnType<typeof history>) {
  return inspectPhysicalHistory(
    workerRoot,
    nodeID,
    projectID,
    value.projects,
    value.tasks,
    value.executions,
  );
}

test('resume preserves completed Portable history and both Project identities', () => {
  const value = check(history());
  assert.deepEqual(value.projects.map((p) => p.id).sort(), [projectID, portableID].sort());
  assert.equal(value.tasks[0].id, taskID);
  assert.equal(value.tasks[0].sessionID, 'ses_preserved');
  assert.equal(value.tasks[0].state, 'accepted');
  assert.equal(value.executions[0].id, executionID);
});

test('resume permits an accepted task on the exact authorized Project', () => {
  const value = check(history(false));
  assert.equal(value.projects.length, 1);
  assert.equal(value.tasks[0].projectID, projectID);
});

test('resume still permits empty business history and the failed unbound acceptance', () => {
  const value = history(false);
  value.tasks = [];
  Object.assign(value.executions[0], {
    localTaskID: null,
    executionState: 'not_started',
    executionSequence: 0,
    deliveryError: 'Recorded acceptance rejection',
  });
  assert.equal(check(value).tasks.length, 0);
  value.executions = [];
  assert.equal(check(value).executions.length, 0);
});

test('resume refuses every non-accepted task state', () => {
  for (const state of [
    'open',
    'ready',
    'running',
    'waiting_approval',
    'waiting_input',
    'stopping',
    'stopped',
    'interrupted',
    'failed',
    'review',
    'unknown',
  ]) {
    const value = history();
    value.tasks[0].state = state as TaskState;
    assert.throws(() => check(value), /accepted/);
  }
});

test('resume refuses missing or duplicate official sessions', () => {
  const value = history();
  value.tasks[0].sessionID = null;
  assert.throws(() => check(value), /session/);
  value.tasks[0].sessionID = '';
  assert.throws(() => check(value), /session/);
  const duplicate = history();
  duplicate.tasks.push({ ...duplicate.tasks[0], id: '88888888-8888-4888-8888-888888888888' });
  assert.throws(() => check(duplicate), /Duplicate official session/);
});

test('resume refuses real model configuration or pending interaction', () => {
  const value = history();
  value.tasks[0].model = 'other/model';
  assert.throws(() => check(value), /fixture/);
  value.tasks[0].model = 'fixture/m34';
  value.tasks[0].approvals = [{} as Task['approvals'][number]];
  assert.throws(() => check(value), /interaction/);
  value.tasks[0].approvals = [];
  value.tasks[0].questions = [{} as Task['questions'][number]];
  assert.throws(() => check(value), /interaction/);
});

test('resume refuses changed Worker, owner Node, Brain or execution binding', () => {
  for (const field of ['targetNodeID', 'ownerNodeID', 'ownerBrainID', 'localTaskID'] as const) {
    const value = history();
    value.executions[0][field] = 'changed';
    assert.throws(() => check(value));
  }
  const value = history();
  value.tasks[0].remoteOrigin = undefined;
  assert.throws(() => check(value));
});

test('resume refuses pending delivery, error or incomplete execution state', () => {
  for (const change of [
    { deliveryPending: true },
    { deliveryError: 'pending failure' },
    { controlPending: true },
    { status: 'pending' },
    { executionState: 'review' },
    { executionStatus: 'ready' },
    { executionLeaseID: 'still-leased' },
    { direction: 'outgoing' },
  ]) {
    const value = history();
    Object.assign(value.executions[0], change);
    assert.throws(() => check(value));
  }
});

test('resume refuses unbound acceptance that could launch work after startup', () => {
  const value = history(false);
  value.tasks = [];
  Object.assign(value.executions[0], { localTaskID: null, executionState: 'not_started' });
  assert.throws(() => check(value), /unbound/);
});

test('resume refuses duplicate IDs or duplicate execution-to-task bindings', () => {
  for (const field of ['projects', 'tasks', 'executions'] as const) {
    const value = history();
    (value[field] as unknown[]).push(structuredClone(value[field][0]));
    assert.throws(() => check(value), /Duplicate/);
  }
  const value = history();
  value.executions.push({ ...value.executions[0], id: '88888888-8888-4888-8888-888888888888' });
  assert.throws(() => check(value), /binding/);
});

test('resume refuses unrelated, relocated or traversing Project paths', () => {
  for (const directory of [resolve('outside'), join(workerRoot, 'other'), workerRoot]) {
    const value = history();
    value.projects[1].directory = directory;
    assert.throws(() => check(value), /Project/);
  }
  const value = history();
  value.executions[0].id = '../authorized-folder';
  value.tasks[0].remoteOrigin!.remoteTaskID = value.executions[0].id;
  assert.throws(() => check(value), /Execution ID/);
});

test('resume refuses same-name substitutes and extra or missing Projects', () => {
  const value = history(false);
  value.executions[0].requestedProjectID = portableID;
  assert.throws(() => check(value), /Project/);
  const extra = history();
  extra.projects.push({ id: 'extra', directory: join(workerRoot, 'extra') });
  assert.throws(() => check(extra), /Project/);
  extra.projects = [];
  assert.throws(() => check(extra), /Project/);
});

test('resume evidence comparison is independent of array order', () => {
  const value = history();
  const expected = check(value);
  value.projects.reverse();
  assert.deepEqual(check(value), expected);
});
