// Complete owned services with the official engine and a loopback-only model.
// Does not invoke a desktop installer or read the installed application's data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { NodeQueueStore } from '../server/node-queue.ts';
import type { Task } from '../shared/types.ts';
import type { Workflow, WorkflowRound } from '../shared/workflows.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';

const root = resolve('.data', 'desktop-update-service', `${Date.now()}-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const fixture = await modelFixture();
const client = new ServiceClient(join(root, 'application'));
const assertions: string[] = [];
const pass = (value: string) => { assertions.push(value); console.log('PASS', value); };
// Stop reconciliation can refresh timestamps/version without executing anything.
const workflowExecutionState = (value: Workflow) => {
  const result = structuredClone(value);
  delete (result as Partial<Workflow>).version;
  delete (result as Partial<Workflow>).updatedAt;
  for (const step of [result.planner, ...result.steps])
    for (const attempt of step.attempts) delete (attempt as Partial<typeof attempt>).updatedAt;
  return result;
};
let status = 'failed';
try {
  fixture.configure(client.root); loadNodeIdentity(client.root);
  await client.start({ logPath: join(root, 'service.log') });
  const tokenHeader = () => ({ 'X-Rivloom-Desktop-Token': readFileSync(join(client.root, 'desktop-auth-token.txt'), 'utf8').trim() });
  const native = (path: string, body: unknown, status = 200) => client.call(`/desktop-update/${path}`, body, status, tokenHeader());
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403);
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403, { 'X-Rivloom-Desktop-Token': 'invalid' });
  await client.call('/desktop-update/prepare', { version: '0.1.6' }, 403, { ...tokenHeader(), Origin: 'https://evil.example' });
  pass('A browser session, incorrect native token and foreign origin cannot start update maintenance');
  const prepared = await native('prepare', { version: '0.1.6' });
  assert.equal(prepared.ready, true); assert(prepared.lease);
  await native('prepare', { version: '0.1.6' }, 409);
  await client.call('/network/execution-concurrency', { maxConcurrent: 4 }, 503);
  await native('cancel', { lease: randomUUID() }, 409);
  await native('cancel', { lease: prepared.lease });
  await client.call('/network/execution-concurrency', { maxConcurrent: 4 });
  await native('commit', { lease: prepared.lease }, 409);
  pass('Preparation fences writes, rejects duplicate or stale callers and cancellation restores the original service');
  const initial = await client.bootstrap(); const owner = initial.user.id;
  const directory = join(root, 'project'); mkdirSync(directory);
  const project = await client.call('/projects', { name: 'Updater fixture project', directory, trusted: true }, 201);
  const task = await client.call<Task>('/tasks', { requestID: randomUUID(), runRequested: true,
    projectID: project.id, title: 'UPDATE_LOCAL_FIXTURE', description: 'Reply briefly. Do not use tools.', criteria: 'Return a response.',
    assigneeID: owner, approverID: owner, reviewerID: owner, model: 'fixture/m34', approvalMode: 'ask' }, 201);
  await until(async () => fixture.pendingRequests, (value) => value > 0, 'loopback model request');
  const blocked = await native('prepare', { version: '0.1.6' });
  assert.equal(blocked.ready, false); assert(blocked.blockers.tasks > 0); assert.equal(blocked.lease, null);
  await client.call('/network/execution-concurrency', { maxConcurrent: 5 });
  assert.equal((await client.bootstrap()).tasks.find((t) => t.id === task.id)?.state, 'running');
  pass('Active official-engine execution blocks installation without stopping its task, and failed preparation releases intake');
  await client.call(`/tasks/${task.id}/stop`, {});
  await until(() => client.bootstrap(), (b) => b.tasks.find((t) => t.id === task.id)?.state === 'stopped', 'controlled task stop');
  const session = (await client.bootstrap()).tasks.find((t) => t.id === task.id)!.sessionID;
  assert(session);
  const identity = (await client.network()).local!.id;
  await client.stop();
  assert.equal(client.child!.exitCode, 0, 'Only seed the owned fixture after a clean stop');
  const seedDatabase = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  let seededWorkflows: Workflow[];
  let seededQueue: NodeQueueSnapshot;
  try {
    const workflows = new WorkflowStore(seedDatabase);
    const queue = new NodeQueueStore(seedDatabase);
    const peer = randomUUID().replaceAll('-', '');
    seededWorkflows = (['paused', 'stopping'] as const).map((state) => {
      const created = workflows.create({ requestID: randomUUID(), creatorID: owner,
        title: `UPDATE_SAVED_${state.toUpperCase()}`, description: 'Synthetic saved conversation. Do not dispatch.',
        projectID: project.id, model: 'fixture/m34', approvalMode: 'ask', target: { mode: 'locked', nodeID: peer }, inputFiles: [] });
      return workflows.update(created.id, (value) => {
        const archived: WorkflowRound = {
          requestID: randomUUID(), createdAt: value.createdAt, updatedAt: value.createdAt,
          description: 'Synthetic previous round', criteria: '', state: 'stopped', planVersion: 0,
          summary: 'Saved previous result', planner: { ...structuredClone(value.planner), state: 'cancelled' },
          steps: [], events: [], handoffs: [], inputFiles: [], confirmations: [], pendingConfirmation: null, error: null,
        };
        value.state = state; value.queuePaused = true;
        value.queuePauseReason = state === 'paused' ? 'manual' : 'stopped';
        value.roundRequestID = value.requestID; value.roundCreatedAt = value.createdAt;
        value.rounds = [archived];
        value.messages = [{ requestID: randomUUID(), text: 'Synthetic queued follow-up', inputFiles: [],
          createdAt: value.createdAt, state: 'queued', model: 'fixture/m34' }];
        if (state === 'stopping') {
          const executionID = randomUUID(); value.error = 'workflow_stop_unconfirmed'; value.planner.state = 'running';
          value.planner.attempts = [{ number: 1, executionID, nodeID: peer, kind: 'remote', phase: 'unknown',
            createdAt: value.createdAt, updatedAt: value.createdAt, summary: '', outcome: null, inputFiles: [], outputFiles: [],
            error: 'workflow_stop_unconfirmed', handled: false,
            context: { workflowID: value.id, stepID: 'planner', attempt: 1, role: 'planner', target: value.target,
              instructions: value.description, evidence: '', priorContext: '' } }];
          value.events = [{ id: 1, kind: 'state', text: 'stopping', stepID: null, at: value.createdAt }];
        }
      });
    });
    const previous = JSON.parse(String(seedDatabase.prepare('SELECT body FROM tasks WHERE id=?').get(task.id)!.body)) as Task;
    const number = Number(seedDatabase.prepare('SELECT MAX(number) AS number FROM tasks').get()!.number);
    for (const [index, state] of (['waiting', 'held'] as const).entries()) {
      const queued: Task = { ...structuredClone(previous), id: randomUUID(), number: number + index + 1,
        title: `UPDATE_SAVED_QUEUE_${state.toUpperCase()}`, state: 'ready', sessionID: null, version: 1,
        runAfter: 0, messages: [], approvals: [], questions: [], artifacts: [], diffSource: '', error: null };
      delete queued.telemetry;
      seedDatabase.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(queued.id, queued.number, queued.projectID, JSON.stringify(queued));
      const entry = queue.enqueue({ kind: 'local', taskID: queued.id });
      if (state === 'held') queue.control({ operationID: randomUUID(), itemID: entry.id, expectedVersion: entry.version, action: 'hold' });
    }
    queue.setPaused({ operationID: randomUUID(), expectedVersion: queue.snapshot().version, paused: true });
    seededQueue = queue.snapshot();
  } finally { seedDatabase.close(); }
  const savedIDs = new Set(seededWorkflows.map((value) => value.id));
  const unknown = seededWorkflows.find((value) => value.state === 'stopping')!.planner.attempts[0];
  const savedQueueIDs = new Set(seededQueue.entries.filter((entry) => entry.source.kind === 'local' &&
    entry.source.taskID !== task.id).map((entry) => entry.id));
  const savedSnapshot = async () => ({
    workflows: (await client.bootstrap()).workflows!.filter((value) => savedIDs.has(value.id)).sort((a, b) => a.id.localeCompare(b.id)),
    queue: await client.call<NodeQueueSnapshot>('/node-queue'),
  });
  const assertSavedState = async () => {
    const snapshot = await savedSnapshot();
    assert.deepEqual(snapshot.workflows.map(workflowExecutionState),
      seededWorkflows.map(workflowExecutionState).sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(snapshot.queue.paused, true);
    assert.deepEqual(snapshot.queue.entries.filter((entry) => savedQueueIDs.has(entry.id)).map((entry) => ({
      id: entry.id, source: entry.source, state: entry.state, admissionPhase: entry.admissionPhase,
    })), seededQueue.entries.filter((entry) => savedQueueIDs.has(entry.id)).map((entry) => ({
      id: entry.id, source: entry.source, state: entry.state, admissionPhase: entry.admissionPhase,
    })));
    assert.equal(fixture.requests, modelRequests, 'Saved conversation/queue must not dispatch a new engine request');
    return snapshot;
  };
  const modelRequests = fixture.requests;
  await client.start({ logPath: join(root, 'saved-state-service.log') });
  await assertSavedState();
  const savedPreparation = await until(() => native('prepare', { version: '0.1.6' }), (value) => value.ready, 'saved conversation update readiness');
  const frozen = await assertSavedState();
  for (let sample = 0; sample < 3; sample++) {
    await wait(600);
    assert.deepEqual(await assertSavedState(), frozen, 'Update maintenance freezes full saved workflow and queue serialization');
  }
  pass('Paused conversations, stopping remote unknown attempts and saved waiting/held queues permit preparation without starting new rounds');
  await native('cancel', { lease: savedPreparation.lease });
  await client.call('/network/execution-concurrency', { maxConcurrent: 5 });
  await wait(1600);
  await assertSavedState();
  pass('Cancellation restores intake while preserving queue pause, queued messages, archived rounds and the same unhandled unknown execution ID');
  const final = await until(() => native('prepare', { version: '0.1.6' }), (value) => value.ready, 'safe update readiness');
  await assertSavedState();
  const exit = new Promise<number | null>((done) => client.child!.once('exit', done));
  await native('commit', { lease: final.lease });
  assert.equal(await exit, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(client.root, 'update-shutdown.json'), 'utf8')), { lease: final.lease, version: '0.1.6', closed: true });
  assert.equal(existsSync(join(client.root, 'desktop-auth-token.txt')), false);
  const database = new DatabaseSync(join(client.root, 'rivloom.sqlite'));
  assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); database.close();
  pass('Commit waits for the owned service and engine, closes SQLite cleanly and leaves the exact lease shutdown receipt');
  fixture.release();
  await client.start({ logPath: join(root, 'restart.log') });
  const restored = await client.bootstrap();
  assert.equal(restored.executionPolicy.maxConcurrent, 5);
  assert.equal((await client.network()).local!.id, identity);
  assert.equal(restored.projects.find((p) => p.id === project.id)?.directory, directory);
  assert.equal(restored.tasks.find((t) => t.id === task.id)?.sessionID, session);
  assert.equal(restored.tasks.find((t) => t.id === task.id)?.state, 'stopped');
  await assertSavedState();
  await wait(1600);
  await assertSavedState();
  const restoredUnknown = restored.workflows!.find((value) => value.state === 'stopping')!.planner.attempts[0];
  assert.equal(restoredUnknown.executionID, unknown.executionID);
  assert.equal(restoredUnknown.phase, 'unknown'); assert.equal(restoredUnknown.handled, false);
  pass('Restart retains the same identity, project, task session and execution policy');
  pass('Clean update exit and restart retain saved conversations and queue policies without turning remote uncertainty into stopped or redispatching');
  status = 'passed';
} finally {
  fixture.release(); await client.stop(); await fixture.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify({ status, assertions, scope: 'isolated services; no installer; no external model' }, null, 2));
}
