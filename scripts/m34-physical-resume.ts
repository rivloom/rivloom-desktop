// Read-only preflight for the physical-test helper, never a product migration.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project, RemoteTaskInvite, Task } from '../shared/types.ts';

const canonical = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const byID = <T extends { id: string }>(items: T[]) =>
  [...items].sort((left, right) => left.id.localeCompare(right.id));

// Metadata only: this does not read, copy or hash project contents.
export function inspectPhysicalHistory(
  workerRoot: string,
  nodeID: string,
  projectID: string,
  projects: Pick<Project, 'id' | 'directory'>[],
  tasks: Task[],
  executions: RemoteTaskInvite[],
) {
  for (const records of [projects, tasks, executions])
    assert.equal(new Set(records.map((item) => item.id)).size, records.length, 'Duplicate IDs');
  const authorized = projects.find((project) => project.id === projectID);
  assert(authorized, 'Original authorized Project is missing');
  assert.equal(
    canonical(resolve(authorized.directory)),
    canonical(join(workerRoot, 'authorized-folder')),
    'Authorized Project moved',
  );
  const expectedProjects = new Set([projectID]);
  const sessions = new Set<string>();
  for (const task of tasks) {
    assert.equal(task.state, 'accepted', 'Only accepted business tasks may be resumed');
    assert.equal(task.model, 'fixture/m34', 'Only fixture tasks may be resumed');
    assert(typeof task.sessionID === 'string' && task.sessionID.length > 0, 'Missing session');
    assert(!sessions.has(task.sessionID), 'Duplicate official session');
    sessions.add(task.sessionID);
    assert(
      task.approvals.length === 0 && task.questions.length === 0,
      'Pending interaction must be inspected before resume',
    );
    assert(task.remoteOrigin, 'Missing original remote binding');
    const bound = executions.filter((execution) => execution.localTaskID === task.id);
    assert.equal(bound.length, 1, 'Expected one execution-to-task binding');
    const execution = bound[0];
    assert.equal(task.remoteOrigin.remoteTaskID, execution.id, 'Execution binding changed');
    assert.equal(task.remoteOrigin.ownerNodeID, execution.ownerNodeID, 'Owner Node changed');
    assert.equal(task.remoteOrigin.ownerBrainID, execution.ownerBrainID, 'Owner Brain changed');
    assert.match(execution.id, uuid, 'Invalid Execution ID');
    const project = projects.find((item) => item.id === task.projectID);
    assert(project, 'Task Project is missing');
    if (execution.requestedProjectID === null) {
      assert.notEqual(project.id, projectID, 'Portable Task substituted the authorized Project');
      assert.equal(
        canonical(resolve(project.directory)),
        canonical(join(workerRoot, 'portable-tasks', execution.id)),
        'Portable Project must retain its exact Execution directory',
      );
    } else {
      assert.equal(execution.requestedProjectID, projectID, 'Requested Project changed');
      assert.equal(project.id, projectID, 'Project Task was redirected');
    }
    expectedProjects.add(project.id);
  }
  assert.deepEqual(
    projects.map((project) => project.id).sort(),
    [...expectedProjects].sort(),
    'Unrelated Project cannot be resumed by this test helper',
  );
  for (const execution of executions) {
    assert.match(execution.id, uuid, 'Invalid Execution ID');
    assert.equal(execution.direction, 'incoming', 'Only incoming test executions are supported');
    assert.equal(execution.targetNodeID, nodeID, 'Execution Worker changed');
    assert.equal(execution.status, 'accepted', 'Only accepted invitations are supported');
    assert.equal(execution.deliveryPending, false, 'Pending delivery could replay work');
    assert(!execution.controlPending, 'Pending control must be inspected');
    assert.equal(execution.executionStatus, 'unprepared', 'Execution still has a preparation');
    assert.equal(execution.executionLeaseID, null, 'Execution still has a lease');
    if (execution.localTaskID) {
      assert(
        tasks.some((task) => task.id === execution.localTaskID),
        'Missing task binding',
      );
      assert.equal(execution.executionState, 'accepted', 'Execution is not accepted');
      assert.equal(execution.deliveryError, null, 'Completed execution has a delivery error');
    } else {
      assert(
        execution.localTaskID === null &&
          execution.executionState === 'not_started' &&
          execution.executionSequence === 0 &&
          !!execution.deliveryError,
        'Only a recorded failed, unbound acceptance may remain',
      );
    }
  }
  return {
    projects: byID(projects.map(({ id, directory }) => ({ id, directory }))),
    tasks: byID(
      tasks.map(({ id, projectID, state, model, sessionID, remoteOrigin }) => ({
        id,
        projectID,
        state,
        model,
        sessionID,
        remoteOrigin,
      })),
    ),
    executions: byID(
      executions.map((execution) => ({
        id: execution.id,
        brainTaskID: execution.brainTaskID,
        ownerNodeID: execution.ownerNodeID,
        ownerBrainID: execution.ownerBrainID,
        targetNodeID: execution.targetNodeID,
        requestedProjectID: execution.requestedProjectID,
        localTaskID: execution.localTaskID,
        status: execution.status,
        executionState: execution.executionState,
        executionSequence: execution.executionSequence,
        deliveryPending: execution.deliveryPending,
        deliveryError: execution.deliveryError,
      })),
    ),
  };
}

