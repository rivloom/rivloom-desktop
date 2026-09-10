// Real isolated Rivloom services and official OpenCode; only a deterministic loopback model.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSocket } from 'node:dgram';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { defaultRemoteConcurrency } from '../shared/execution-concurrency.ts';
import {
  taskFileChunkBytes,
  type TaskFileDescriptor,
  type TaskFileConversation,
} from '../shared/task-files.ts';

const root = resolve('.data', 'collaboration-files', String(Date.now()));
mkdirSync(root, { recursive: true });
const fixture = await modelFixture();
fixture.release();
const clients = ['submitter', 'master', 'worker'].map(
  (name) => new ServiceClient(join(root, name)),
);
const [submitter, master, worker] = clients;
const socket = createSocket('udp4');
await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const port = socket.address().port;
await new Promise<void>((ok) => socket.close(ok));
const discovery = { port, mdns: false };
const proof: { root: string; status: string; assertions: string[]; error?: string } = {
  root,
  status: 'running',
  assertions: [],
};
const pass = (message: string) => {
  proof.assertions.push(message);
  console.log('PASS', message);
};
const descriptor = (name: string, bytes: Buffer): TaskFileDescriptor => ({
  id: randomUUID(),
  name,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mime: 'application/octet-stream',
});
async function upload(client: ServiceClient, name: string, bytes: Buffer) {
  const file = descriptor(name, bytes);
  await client.call('/task-files/uploads', file, 201);
  for (let offset = 0; offset < bytes.length; offset += taskFileChunkBytes)
    await client.call(`/task-files/uploads/${file.id}/chunk`, {
      offset,
      data: bytes.subarray(offset, offset + taskFileChunkBytes).toString('base64'),
    });
  return file;
}
const taskFiles = (client: ServiceClient, scope: string, id: string) =>
  client.call<TaskFileConversation>(`/task-files/${scope}/${id}`);
