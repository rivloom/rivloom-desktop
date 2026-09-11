// Real services and official OpenCode, driven solely by a deterministic loopback model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { modelFixture, ServiceClient, pairServices, until, type FixtureModelReply } from './m34-fixtures.ts';
import type { Workflow, WorkflowStepPlan } from '../shared/workflows.ts';
import type { ResourceReference } from '../shared/resources.ts';
import { conversations } from '../shared/conversations.ts';

const root = resolve('.data', 'workflow-service', String(Date.now())); mkdirSync(root, { recursive: true });
const assertions: string[] = []; const pass = (message: string) => { assertions.push(message); console.log('PASS', message); };
let ownNode = ''; let otherNode = ''; let outputDirectory = ''; let remoteDirectory = ''; let resourceReference: ResourceReference | null = null;
let systemBoundRequests = 0;
let releaseParallel!: () => void;
const parallelHeld = new Promise<void>((ok) => { releaseParallel = ok; });
const parallelRequests = new Map<string, { enteredAt: number; releasedAt?: number }>();
let releaseContinuation!: () => void; let continuationEntered = false;
const continuationHeld = new Promise<void>((ok) => { releaseContinuation = ok; });
const step = (id: string, instructions: string, dependsOn: string[] = [], nodeID: string | null = null): WorkflowStepPlan =>
  ({ id, title: id, instructions, dependsOn, nodeID, resources: [], software: [], requirements: {} });