export function physicalSessionIDs(workerRoot: string) {
  const path = join(workerRoot, 'engine', 'data', 'opencode', 'opencode.db');
  if (!existsSync(path)) return [];
  assert.equal(
    canonical(realpathSync(path)),
    canonical(path),
    'Do not read sessions through links',
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare('SELECT id FROM session')
      .all()
      .map((row) => String(row.id))
      .sort();
  } finally {
    db.close();
  }
}

export function checkPhysicalResume(root: string, expectedNodeID: string) {
  root = resolve(root);
  assert.equal(dirname(root), resolve('.data', 'm34-physical'), 'Resume only a physical-test root');
  assert.match(basename(root), /^[a-f0-9-]{36}$/i, 'Expected an existing test UUID directory');
  assert.match(expectedNodeID, /^[A-Za-z0-9_-]{32}$/, 'Pass the expected original Node ID');
  const workerRoot = join(root, 'worker');
  const configPath = join(workerRoot, 'engine', 'config', 'opencode', 'opencode.json');
  const directory = join(workerRoot, 'authorized-folder');
  for (const path of [
    root,
    workerRoot,
    directory,
    configPath,
    ...[
      'node-identity.json',
      'execution-policy.json',
      'rivloom.sqlite',
      'remote-task-invites.json',
      'trusted-nodes.json',
      'brain-topology.json',
    ].map((name) => join(workerRoot, name)),
  ]) {
    assert.equal(canonical(realpathSync(path)), canonical(path), 'Do not resume through links');
  }
  assert(
    !existsSync(join(workerRoot, 'app.lock')),
    'Inspect the existing Worker lock before resuming',
  );
  const read = (name: string) => JSON.parse(readFileSync(join(workerRoot, name), 'utf8'));
  // Never print or return the protected identity or credential fields.
  assert.equal(
    read('node-identity.json').nodeID,
    expectedNodeID,
    'Original Worker identity changed',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.enabled_providers, ['fixture']);
  assert.deepEqual(Object.keys(config.provider), ['fixture']);
  assert.equal(config.model, 'fixture/m34');
  assert.equal(config.small_model, 'fixture/m34');
  assert.equal(config.provider.fixture.options.apiKey, 'local-test-only', 'Test credentials only');
  assert.match(config.provider.fixture.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const policy = read('execution-policy.json').policy;
  assert.equal(policy.enabled, true);
  assert.equal(policy.model, 'fixture/m34');
  assert.equal(policy.approvalMode, 'ask');
  assert.equal(policy.maxConcurrent, 1);
  const executions = read('remote-task-invites.json').tasks as RemoteTaskInvite[];
  assert(Array.isArray(executions));
  const db = new DatabaseSync(join(workerRoot, 'rivloom.sqlite'), { readOnly: true });
  let history: ReturnType<typeof inspectPhysicalHistory>;
  try {
    const projects = db
      .prepare('SELECT id, directory FROM projects')
      .all()
      .map((row) => ({ id: String(row.id), directory: String(row.directory) }));
    const tasks = db
      .prepare('SELECT body FROM tasks')
      .all()
      .map((row) => JSON.parse(String(row.body)) as Task);
    history = inspectPhysicalHistory(
      workerRoot,
      expectedNodeID,
      policy.projectID,
      projects,
      tasks,
      executions,
    );
    for (const project of projects)
      assert.equal(
        canonical(realpathSync(project.directory)),
        canonical(project.directory),
        'Do not resume Project links',
      );
  } finally {
    db.close();
  }
  const sessionIDs = physicalSessionIDs(workerRoot);
  assert.deepEqual(
    sessionIDs,
    history.tasks.map((task) => task.sessionID).sort(),
    'Official sessions differ from preserved tasks',
  );
  return {
    nodeID: expectedNodeID,
    projectID: String(policy.projectID),
    history,
    sessionIDs,
  };
}
