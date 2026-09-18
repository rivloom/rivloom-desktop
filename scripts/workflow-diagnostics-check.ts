// Actual local API/authorization checks with isolated storage and the official engine.
// Placement checks start without executable configuration; queue checks stay paused throughout.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { modelFixture, ServiceClient, pairServices, until } from './m34-fixtures.ts';
import type { Workflow } from '../shared/workflows.ts';
import type { WorkflowDiagnosticSnapshot } from '../shared/workflow-diagnostics.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';

const root = resolve(process.env.RIVLOOM_API_OUTPUT || '.data/verification/workflow-waiting-recovery-20260917', `api-${Date.now()}`);
mkdirSync(root, { recursive: true });
const fixture = await modelFixture();
const client = new ServiceClient(join(root, 'service'));
const peer = new ServiceClient(join(root, 'peer'));
const socket = createSocket('udp4'); await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const discovery = { port: socket.address().port, mdns: false };
await new Promise<void>((ok) => socket.close(() => ok()));
const report = { status: 'failed', checks: [] as string[], snapshots: [] as WorkflowDiagnosticSnapshot[], modelRequests: 0 };
const pass = (name: string) => { report.checks.push(name); console.log('PASS', name); };
const create = (who: ServiceClient) => who.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'Diagnostic API isolation',
  description: 'Read-only diagnostic verification', approvalMode: 'ask', target: { mode: 'automatic' } }, 201);