function workflowReply(input: any): FixtureModelReply {
  const userText = (input.messages || []).filter((m: any) => m.role === 'user').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  if (!userText.includes('最后只返回一个符合下列 JSON Schema')) return { content: 'Workflow fixture title' };
  const systemText = (input.messages || []).filter((m: any) => m.role === 'system').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  assert(systemText.includes('You are running one Rivloom collaboration session'), 'Official model request must carry orchestration rules as system instructions');
  assert(!systemText.includes('CASE_SIMPLE'), 'Task content must stay outside the system instructions');
  systemBoundRequests++;
  const planner = userText.includes('此会话只允许读取和规划');
  if (userText.includes('CASE_FOLLOWUP')) {
    const contextPath = /"(\.rivloom-inputs\/[^"\n]+\/rivloom-conversation-\d+\.json)"/.exec(userText)?.[1];
    assert(contextPath, 'Follow-up needs a materialized full conversation transcript');
    const directory = userText.includes(`本次实际执行 Node：${otherNode}`) ? remoteDirectory : outputDirectory;
    const transcript = JSON.parse(readFileSync(join(directory, contextPath), 'utf8'));
    assert(transcript.some((r: any) => r.request.includes('CASE_CONTINUITY') || r.request.includes('CASE_OUTPUT')));
    const read = input.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.some((call: any) => call.function?.name === 'read'));
    if (!read) return { toolName: 'read', arguments: { filePath: join(directory, contextPath) } };
  }
  const outcome: Record<string, unknown> = { kind: 'completed', summary: 'Verified loopback fixture output', files: [] };
  if (planner) {
    if (userText.includes('CASE_FORMAT_CORRECTION') && !userText.includes('上次只读规划未通过 JSON 格式校验'))
      return { content: '{"kind":"query"}\n{"kind":"plan"}' };
    if (userText.includes('CASE_INVALID')) return { toolName: 'StructuredOutput', arguments: { kind: 'plan', plan: {
      summary: 'invalid cycle', steps: [step('a', 'a', ['b']), step('b', 'b', ['a'])] } } };
    if (userText.includes('CASE_QUERY') && !userText.includes('queriedAt')) return { toolName: 'StructuredOutput', arguments: {
      kind: 'query', query: { text: 'source.txt', kinds: ['document'], limit: 10 }, reason: 'Locate the task material' } };
    const steps = userText.includes('CASE_CONTINUITY') ? [step('continue', 'CONTINUITY_FIRST')] :
      userText.includes('CASE_RETRY_WORK') ? [step('keep', 'KEEP_RESULT'), step('retry', 'FAIL_FIRST', ['keep']), step('after', 'AFTER_RETRY', ['retry'])] :
      userText.includes('CASE_REMOTE_DELIVERY') ? [step('write', 'REMOTE_WRITE_CHECKPOINT EXTRA_OUTPUT', [], otherNode)] :
      userText.includes('CASE_FOLLOWUP') ? [step('continue', 'CASE_FOLLOWUP')] :
      userText.includes('CASE_AUTO_PARALLEL') ? [step('script', 'AUTO_SCRIPT'),
      { ...step('video', 'AUTO_PARALLEL_VIDEO', ['script']), resources: [resourceReference!] },
      { ...step('audio', 'AUTO_PARALLEL_AUDIO', ['script']), resources: [resourceReference!] }, step('edit', 'AUTO_JOIN', ['video', 'audio'])] :
      userText.includes('CASE_RETURNED_FILE') ? [step('create', 'REMOTE_WRITE_CHECKPOINT', [], otherNode), step('consume', 'REMOTE_READ_CHECKPOINT', ['create'], otherNode)] :
      userText.includes('CASE_PARALLEL') ? [step('script', 'SCRIPT', [], ownNode),
      step('video', 'VIDEO', ['script'], otherNode), step('audio', 'AUDIO', ['script'], ownNode), step('edit', 'EDIT', ['video', 'audio'], otherNode)] :
      userText.includes('CASE_RESTART_HANDOFF') ? [step('edit', 'HANDOFF_STEP RESTART_TARGET', [], ownNode)] :
      userText.includes('CASE_HANDOFF') ? [step('edit', 'HANDOFF_STEP', [], ownNode)] :
      userText.includes('CASE_OUTPUT') ? [step('write', `WRITE_OUTPUT ${outputDirectory}`, [], ownNode)] :
      userText.includes('CASE_RESOURCE') ? [step('material', 'FETCH_MATERIAL', [], ownNode)] : [step('answer', 'ANSWER', [], null)];
    return { toolName: 'StructuredOutput', arguments: { kind: 'plan', plan: { summary: 'Actual dependency plan', steps } } };
  }
  if (userText.includes('REMOTE_WRITE_CHECKPOINT')) {
    const written = input.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.some((call: any) => call.function?.name === 'write'));
    if (!written) return { toolName: 'write', arguments: { filePath: join(remoteDirectory, 'checkpoint.txt'), content: 'Roundtrip checkpoint.\n' } };
    outcome.files = ['checkpoint.txt'];
    if (userText.includes('EXTRA_OUTPUT')) outcome.files = ['checkpoint.txt', 'remote-extra.txt'];
  }
  if (userText.includes('FAIL_FIRST') && userText.includes('这是当前步骤的第 1 次尝试')) return { content: 'Synthetic invalid executor outcome' };
  if (userText.includes('REMOTE_READ_CHECKPOINT')) {
    const read = input.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.some((call: any) => call.function?.name === 'read'));
    const path = /"(\.rivloom-inputs\/[^"\n]+\/checkpoint\.txt)"/.exec(userText)?.[1]; assert(path, 'Returned file needs an actual receiving-side attachment path');
    if (!read) return { toolName: 'read', arguments: { filePath: join(remoteDirectory, path) } };
  }
  if (userText.includes('WRITE_OUTPUT')) {
    const written = input.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.some((call: any) => call.function?.name === 'write'));
    if (!written) return { toolName: 'write', arguments: { filePath: join(outputDirectory, 'result.txt'), content: 'A verified business result from the official execution.\n' } };
    outcome.files = ['result.txt'];
  }
  if (userText.includes('HANDOFF_STEP') && !userText.includes('HANDOFF_CHECKPOINT')) return { toolName: 'StructuredOutput', arguments: {
    kind: 'handoff', nodeID: otherNode, reason: 'The next operation belongs on the material Node', checkpoint: userText.includes('RESTART_TARGET') ? 'HANDOFF_CHECKPOINT RESTART_TARGET' : 'HANDOFF_CHECKPOINT', files: [], processesStopped: true } };
  if (userText.includes('RESTART_TARGET') && userText.includes('HANDOFF_CHECKPOINT')) return { toolName: 'write',
    arguments: { filePath: join(remoteDirectory, 'restart-output.txt'), content: 'This write must remain unapproved across restart.' } };
  if (userText.includes('FETCH_MATERIAL') && !userText.includes('.rivloom-inputs')) return { toolName: 'StructuredOutput', arguments: {
    kind: 'resources', resources: [resourceReference!], reason: 'Use the registered material', checkpoint: 'Material located', files: [] } };
  return { toolName: 'StructuredOutput', arguments: outcome };
}
const fixture = await modelFixture(120_000, async (input) => {
  const text = (input.messages || []).filter((m: any) => m.role === 'user').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  if (text.includes('最后只返回一个符合下列 JSON Schema') && !text.includes('此会话只允许读取和规划')) {
    if (text.includes('CONTINUITY_FIRST')) { continuationEntered = true; await continuationHeld; }
    const branch = /当前步骤要求：\s*(AUTO_PARALLEL_(?:VIDEO|AUDIO))/.exec(text)?.[1];
    if (branch) {
      const entry = { enteredAt: Date.now(), releasedAt: undefined as number | undefined }; parallelRequests.set(branch, entry);
      await parallelHeld; entry.releasedAt = Date.now();
    }
  }
  const reply = workflowReply(input);
  return 'toolName' in reply && reply.toolName === 'StructuredOutput' ? { content: JSON.stringify(reply.arguments) } : reply;
});
fixture.release();
const clients = [new ServiceClient(join(root, 'origin')), new ServiceClient(join(root, 'worker'))];
const [origin, worker] = clients;
const socket = createSocket('udp4'); await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const port = socket.address().port; await new Promise<void>((ok) => socket.close(() => ok()));
const discovery = { port, mdns: false };
let status = 'failed'; let failure = '';
try {
  for (const client of clients) fixture.configure(client.root);
  await Promise.all(clients.map((client, i) => client.start({ discovery, logPath: join(root, `service-${i}.log`) })));
  const readyNodes = await Promise.all(clients.map((client) => until(() => client.network(), (network) => !!network.local, 'local Node identity')));
  ownNode = readyNodes[0].local!.id; otherNode = readyNodes[1].local!.id;
  const folders: import('../shared/types.ts').Project[] = [];
  for (const client of clients) {
    const directory = join(client.root, 'selected-project'); mkdirSync(directory);
    folders.push(await client.call('/projects', { name: 'Workflow fixture', directory, trusted: true }, 201));
  }
  outputDirectory = folders[0].directory;
  remoteDirectory = folders[1].directory;
  writeFileSync(join(folders[1].directory, 'source.txt'), 'Shared versioned material.\n');
  writeFileSync(join(folders[1].directory, 'remote-extra.txt'), 'Leave this file on the remote device.\n');
  await pairServices(origin, worker);
  const beforeSelection = await origin.call('/resources');
  assert(beforeSelection.nodes.every((n: any) => !n.head?.workspaceID));
  pass('Pairing alone does not publish a work directory');
  for (const [i, client] of clients.entries()) await client.call('/network/execution-policy', {
    enabled: true, projectID: folders[i].id, model: 'fixture/m34', approvalMode: 'ask', confirmed: true,
  });
  await until(() => origin.call('/resources'), (value) => value.nodes.some((n: any) => n.nodeID === otherNode && n.head?.state === 'ready'), 'resource registration');
  const beforeQuery = fixture.requests;
  const query = await origin.call('/resources/query', { text: 'source.txt', kinds: ['document'], limit: 10 });
  assert.equal(fixture.requests, beforeQuery); assert.equal((await worker.bootstrap()).tasks.length, 0);
  const entry = query.entries.find((e: any) => e.nodeID === otherNode && e.name === 'source.txt'); assert(entry);
  resourceReference = { nodeID: entry.nodeID, workspaceID: entry.workspaceID, id: entry.id, revision: entry.revision };
  pass('Selected-directory registration and authenticated query create no model request or execution');
  const create = (description: string, target: Workflow['target'] = { mode: 'preferred', nodeID: ownNode }) => origin.call<Workflow>('/workflows', {
    requestID: randomUUID(), title: description, description, projectID: folders[0].id, model: 'fixture/m34', approvalMode: 'ask', target,
  }, 201);
  const completed = (id: string) => until(() => origin.call<Workflow>(`/workflows/${id}`), (value) => ['completed', 'failed'].includes(value.state), `workflow ${id}`, 90_000);
  const continuity = await create('CASE_CONTINUITY: keep all original constraints', { mode: 'locked', nodeID: ownNode });
  await until(async () => continuationEntered, Boolean, 'first conversation round executing');
  const queuedRequest = { requestID: randomUUID(), text: 'CASE_FOLLOWUP: continue in the same conversation', attachmentIDs: [] };
  const cancelledRequest = { requestID: randomUUID(), text: 'Cancelled message', attachmentIDs: [] };
  await origin.call(`/workflows/${continuity.id}/messages`, queuedRequest, 201);
  await origin.call(`/workflows/${continuity.id}/messages`, queuedRequest, 201);
  await origin.call(`/workflows/${continuity.id}/messages`, cancelledRequest, 201);
  await origin.call(`/workflows/${continuity.id}/messages/control`, { action: 'cancel', requestID: cancelledRequest.requestID });
  const beforeFollowup = await origin.call<Workflow>(`/workflows/${continuity.id}`);
  assert.equal(beforeFollowup.messages!.length, 2); assert.equal(beforeFollowup.rounds, undefined); assert.equal(beforeFollowup.state, 'running');
  releaseContinuation();
  const followed = await until(() => origin.call<Workflow>(`/workflows/${continuity.id}`), (w) => w.roundRequestID === queuedRequest.requestID && ['completed', 'failed'].includes(w.state), 'queued conversation continuation', 90_000);
  assert.equal(followed.state, 'completed', JSON.stringify(followed)); assert.equal(followed.rounds!.length, 1);
  assert.equal(followed.rounds![0].description, continuity.description); assert.equal(followed.target.mode, 'locked');
  assert(followed.planner.attempts[0].inputFiles.some((f) => f.name === 'rivloom-conversation-1.json'));
  const continuityHistory = conversations(await origin.bootstrap());
  assert.equal(continuityHistory.filter((c) => c.workflow?.id === continuity.id).length, 1);
  assert(!continuityHistory.some((c) => c.localTask?.collaboration?.workflowID === continuity.id));
  pass('Queued follow-ups do not interrupt the current round; replay, cancellation, full-context reads and stable history work through official sessions');
  const parallel = await completed((await create('CASE_PARALLEL')).id); assert.equal(parallel.state, 'completed', JSON.stringify(parallel));
  assert.equal(parallel.steps.length, 4); assert.equal(parallel.steps[3].dependsOn.length, 2);
  assert(parallel.steps.some((s) => s.attempts[0].nodeID === otherNode));
  assert.equal(new Set(parallel.steps.filter((s) => ['video', 'audio'].includes(s.id)).map((s) => s.attempts[0].nodeID)).size, 2);
  const incoming = (await worker.bootstrap()).tasks.filter((t) => t.collaboration?.workflowID === parallel.id);
  assert.equal(incoming.length, parallel.steps.filter((s) => s.attempts[0].nodeID === otherNode).length);
  assert(incoming.every((t) => t.remoteOrigin && t.collaborationOutcome?.value.kind === 'completed'));
  pass('Cross-Node branches and an all-predecessor join use real receiving-side tasks and official sessions');
  const automatic = await create('CASE_AUTO_PARALLEL', { mode: 'preferred', nodeID: ownNode });
  await until(async () => parallelRequests.size, (count) => count === 2, 'two simultaneous automatic branch model requests', 60_000);
  const overlapping = await origin.call<Workflow>(`/workflows/${automatic.id}`);
  const branchAttempts = overlapping.steps.filter((s) => ['video', 'audio'].includes(s.id)).map((s) => s.attempts[0]);
  assert.equal(new Set(branchAttempts.map((a) => a.nodeID)).size, 2);
  assert.equal(overlapping.steps.find((s) => s.id === 'edit')!.attempts.length, 0);
  const liveTasks = (await Promise.all(clients.map((c) => c.bootstrap()))).flatMap((b) => b.tasks)
    .filter((t) => t.collaboration?.workflowID === automatic.id && ['video', 'audio'].includes(t.collaboration.stepID));
  assert.equal(liveTasks.length, 2); assert(liveTasks.every((t) => t.state === 'running' && t.sessionID));
  assert([...parallelRequests.values()].every((entry) => !entry.releasedAt));
  releaseParallel();
  const autoDone = await completed(automatic.id); assert.equal(autoDone.state, 'completed', JSON.stringify(autoDone));
  assert(autoDone.steps.every((s) => s.nodeID === null && s.attempts.length === 1));
  const intervals = [...parallelRequests.values()];
  assert(Math.max(...intervals.map((entry) => entry.enteredAt)) < Math.min(...intervals.map((entry) => entry.releasedAt!)));
  writeFileSync(join(root, 'automatic-parallel.json'), JSON.stringify({ workflowID: automatic.id, attempts: branchAttempts, intervals, simultaneousOfficialSessions: true }, null, 2));
  pass('Unassigned branches overlap in two official sessions despite a preferred Node and input retrieval, and their join waits for both');
  const simple = await create('CASE_SIMPLE'); const done = await completed(simple.id);
  assert.equal(done.state, 'completed', JSON.stringify(done)); assert.equal(done.steps.length, 1);
  assert(done.planner.attempts[0].executionID !== done.steps[0].attempts[0].executionID);
  const planner = (await origin.bootstrap()).tasks.find((t) => t.id === done.planner.attempts[0].executionID)!;
  assert(planner.sessionID && planner.collaborationOutcome?.value.kind === 'plan');
  pass('Every request runs a real read-only planner and a separate official execution with bound structured results');
  assert(systemBoundRequests >= 2);
  pass('The official engine sends coordination rules at system priority and keeps task content in user messages');
  const corrected = await completed((await create('CASE_FORMAT_CORRECTION')).id);
  assert.equal(corrected.state, 'completed'); assert.equal(corrected.planner.attempts.length, 2);
  assert.equal(corrected.planner.attempts[0].error, 'workflow_invalid_outcome');
  assert(corrected.planner.attempts.every((a) => a.nodeID === ownNode)); assert.equal(corrected.steps[0].attempts.length, 1);
  pass('An actual invalid model response gets one read-only correction and starts business execution once');
  const invalid = await completed((await create('CASE_INVALID')).id); assert.equal(invalid.state, 'failed'); assert.equal(invalid.steps.length, 0);
  assert.equal(invalid.planner.attempts.length, 3); assert.equal(invalid.planner.validationRounds, 2);
  const retried = await origin.call<Workflow>(`/workflows/${invalid.id}/control`, { action: 'retry_planning' });
  assert.equal(retried.id, invalid.id); assert.equal(retried.planner.attempts.length, 3);
  const stillInvalid = await completed(invalid.id); assert.equal(stillInvalid.planner.attempts.length, 6); assert.equal(stillInvalid.steps.length, 0);
  pass('An invalid cyclic plan stops after two corrections; explicit re-planning keeps its history and never starts business work');
  for (const target of [ownNode, otherNode]) {
    const failed = await completed((await create('CASE_RETRY_WORK', { mode: 'locked', nodeID: target })).id);
    assert.equal(failed.state, 'failed', JSON.stringify(failed));
    assert.deepEqual(failed.steps.map((s) => s.state), ['completed', 'failed', 'blocked']);
    const request = { version: failed.version, roundRequestID: failed.roundRequestID || failed.requestID,
      stepID: 'retry', attempt: 1, requestID: randomUUID() };
    await origin.call(`/workflows/${failed.id}/steps/retry`, request);
    await origin.call(`/workflows/${failed.id}/steps/retry`, request);
    const recovered = await completed(failed.id); assert.equal(recovered.state, 'completed', JSON.stringify(recovered));
    assert.deepEqual(recovered.steps.map((s) => s.attempts.length), [1, 2, 1]);
    assert.equal(recovered.steps[0].attempts[0].executionID, failed.steps[0].attempts[0].executionID);
    assert.equal(recovered.steps[1].attempts[0].error, 'workflow_invalid_outcome'); assert.equal(recovered.queuePaused, true);
  }
  pass('Local and remote failed steps retry once after a fresh official-session check; completed prerequisites and failure history survive');
  const queried = await completed((await create('CASE_QUERY')).id); assert.equal(queried.state, 'completed', JSON.stringify(queried));
  assert.equal(queried.planner.attempts.length, 2); assert.equal(queried.planner.queryRounds, 1);
  pass('The official planner can request a bounded catalog query and continue from its evidence');
  const handoff = await completed((await create('CASE_HANDOFF')).id); assert.equal(handoff.state, 'completed', JSON.stringify(handoff));
  assert.equal(handoff.handoffs.length, 1); assert.equal(handoff.steps[0].attempts.length, 2);
  assert.equal(handoff.steps[0].attempts[1].nodeID, otherNode); assert.equal(handoff.handoffs[0].phase, 'completed');
  pass('A quiescent execution transfers to the selected Node with a distinct attempt and saved business checkpoint');
  const material = await completed((await create('CASE_RESOURCE', { mode: 'locked', nodeID: ownNode })).id);
  assert.equal(material.state, 'completed', JSON.stringify(material)); assert(material.steps[0].attempts.every((a) => a.nodeID === ownNode));
  const attached = material.steps[0].attempts.at(-1)!.inputFiles[0]; assert(attached);
  assert.equal(readFileSync(join(folders[0].directory, '.rivloom-inputs', material.steps[0].attempts.at(-1)!.executionID, attached.id, attached.name), 'utf8'), 'Shared versioned material.\n');
  pass('A locked workflow retrieves authorized materials from another Node while keeping every execution on its locked Node');
  await worker.call('/network/execution-policy', { enabled: true, projectID: folders[1].id, model: 'fixture/m34', approvalMode: 'auto', confirmed: true });
  const remoteDelivery = await completed((await create('CASE_REMOTE_DELIVERY', { mode: 'locked', nodeID: otherNode })).id);
  assert.equal(remoteDelivery.state, 'completed', JSON.stringify(remoteDelivery));
  const remoteAttempt = remoteDelivery.steps[0].attempts[0]; assert.equal(remoteAttempt.resultDelivery, 'on-demand');
  const remotePath = `/task-files/remote/${remoteAttempt.executionID}`;
  const metadata = await origin.call(remotePath);
  assert.deepEqual(metadata.results.map((f: any) => f.state), ['remote', 'remote']);
  const sourceFiles = await worker.call(remotePath);
  assert(sourceFiles.results.every((f: any) => f.deliveries.length === 0), 'Completion must not enqueue result bytes');
  const metadataRequest = randomUUID();
  await origin.call(`/workflows/${remoteDelivery.id}/messages`, { requestID: metadataRequest,
    text: 'CASE_METADATA_ONLY: use the previous result description without opening any output files', attachmentIDs: [] }, 201);
  const metadataFollowup = await until(() => origin.call<Workflow>(`/workflows/${remoteDelivery.id}`),
    (w) => w.roundRequestID === metadataRequest && ['completed', 'failed'].includes(w.state), 'metadata-only continuation', 90_000);
  assert.equal(metadataFollowup.state, 'completed', JSON.stringify(metadataFollowup));
  for (const attempt of [...metadataFollowup.planner.attempts, ...metadataFollowup.steps.flatMap((s) => s.attempts)])
    assert(attempt.inputFiles.every((f) => f.name.startsWith('rivloom-conversation-')));
  assert.deepEqual((await origin.call(remotePath)).results.map((f: any) => f.state), ['remote', 'remote']);
  pass('A later round can use result records without downloading prior remote outputs for planning or execution');
  await origin.call(`${remotePath}/fetch`, { fileID: randomUUID() }, 409);
  await origin.call(`${remotePath}/fetch`, { fileID: remoteAttempt.outputFiles[0].id });
  await origin.call(`${remotePath}/fetch`, { fileID: remoteAttempt.outputFiles[0].id });
  const fetched = await until(() => origin.call(remotePath), (v) => v.results[0].state === 'complete', 'selected remote file retrieval');
  assert.equal(fetched.results[1].state, 'remote');
  assert.equal(fetched.results[0].sha256, remoteAttempt.outputFiles[0].sha256);
  const sourceAfter = await worker.call(remotePath); assert.equal(sourceAfter.results[1].deliveries.length, 0);
  pass('Remote completion exposes two authenticated files without transfer; fetching one leaves the other on its source Node');
  const returned = await completed((await create('CASE_RETURNED_FILE', { mode: 'locked', nodeID: otherNode })).id); assert.equal(returned.state, 'completed', JSON.stringify(returned));
  assert(returned.steps.every((s) => s.attempts.length === 1 && s.attempts[0].nodeID === otherNode));
  const originalFile = returned.steps[0].attempts[0].outputFiles[0], returnedFile = returned.steps[1].attempts[0].inputFiles[0];
  assert(originalFile && returnedFile); assert.notEqual(originalFile.id, returnedFile.id); assert.equal(originalFile.sha256, returnedFile.sha256);
  const receiver = (await worker.bootstrap()).tasks.find((t) => t.collaboration?.workflowID === returned.id && t.collaboration.stepID === 'consume')!;
  assert(receiver.messages.some((m) => m.tools.some((t) => t.name === 'read' && t.status === 'completed' && t.output.includes('Roundtrip checkpoint.'))));
  pass('A remote output returns through its coordinator to a second step on the same Node with verified new transfer identity');
  await worker.call('/network/execution-policy', { enabled: true, projectID: folders[1].id, model: 'fixture/m34', approvalMode: 'ask', confirmed: true });
  const output = await create('CASE_OUTPUT');
  const waiting = await until(() => origin.bootstrap(), (b) => b.tasks.some((t) => t.collaboration?.workflowID === output.id && t.state === 'waiting_approval'), 'ordinary tool approval');
  const approvalTask = waiting.tasks.find((t) => t.collaboration?.workflowID === output.id && t.state === 'waiting_approval')!;
  assert(!readFileSync(join(root, 'service-0.log'), 'utf8').includes('fixture error'));
  await origin.call(`/tasks/${approvalTask.id}/permissions/${approvalTask.approvals[0].id}`, { reply: 'once' });
  const outputDone = await completed(output.id); assert.equal(outputDone.state, 'completed', JSON.stringify(outputDone));
  const file = outputDone.steps[0].attempts[0].outputFiles[0]; assert(file);
  assert.equal(file.name, 'result.txt'); assert.equal(file.bytes, Buffer.byteLength('A verified business result from the official execution.\n'));
  pass('Normal tool approval gates an actual write, and the workflow publishes its hash-verified result file');
  const outputFollowup = { requestID: randomUUID(), text: 'CASE_FOLLOWUP: reuse the previous result file', attachmentIDs: [] };
  await origin.call(`/workflows/${output.id}/messages`, outputFollowup, 201);
  const outputContinued = await until(() => origin.call<Workflow>(`/workflows/${output.id}`), (w) => w.roundRequestID === outputFollowup.requestID && ['completed', 'failed'].includes(w.state), 'completed conversation follow-up', 90_000);
  assert.equal(outputContinued.state, 'completed', JSON.stringify(outputContinued));
  assert(outputContinued.inputFiles.some((f) => f.id === file.id));
  assert.equal(outputContinued.rounds![0].steps[0].attempts[0].outputFiles[0].sha256, file.sha256);
  const draft = JSON.stringify({ version: 1, savedAt: Date.now(), drafts: { new: {
    requestID: randomUUID(), text: 'Restart-persistent draft', routing: { kind: 'workflow', target: { mode: 'automatic' } },
  } } });
  await origin.call('/ui/drafts', { value: draft });
  pass('Completed conversations accept another round with the original verified result file');
  await origin.stop(); await origin.start({ discovery, logPath: join(root, 'origin-restarted.log') });
  assert.equal((await origin.bootstrap()).conversationDrafts, draft);
  const continuityRestored = await origin.call<Workflow>(`/workflows/${continuity.id}`);
  assert.equal(continuityRestored.roundRequestID, queuedRequest.requestID); assert.equal(continuityRestored.rounds!.length, 1);
  const restored = await origin.call<Workflow>(`/workflows/${handoff.id}`);
  assert.equal(restored.state, 'completed'); assert.equal(restored.steps[0].attempts.length, 2);
  const restoredFiles = await origin.call(remotePath);
  assert.deepEqual(restoredFiles.results.map((f: any) => f.state), ['complete', 'remote']);
  pass('Coordinator restart preserves completed graph and attempt identities without replay');
  const restart = await create('CASE_RESTART_HANDOFF');
  const pendingTarget = await until(() => worker.bootstrap(), (b) => b.tasks.some((t) => t.collaboration?.workflowID === restart.id && t.state === 'waiting_approval'), 'target handoff approval');
  const oldTarget = pendingTarget.tasks.find((t) => t.collaboration?.workflowID === restart.id)!;
  const beforeRestart = await origin.call<Workflow>(`/workflows/${restart.id}`);
  assert.equal(beforeRestart.steps[0].attempts.length, 2); assert.equal(beforeRestart.handoffs.length, 1);
  await worker.stop(); await worker.start({ discovery, logPath: join(root, 'worker-restarted.log') });
  const uncertain = await until(() => origin.call<Workflow>(`/workflows/${restart.id}`), (w) => w.steps[0].attempts.at(-1)?.phase === 'unknown', 'interrupted handoff target');
  assert.deepEqual(uncertain.steps[0].attempts.map((a) => a.executionID), beforeRestart.steps[0].attempts.map((a) => a.executionID));
  const targets = (await worker.bootstrap()).tasks.filter((t) => t.collaboration?.workflowID === restart.id);
  assert.equal(targets.length, 1); assert.equal(targets[0].id, oldTarget.id); assert.equal(targets[0].sessionID, oldTarget.sessionID);
  pass('Target restart retains the interrupted handoff attempt and official session without creating duplicate execution');
  await origin.call(`/workflows/${restart.id}/control`, { action: 'stop' });
  const stopped = await until(() => origin.call<Workflow>(`/workflows/${restart.id}`), (w) => w.state === 'stopped', 'confirmed interrupted target stop');
  assert.equal(stopped.steps[0].attempts.length, 2); assert.equal(stopped.handoffs.length, 1);
  const stoppedQueue = await until(() => worker.call('/node-queue'), (q) => q.entries.some((e: any) => e.localTaskID === oldTarget.id && e.state === 'ended'), 'stopped workflow queue cleanup');
  assert.equal(stoppedQueue.entries.find((e: any) => e.localTaskID === oldTarget.id).endReason.code, 'stopped');
  assert.equal((await worker.bootstrap()).tasks.find((t) => t.id === oldTarget.id)?.sessionID, oldTarget.sessionID);
  pass('The original workflow can confirm stopping its interrupted target without replaying business work');
  status = 'passed';
} catch (error) { failure = error instanceof Error ? error.stack || error.message : String(error); console.error(failure); process.exitCode = 1; }
finally {
  releaseParallel();
  releaseContinuation();
  await Promise.allSettled(clients.map((client) => client.stop())); await fixture.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify({ status, assertions, failure, root, paidRequests: false }, null, 2));
  console.log(`Workflow service result: ${status}; ${root}`);
}
