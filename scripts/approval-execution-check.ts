// Real Rivloom and official OpenCode services; every model response comes from loopback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApprovalMode, Project, Task } from '../shared/types.ts';
import type { Workflow } from '../shared/workflows.ts';
import { modelFixture, ServiceClient, pairServices, until } from './m34-fixtures.ts';

export async function checkApprovalExecution() {
  const root = resolve('.data', 'approval-execution', randomUUID());
  mkdirSync(root, { recursive: true });
  const cases = new Map<string, { directory: string; mode: ApprovalMode; network?: boolean }>();
  const observed = new Map<string, string[]>();
  let ownNode = '';
  const fixture = await modelFixture(120_000, (input) => {
    const text = input.messages.filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content)).join('\n');
    const system = input.messages.filter((m: any) => m.role === 'system').map((m: any) => JSON.stringify(m.content)).join('\n');
    const entry = [...cases].find(([key]) => text.includes(key));
    if (!entry || !system.includes('Report only')) return { content: 'Approval verification title' };
    const [key, expected] = entry;
    const workflow = text.includes('最后只返回一个符合下列 JSON Schema');
    if (workflow && text.includes('此会话只允许读取和规划')) return { content: JSON.stringify({ kind: 'plan', plan: {
      summary: 'Verify actual tool authorization', steps: [{ id: 'execute', title: key, instructions: key,
        dependsOn: [], nodeID: ownNode, resources: [], software: [], requirements: {} }] } }) };
    assert(system.includes(`permission mode \\"${expected.mode}\\"`), `${key}: missing actual approval policy in system prompt`);
    assert(!text.includes('每次修改和命令等待审批'), `${key}: obsolete unconditional approval instruction`);
    observed.set(key, [...(observed.get(key) || []), system]);
    const tools = input.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.tool_calls || []).map((c: any) => c.function?.name);
    if (expected.network && !tools.includes('webfetch')) return { toolName: 'webfetch', arguments: {
      url: 'https://example.invalid/approval-fixture-never-requested', format: 'text' } };
    if (!expected.network && !tools.includes('write')) return { toolName: 'write', arguments: {
      filePath: join(expected.directory, `${key}.txt`), content: `${key}: actual automatic write\n` } };
    if (!expected.network && !tools.includes('bash')) return { toolName: 'bash', arguments: {
      command: 'echo approval-command-ok', description: 'Print a synthetic approval verification marker' } };
    return { content: workflow ? JSON.stringify({ kind: 'completed', summary: 'Tool execution verified', files: [] }) : 'Tool execution verified' };
  });
  fixture.release();
  const clients = [new ServiceClient(join(root, 'origin')), new ServiceClient(join(root, 'worker'))];
  const [origin, worker] = clients;
  const socket = createSocket('udp4'); await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
  const port = socket.address().port; await new Promise<void>((ok) => socket.close(() => ok()));
  const discovery = { port, mdns: false };
  const checks: string[] = [];
  const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
  let status = 'failed'; let failure = '';
  try {
    for (const client of clients) fixture.configure(client.root);
    await Promise.all(clients.map((client, i) => client.start({ discovery, logPath: join(root, `service-${i}.log`) })));
    ownNode = (await origin.network()).local!.id;
    const workerNode = (await worker.network()).local!.id;
    const projects: Project[] = [];
    for (const client of clients) {
      const directory = join(client.root, 'project'); mkdirSync(directory);
      projects.push(await client.call('/projects', { name: 'Approval verification', directory, trusted: true }, 201));
    }
    await pairServices(origin, worker);
    const policy = async (client: ServiceClient, index: number, mode: ApprovalMode) => {
      const saved = await client.call('/network/execution-policy', { enabled: true, approvalMode: mode,
        projectID: projects[index].id, model: 'fixture/m34', confirmed: true });
      assert.equal(saved.approvalMode, mode);
      assert.equal((await client.bootstrap()).executionPolicy.approvalMode, mode);
    };
    await policy(origin, 0, 'auto'); await policy(worker, 1, 'auto');
    await until(() => origin.network(), (network) => network.brains.some((brain) => brain.state === 'established' && brain.online &&
      network.paired?.find((node) => node.id === workerNode)?.brains.some((peerBrain) => peerBrain.id === brain.id)), 'shared Brain registration');
    const task = async (client: ServiceClient, id: string): Promise<Task> => (await client.call(`/tasks/${id}`)).task;
    const done = async (client: ServiceClient, id: string, key: string) => {
      const result = await until(() => task(client, id), (t) => ['accepted', 'failed', 'waiting_approval'].includes(t.state), key);
      assert.equal(result.state, 'accepted', JSON.stringify({ state: result.state, approvals: result.approvals, error: result.error }));
      assert.equal(result.approvalMode, cases.get(key)!.mode);
      const tools = result.messages.flatMap((m) => m.tools);
      assert(tools.some((t) => t.name === 'write' && t.status === 'completed'));
      assert(tools.some((t) => t.name === 'bash' && t.status === 'completed' && t.output.includes('approval-command-ok')));
      assert.equal(readFileSync(join(cases.get(key)!.directory, `${key}.txt`), 'utf8'), `${key}: actual automatic write\n`);
      assert(observed.has(key)); return result;
    };
    const local = async (key: string, mode: ApprovalMode, network = false, queued = false) => {
      cases.set(key, { directory: projects[0].directory, mode, network });
      const actor = (await origin.bootstrap()).user;
      const value = await origin.call('/tasks', { projectID: projects[0].id, title: key, description: key,
        ...(queued ? { runRequested: true, requestID: randomUUID() } : {}),
        criteria: 'Verify actual execution', model: 'fixture/m34', approvalMode: mode,
        assigneeID: actor.id, approverID: actor.id, reviewerID: actor.id }, 201);
      if (!queued) {
        await origin.call(`/tasks/${value.id}/claim`, {});
        await origin.call(`/tasks/${value.id}/run`, { confirmed: true });
      }
      return value;
    };
    const localAuto = await local('LOCAL_AUTO', 'auto'); await done(origin, localAuto.id, 'LOCAL_AUTO');
    pass('Local auto task actually writes and runs a command with no manual approval');
    const localFull = await local('LOCAL_FULL', 'full'); await done(origin, localFull.id, 'LOCAL_FULL');
    pass('Full mode still executes project files and commands automatically');
    cases.set('REMOTE_AUTO', { directory: projects[1].directory, mode: 'auto' });
    const remote = await origin.call(`/network/nodes/${workerNode}/tasks`, { title: 'REMOTE_AUTO', description: 'REMOTE_AUTO',
      criteria: 'Verify actual execution', confirmed: true, requestID: randomUUID() }, 201);
    assert(remote.createdTaskID);
    const received = await until(() => worker.bootstrap(), (b) => b.tasks.some((t) => t.remoteOrigin?.remoteTaskID === remote.createdTaskID), 'remote local binding');
    const receiver = received.tasks.find((t) => t.remoteOrigin?.remoteTaskID === remote.createdTaskID)!;
    await done(worker, receiver.id, 'REMOTE_AUTO');
    pass('A paired sender uses the receiving machine auto policy and both tools actually complete');
    cases.set('WORKFLOW_AUTO', { directory: projects[0].directory, mode: 'auto' });
    const workflow = await origin.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'WORKFLOW_AUTO', description: 'WORKFLOW_AUTO',
      projectID: projects[0].id, model: 'fixture/m34', approvalMode: 'auto', target: { mode: 'locked', nodeID: ownNode } }, 201);
    const completed = await until(() => origin.call<Workflow>(`/workflows/${workflow.id}`), (w) => ['completed', 'failed'].includes(w.state), 'workflow auto');
    assert.equal(completed.state, 'completed', JSON.stringify({ state: completed.state, error: completed.error }));
    await done(origin, completed.steps[0].attempts[0].executionID, 'WORKFLOW_AUTO');
    pass('A read-only planner leads to an auto executor that actually writes and runs a command');
    const asks = await local('LOCAL_ASK', 'ask', false, true);
    const waiting = await until(() => task(origin, asks.id), (t) => t.state === 'waiting_approval', 'ask gate');
    assert.equal(waiting.approvals[0].permission, 'edit');
    assert(!existsSync(join(projects[0].directory, 'LOCAL_ASK.txt')));
    await policy(origin, 0, 'full');
    assert.equal((await task(origin, asks.id)).approvalMode, 'ask');
    assert.equal((await task(origin, asks.id)).approvals[0].id, waiting.approvals[0].id);
    assert(!existsSync(join(projects[0].directory, 'LOCAL_ASK.txt')));
    await origin.call(`/tasks/${asks.id}/stop`, {});
    pass('Explicit ask blocks writes, and saving a new default never approves an existing request');
    const queueRow = async (client: ServiceClient, id: string) => (await client.call('/node-queue')).entries.find((e: any) => e.localTaskID === id);
    const stoppedRow = await until(() => queueRow(origin, asks.id), (e) => e?.state === 'ended', 'local stopped queue cleanup');
    assert.equal(stoppedRow.endReason.code, 'stopped');
    const next = await local('AFTER_STOP', 'auto', false, true); await done(origin, next.id, 'AFTER_STOP');
    await origin.stop(); await origin.start({ discovery, logPath: join(root, 'origin-restarted.log') });
    assert.equal((await task(origin, asks.id)).state, 'stopped');
    assert.equal((await task(origin, asks.id)).sessionID, waiting.sessionID);
    assert.equal((await queueRow(origin, asks.id)).id, stoppedRow.id);
    assert.equal((await queueRow(origin, asks.id)).state, 'ended');
    assert(!existsSync(join(projects[0].directory, 'LOCAL_ASK.txt')));
    pass('Confirmed local stop ends the queue, allows the next queued task and survives restart without replay');
    await origin.call(`/tasks/${asks.id}/run`, { confirmed: true, addition: 'Continue this existing execution.' });
    const continued = await until(() => task(origin, asks.id), (t) => t.state === 'waiting_approval', 'explicit stopped task continuation');
    assert.equal(continued.sessionID, waiting.sessionID);
    assert.equal((await queueRow(origin, asks.id)).state, 'ended', 'Explicit continuation never reopens automatic dispatch');
    await origin.call(`/tasks/${asks.id}/stop`, {});
    pass('An explicit continuation reuses the stopped session and remains subject to its original approval mode');
    const net = await local('AUTO_NETWORK', 'auto', true);
    const netWaiting = await until(() => task(origin, net.id), (t) => t.state === 'waiting_approval', 'network gate');
    assert.equal(netWaiting.approvals[0].permission, 'webfetch');
    await origin.call(`/tasks/${net.id}/stop`, {});
    pass('Auto mode still asks before a network request; no external HTTP request is executed');
    const reject = await local('NETWORK_REJECT', 'auto', true);
    const rejection = await until(() => task(origin, reject.id), (t) => t.state === 'waiting_approval', 'network rejection');
    await origin.call(`/tasks/${reject.id}/permissions/${rejection.approvals[0].id}`, { reply: 'reject' });
    const rejected = await until(() => task(origin, reject.id), (t) => ['accepted', 'failed'].includes(t.state), 'permission rejection completes');
    assert.equal(rejected.approvals.length, 0);
    assert(rejected.messages.some((m) => m.tools.some((t) => t.name === 'webfetch' && t.status === 'error')));
    pass('The displayed official fallback request can be rejected and disappears without executing the tool');
    await policy(worker, 1, 'ask');
    cases.set('REMOTE_ASK', { directory: projects[1].directory, mode: 'ask' });
    const remoteAsk = await origin.call(`/network/nodes/${workerNode}/tasks`, { title: 'REMOTE_ASK', description: 'REMOTE_ASK',
      criteria: 'Verify receiving policy', confirmed: true, requestID: randomUUID() }, 201);
    assert(remoteAsk.createdTaskID);
    const askState = await until(() => worker.bootstrap(), (b) => b.tasks.some((t) => t.remoteOrigin?.remoteTaskID === remoteAsk.createdTaskID && t.state === 'waiting_approval'), 'remote ask gate');
    const askTask = askState.tasks.find((t) => t.remoteOrigin?.remoteTaskID === remoteAsk.createdTaskID)!;
    assert.equal(askTask.approvalMode, 'ask'); assert(!existsSync(join(projects[1].directory, 'REMOTE_ASK.txt')));
    await origin.stop();
    await worker.call(`/tasks/${askTask.id}/stop`, {});
    const remoteStopped = await until(() => queueRow(worker, askTask.id), (e) => e?.state === 'ended', 'remote stopped queue while sender offline');
    assert.equal(remoteStopped.endReason.code, 'stopped');
    assert.equal((await task(worker, askTask.id)).sessionID, askTask.sessionID);
    pass('The sender full default does not override the receiving machine ask policy');
    pass('A receiving machine closes its confirmed stopped queue while the sender is offline, retaining the original task and session');
    await origin.start({ discovery, logPath: join(root, 'origin-remote-continuation.log') });
    const refreshed = await until(() => origin.network(), (n) => n.remoteTasks.some((r) => r.id === remoteAsk.createdTaskID && r.executionState === 'stopped'), 'sender receives stopped execution');
    const receivedStop = refreshed.remoteTasks.find((r) => r.id === remoteAsk.createdTaskID)!;
    await origin.call(`/network/tasks/${remoteAsk.createdTaskID}/control`, { confirmed: true,
      expectedExecutionSequence: receivedStop.executionSequence, action: { kind: 'supplement', text: 'Continue the existing execution.' } });
    const remoteContinued = await until(() => task(worker, askTask.id), (t) => t.state === 'waiting_approval', 'remote explicit continuation');
    assert.equal(remoteContinued.sessionID, askTask.sessionID);
    assert.equal((await queueRow(worker, askTask.id)).state, 'ended');
    await worker.call(`/tasks/${askTask.id}/stop`, {});
    pass('Authenticated remote continuation reuses the original stopped session without reopening automatic admission');
    status = 'passed';
  } catch (error) { failure = String(error instanceof Error ? error.stack : error); throw error; }
  finally {
    await Promise.allSettled(clients.map((client) => client.stop())); await fixture.close();
    writeFileSync(join(root, 'result.json'), JSON.stringify({ status, checks, failure, externalModelRequests: false, root }, null, 2));
    console.log(`Approval execution result: ${status}; ${root}`);
  }
}