try {
  fixture.configure(client.root);
  fixture.configure(peer.root);
  await Promise.all([client.start({ discovery, logPath: join(root, 'service.log') }), peer.start({ discovery, logPath: join(root, 'peer.log') })]);
  await pairServices(client, peer);
  const peerID = (await peer.network()).local!.id;
  const workflow = await create(client);
  const before = await client.call<Workflow>(`/workflows/${workflow.id}`);
  const beforeTasks = (await client.bootstrap()).tasks;
  for (let i = 0; i < 4; i++) {
    const snapshot = await client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`);
    assert.equal(snapshot.workflowID, workflow.id); assert.equal(snapshot.workflowVersion, before.version);
    assert.equal(snapshot.steps[0].phase, 'placement');
    assert(snapshot.steps[0].nodes.some((n) => n.reasons.some((r) => r.code === 'project_unavailable')));
    report.snapshots.push(snapshot);
  }
  assert.deepEqual(await client.call(`/workflows/${workflow.id}`), before);
  assert.deepEqual((await client.bootstrap()).tasks, beforeTasks);
  assert.equal(fixture.requests, 0);
  pass('Repeated diagnostic GETs preserve workflow version, events, tasks and model request count');
  const remoteUnavailable = await until(() => client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`),
    (s) => s.steps[0].nodes.some((n) => n.nodeID === peerID && n.reasons.some((r) => r.code === 'execution_unavailable')), 'real peer execution report');
  assert(!remoteUnavailable.steps[0].nodes.find((n) => n.nodeID === peerID)!.reasons.some((r) => r.code === 'model_unavailable'));
  await peer.stop();
  const disconnected = await until(() => client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`),
    (s) => s.steps[0].nodes.some((n) => n.nodeID === peerID && n.reasons.some((r) => r.code === 'node_offline')), 'real peer disconnection');
  report.snapshots.push(disconnected);
  await peer.start({ discovery, logPath: join(root, 'peer-restart.log') });
  await until(() => client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`),
    (s) => s.steps[0].nodes.some((n) => n.nodeID === peerID && n.reasons.some((r) => r.code === 'execution_unavailable')), 'real peer reconnection');
  assert.deepEqual(await client.call(`/workflows/${workflow.id}`), before);
  pass('Authenticated peer reports, disconnect and reconnect change diagnosis without executing or guessing remote model state');
  await client.call(`/workflows/${workflow.id}/control`, { action: 'pause' });
  const paused = await client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`);
  assert.equal(paused.steps[0].phase, 'paused');
  await client.call(`/workflows/${workflow.id}/control`, { action: 'resume' });
  assert.equal((await client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`)).steps[0].phase, 'placement');
  pass('Actual pause/resume control takes precedence over placement reasons');
  const invitation = await client.call<{ code: string }>('/invitations', {});
  const member = new ServiceClient(client.root); member.base = client.base;
  await member.call('/auth/join', { code: invitation.code, username: 'diagnostic_member', name: 'Fixture member', password: randomUUID() });
  await member.call(`/workflows/${workflow.id}/diagnostics`, undefined, 404);
  const own = await create(member);
  const memberSnapshot = await member.call<WorkflowDiagnosticSnapshot>(`/workflows/${own.id}/diagnostics`);
  const localID = (await client.network()).local!.id;
  assert(memberSnapshot.steps.every((step) => step.nodes.every((node) => node.nodeID === localID)));
  await client.call(`/workflows/${own.id}/diagnostics`, undefined, 404);
  await client.call(`/workflows/${randomUUID()}/diagnostics`, undefined, 404);
  pass('Creator-only access applies in both directions; member diagnostics remain local');
  await client.call(`/workflows/${workflow.id}/control`, { action: 'pause' });
  await member.call(`/workflows/${own.id}/control`, { action: 'pause' });
  await client.stop(); await client.start({ discovery, logPath: join(root, 'restart.log') });
  const afterRestart = await client.call<WorkflowDiagnosticSnapshot>(`/workflows/${workflow.id}/diagnostics`);
  assert.equal(afterRestart.workflowID, workflow.id); assert.equal(afterRestart.steps[0].executionID, null);
  assert.equal((await client.call<Workflow>(`/workflows/${workflow.id}`)).planner.attempts.length, 0);
  assert.equal(fixture.requests, 0);
  pass('Service restart retains unstarted workflow identity without fabricated execution');
  for (const [executor, nodeID, local] of [[peer, peerID, false], [client, localID, true]] as const) {
    const directory = join(executor.root, 'queue-project'); mkdirSync(directory);
    const project = await executor.call<{ id: string }>('/projects', { name: 'Queue diagnostic fixture', directory, trusted: true }, 201);
    const queue = () => executor.call<NodeQueueSnapshot>('/node-queue');
    await executor.call('/node-queue/pause', { operationID: randomUUID(), expectedVersion: (await queue()).version, paused: true });
    if (!local) await executor.call('/network/execution-policy', { enabled: true, projectID: project.id, model: 'fixture/m34', approvalMode: 'ask', confirmed: true });
    const work = await client.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'Queue status fixture',
      description: 'Must stay queued without a model request', approvalMode: 'ask', target: { mode: 'locked', nodeID },
      ...(local ? { projectID: project.id, model: 'fixture/m34' } : {}) }, 201);
    const diagnostic = async () => {
      const value = await client.call<WorkflowDiagnosticSnapshot>(`/workflows/${work.id}/diagnostics`);
      writeFileSync(join(root, `last-${local ? 'local' : 'remote'}-queue.json`), JSON.stringify(value, null, 2));
      return value;
    };
    const queued = await until(diagnostic, (s) => s.steps[0].phase === 'queued' && !!s.steps[0].queue, 'original queue diagnostic');
    const executionID = queued.steps[0].executionID!;
    assert.equal(queued.steps[0].queue!.local, local);
    if (local) assert.equal(queued.steps[0].queue!.code, 'queue_paused');
    const control = async (action: 'hold' | 'resume' | 'reject') => {
      const snapshot = await queue();
      const item = snapshot.entries.find((e) => e.source.kind === 'local' ? e.source.taskID === executionID : e.source.remoteTaskID === executionID)!;
      assert(item);
      await executor.call(`/node-queue/${item.id}/control`, { operationID: randomUUID(), action, expectedVersion: item.version,
        expectedQueueVersion: snapshot.version, ...(action === 'reject' ? { reason: 'Synthetic queue rejection' } : {}) });
    };
    await control('hold');
    const held = await until(diagnostic, (s) => s.steps[0].phase === 'held', 'held queue diagnostic');
    report.snapshots.push(queued, held);
    assert.equal(held.steps[0].executionID, executionID); assert.equal(held.steps[0].queue!.position, null);
    const beforeRead = await client.call<Workflow>(`/workflows/${work.id}`);
    for (let i = 0; i < 3; i++) assert.equal((await diagnostic()).steps[0].phase, 'held');
    assert.deepEqual(await client.call(`/workflows/${work.id}`), beforeRead);
    await control('resume');
    await until(diagnostic, (s) => s.steps[0].phase === 'queued', 'resumed queue diagnostic');
    await control('reject');
    report.snapshots.push(await until(diagnostic, (s) => ['rejected', 'stopped', 'failed'].includes(s.steps[0].phase), 'rejected queue settles'));
    assert.equal((await client.call<Workflow>(`/workflows/${work.id}`)).planner.attempts.length, 1);
    assert.equal(fixture.requests, 0);
    pass(`${local ? 'Local' : 'Remote'} queue pause, hold, resume and rejection preserve one execution and make zero model requests`);
  }
  report.status = 'passed';
} finally {
  report.modelRequests = fixture.requests;
  await Promise.all([client.stop(), peer.stop()]); await fixture.close();
  writeFileSync(join(root, 'api-report.json'), JSON.stringify(report, null, 2));
  console.log(`Diagnostic API result: ${report.status}; ${root}`);
}