async function completed(client: ServiceClient, id: string) {
  await until(
    () => client.call(`/tasks/${id}`),
    (value) => value.task.state === 'accepted',
    'automatic completion',
  );
}
async function contents(client: ServiceClient, scope: string, id: string, fileID: string) {
  const response = await fetch(`${client.base}/api/task-files/${scope}/${id}/${fileID}/content`, {
    headers: { Cookie: client.cookie, 'X-Rivloom-Request': '1' },
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
try {
  for (const client of clients) {
    fixture.configure(client.root);
    loadNodeIdentity(client.root);
    // Deterministic tie-break makes the remote Master win once all three peers are paired.
    const path = join(client.root, 'node-identity.json'),
      identity = JSON.parse(readFileSync(path, 'utf8'));
    identity.brainID =
      (client === master ? '0' : client === submitter ? '8' : 'f') + randomUUID().slice(1);
    writeFileSync(path, JSON.stringify(identity));
  }
  await Promise.all(
    clients.map((client) =>
      client.start({ discovery, logPath: join(root, `${clients.indexOf(client)}.log`) }),
    ),
  );
  const folders = [];
  for (const client of [submitter, worker]) {
    const directory = join(client.root, 'selected-project');
    mkdirSync(directory);
    folders.push(
      await client.call(
        '/projects',
        { name: 'Attachment fixture project', directory, trusted: true },
        201,
      ),
    );
  }
  const actor = (await submitter.bootstrap()).user;
  const inputBytes = Buffer.from('Only the explicitly selected task input is materialized.\n');
  const localFile = await upload(submitter, 'brief.txt', inputBytes);
  const incomplete = descriptor('partial.txt', Buffer.from('incomplete'));
  await submitter.call('/task-files/uploads', incomplete, 201);
  const localBody = {
    requestID: randomUUID(),
    title: 'Local attached task',
    description: 'Use the explicitly attached brief.',
    criteria: 'Verify attachment handoff',
    projectID: folders[0].id,
    assigneeID: actor.id,
    approverID: actor.id,
    reviewerID: actor.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    runRequested: true,
  };
  await submitter.call('/tasks', { ...localBody, attachmentIDs: [incomplete.id] }, 409);
  assert.equal((await submitter.bootstrap()).tasks.length, 0);
  const local = await submitter.call(
    '/tasks',
    { ...localBody, attachmentIDs: [localFile.id] },
    201,
  );
  assert.equal(
    (await submitter.call('/tasks', { ...localBody, attachmentIDs: [localFile.id] }, 201)).id,
    local.id,
  );
  const reviewed = await until(
    () => submitter.bootstrap(),
    (b) => b.tasks.find((t) => t.id === local.id)?.state === 'accepted',
    'local attachment run',
  );
  assert.equal(reviewed.tasks.length, 1);
  assert(reviewed.tasks[0].sessionID);
  const relative = join('.rivloom-inputs', local.id, localFile.id, localFile.name);
  assert.deepEqual(readFileSync(join(folders[0].directory, relative)), inputBytes);
  assert(
    reviewed.tasks[0].messages.some((m) => m.role === 'user' && m.text.includes(localFile.id)),
    'official session prompt contains the materialized input path',
  );
  const localResult = await upload(submitter, 'local-output.txt', Buffer.from('local result'));
  await submitter.call(`/task-files/local/${local.id}/results`, {
    attachmentIDs: [localResult.id],
  });
  const savePath = join(root, 'saved-result.txt');
  await submitter.call(`/task-files/local/${local.id}/${localResult.id}/export`, {
    destination: savePath,
  });
  await submitter.call(
    `/task-files/local/${local.id}/${localResult.id}/export`,
    { destination: savePath },
    409,
  );
  assert.equal(readFileSync(savePath, 'utf8'), 'local result');
  assert.equal((await submitter.call(`/task-files/local/${local.id}/${localResult.id}/location`, {})).path, savePath);
  assert.equal((await submitter.call(`/task-files/local/${local.id}/${localFile.id}/location`, {})).path, join(folders[0].directory, relative));
  await completed(submitter, local.id);
  pass(
    'Local attachments gate creation, enter one official session, and selected results save without overwrite',
  );

  const invitation = await submitter.call('/invitations', {});
  const member = new ServiceClient(submitter.root);
  member.base = submitter.base;
  await member.call('/auth/join', {
    username: 'file_observer',
    name: 'Observer',
    password: 'Isolated-fixture-password-2026',
    code: invitation.code,
  });
  await member.call(`/task-files/local/${local.id}`, undefined, 403);
  await member.call(`/task-files/local/${local.id}/${localResult.id}/location`, {}, 403);
  await submitter.call(`/task-files/local/${local.id}/${incomplete.id}/location`, {}, 403);
  await submitter.call(`/task-files/local/${local.id}/${localResult.id}/location`, { path: savePath }, 400);
  await member.call(
    `/task-files/uploads/${localFile.id}/chunk`,
    { offset: 0, data: inputBytes.toString('base64') },
    403,
  );
  await member.call('/network/diagnostics/retry', {}, 403);
  await submitter.call(
    `/task-files/local/${local.id}/${incomplete.id}/export`,
    { destination: join(root, 'forbidden.txt') },
    403,
  );
  const unauth = new ServiceClient(submitter.root);
  unauth.base = submitter.base;
  await unauth.call('/task-files/uploads', descriptor('unauth.txt', Buffer.alloc(0)), 401);
  await unauth.call(`/task-files/local/${local.id}/${localResult.id}/location`, {}, 401);
  await submitter.call('/network/diagnostics/retry', { nodeID: 'Z'.repeat(32) }, 404);
  assert(!existsSync(join(root, 'forbidden.txt')));
  pass(
    'HTTP file ownership, task participation, unrelated file export, authentication and diagnostic operator checks reject unauthorized requests',
  );

  await worker.call('/network/execution-policy', {
    enabled: true,
    projectID: folders[1].id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  });
  await pairServices(submitter, master);
  await pairServices(master, worker);
  const workerID = (await worker.network()).local!.id;
  await until(
    () => master.network(),
    (n) => n.nearby.some((p) => p.id === workerID && p.worker?.accepting),
    'worker available',
  );
  const largeBytes = Buffer.alloc(3 * 1024 * 1024, 71),
    large = await upload(master, 'large-input.txt', largeBytes);
  const directBody = {
    requestID: randomUUID(),
    title: 'Direct resumable input',
    description: 'Use selected attachment',
    criteria: 'File must arrive before execution',
    requirements: {},
    confirmed: true,
    attachmentIDs: [large.id],
  };
  const direct = await master.call(`/network/nodes/${workerID}/tasks`, directBody, 201);
  const received = await until(
    () => taskFiles(worker, 'remote', direct.createdTaskID),
    (v) => v.inputs.some((f) => f.receivedBytes > 0 && f.state === 'receiving'),
    'partial encrypted file',
  );
  assert(received.inputs[0].receivedBytes < large.bytes);
  assert.equal(
    (await worker.bootstrap()).tasks.length,
    0,
    'no Task/session admission while bytes incomplete',
  );
  await worker.stop();
  const storedFiles = new DatabaseSync(join(worker.root, 'task-files', 'files.sqlite'), {
    readOnly: true,
  });
  const savedPartial = JSON.parse(
    String(storedFiles.prepare('SELECT body FROM files WHERE id=?').get(large.id)!.body),
  );
  storedFiles.close();
  assert(savedPartial.receivedBytes > 0 && savedPartial.receivedBytes < large.bytes);
  await worker.start({ discovery, logPath: join(root, 'worker-restarted.log') });
  await until(
    () => worker.bootstrap(),
    (b) =>
      b.tasks.some(
        (t) => t.remoteOrigin?.remoteTaskID === direct.createdTaskID && t.state === 'accepted',
      ),
    'resumed original direct task',
    90000,
  );
  const directLocal = (await worker.bootstrap()).tasks.find(
    (t) => t.remoteOrigin?.remoteTaskID === direct.createdTaskID,
  )!;
  assert.equal(
    (await master.call(`/network/nodes/${workerID}/tasks`, directBody, 201)).createdTaskID,
    direct.createdTaskID,
  );
  assert.deepEqual(await contents(worker, 'remote', direct.createdTaskID, large.id), largeBytes);
  assert.equal((await worker.bootstrap()).tasks.length, 1);
  pass(
    'Direct encrypted transfer survives receiver restart from durable partial bytes and starts one original Task/session only after full verification',
  );
  const resultBytes = Buffer.from('Explicit result from executing Worker'),
    result = await upload(worker, 'worker-result.txt', resultBytes);
  await worker.call(`/task-files/remote/${direct.createdTaskID}/results`, {
    attachmentIDs: [result.id],
  });
  await until(
    () => taskFiles(master, 'remote', direct.createdTaskID),
    (v) => v.results.some((f) => f.id === result.id && f.state === 'complete'),
    'direct result',
  );
  assert.deepEqual(await contents(master, 'remote', direct.createdTaskID, result.id), resultBytes);
  const directSummary = (
    await until(
      () => master.network(),
      (n) =>
        n.remoteTasks.some((t) => t.id === direct.createdTaskID && t.executionState === 'accepted'),
      'direct result summary',
    )
  ).remoteTasks.find((t) => t.id === direct.createdTaskID)!.executionSummary;
  assert(directSummary.trim());
  await completed(worker, directLocal.id);
  const directAccepted = await until(
    () => master.network(),
    (n) =>
      n.remoteTasks.some((t) => t.id === direct.createdTaskID && t.executionState === 'accepted'),
    'direct completed summary',
  );
  assert.equal(
    directAccepted.remoteTasks.find((t) => t.id === direct.createdTaskID)!.executionSummary,
    directSummary,
  );
  pass(
    'Explicit Worker result returns byte for byte and the original model response survives automatic completion',
  );

  await pairServices(submitter, worker);
  await until(
    () => submitter.network(),
    (n) =>
      n.brains.some(
        (b) =>
          !b.hosted && b.workers.some((w) => w.nodeID === workerID && w.load.availableSlots === defaultRemoteConcurrency),
      ),
    'remote Master advertises free Worker',
    90000,
  );
  const brainInput = await upload(
    submitter,
    'brain-input.txt',
    Buffer.from('submitter -> Master -> Worker'),
  );
  const brainBody = {
    requestID: randomUUID(),
    title: 'Brain attached task',
    description: 'Process selected input through Brain',
    criteria: 'Return selected result through original Master',
    requestedProjectID: null,
    requirements: {},
    confirmed: true,
    attachmentIDs: [brainInput.id],
  };
  const brain = await submitter.call('/network/tasks', brainBody, 201);
  assert.equal(
    brain.brainTasks.find((t: any) => t.id === brain.createdTaskID).masterNodeID,
    (await master.network()).local!.id,
  );
  const brainState = await until(
    () => worker.bootstrap(),
    (b) =>
      b.network.remoteTasks.some(
        (t) => t.brainTaskID === brain.createdTaskID && t.executionState === 'accepted',
      ),
    'Brain file execution',
    90000,
  );
  const execution = brainState.network.remoteTasks.find(
    (t) => t.brainTaskID === brain.createdTaskID,
  )!;
  assert(execution.localTaskID);
  assert.equal(
    (await submitter.call('/network/tasks', brainBody, 201)).createdTaskID,
    brain.createdTaskID,
  );
  assert.deepEqual(
    await contents(worker, 'remote', execution.id, brainInput.id),
    Buffer.from('submitter -> Master -> Worker'),
  );
  const brainResult = await upload(
    worker,
    'brain-result.txt',
    Buffer.from('Worker -> Master -> submitter'),
  );
  await worker.call(`/task-files/remote/${execution.id}/results`, {
    attachmentIDs: [brainResult.id],
  });
  await until(
    () => taskFiles(submitter, 'brain', brain.createdTaskID),
    (v) => v.results.some((f) => f.id === brainResult.id && f.state === 'complete'),
    'Brain result relay',
    90000,
  );
  assert.deepEqual(
    await contents(submitter, 'brain', brain.createdTaskID, brainResult.id),
    Buffer.from('Worker -> Master -> submitter'),
  );
  assert.equal(
    (await master.network()).brainTasks.filter((t) => t.id === brain.createdTaskID)[0].executions
      .length,
    1,
  );
  const brainSummary = (
    await until(
      () => submitter.network(),
      (n) => n.brainTasks.some((t) => t.id === brain.createdTaskID && t.status === 'completed'),
      'Brain result summary',
    )
  ).brainTasks.find((t) => t.id === brain.createdTaskID)!.executionSummary;
  assert(brainSummary.trim());
  await completed(worker, execution.localTaskID!);
  const brainAccepted = await until(
    () => submitter.network(),
    (n) => n.brainTasks.some((t) => t.id === brain.createdTaskID && t.status === 'completed'),
    'Brain completed summary',
  );
  assert.equal(
    brainAccepted.brainTasks.find((t) => t.id === brain.createdTaskID)!.executionSummary,
    brainSummary,
  );
  pass(
    'Three services route Brain input and result through its original Master with one Execution and one official session',
  );

  const workerTasks = (await worker.bootstrap()).tasks;
  assert.equal(new Set(workerTasks.map((t) => t.sessionID)).size, workerTasks.length);
  const official = new DatabaseSync(
    join(worker.root, 'engine', 'data', 'opencode', 'opencode.db'),
    { readOnly: true },
  );
  assert.deepEqual(
    official
      .prepare('SELECT id FROM session')
      .all()
      .map((r) => r.id)
      .sort(),
    workerTasks.map((t) => t.sessionID).sort(),
  );
  official.close();
  const attention = await submitter.call('/attention/check', {});
  await submitter.call('/attention/preferences', { enabled: false, quietUntil: null });
  assert.equal((await submitter.call('/attention/check', {})).preferences.enabled, false);
  assert(Array.isArray(attention.items));
  const masterID = (await master.network()).local!.id;
  await worker.call(`/network/trusted/${masterID}/revoke`, { confirmed: true });
  const revoked = await upload(worker, 'after-revoke.txt', Buffer.from('must stay local'));
  await worker.call(
    `/task-files/remote/${execution.id}/results`,
    { attachmentIDs: [revoked.id] },
    403,
  );
  pass(
    'Revocation blocks further result publication; attention preferences persist independently of task execution',
  );
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.error = String(error);
  process.exitCode = 1;
  console.error(error);
  for (const client of clients) console.error(client.root, client.output);
} finally {
  fixture.release();
  await Promise.all(clients.map((c) => c.stop()));
  await fixture.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify(proof, null, 2));
  console.log('Evidence', join(root, 'report.json'));
}
