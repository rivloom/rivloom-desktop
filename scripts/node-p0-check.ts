// M3.5 isolated full-service verification. Real Rivloom/OpenCode, loopback model only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';
import type { NodeNetwork, Task } from '../shared/types.ts';
import type { NodeQueueAction, NodeQueueSnapshot } from '../shared/node-queue.ts';

const root = resolve('.data', 'verification', `m35-p0-${Date.now()}-${randomUUID().slice(0, 8)}`);
mkdirSync(root, { recursive: true });
const proof: {
  root: string;
  at: string;
  kind: string;
  status: string;
  checks: { name: string; evidence: unknown; at: string }[];
  error?: string;
} = {
  root,
  at: new Date().toISOString(),
  kind: 'M3.5 P0; isolated services / official OpenCode / deterministic loopback model',
  status: 'running',
  checks: [],
};
const save = () => writeFileSync(join(root, 'verification.json'), JSON.stringify(proof, null, 2));
const pass = (name: string, evidence: unknown = {}) => {
  proof.checks.push({ name, evidence, at: new Date().toISOString() });
  save();
  console.log('PASS', name);
};
save();
console.log('M3.5 evidence', root);

const socket = createSocket('udp4');
await new Promise<void>((ok, reject) => {
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', ok);
});
const discovery = { port: socket.address().port, mdns: false };
await new Promise<void>((ok) => socket.close(ok));
const model = await modelFixture();
const clients = ['sender', 'receiver', 'other'].map((name) => new ServiceClient(join(root, name)));
const [sender, receiver, other] = clients;
const start = (client: ServiceClient) =>
  client.start({ discovery, logPath: join(client.root, 'service.log') });

function officialSessions(client: ServiceClient) {
  const db = new DatabaseSync(join(client.root, 'engine', 'data', 'opencode', 'opencode.db'), {
    readOnly: true,
  });
  try {
    return db
      .prepare('SELECT id FROM session ORDER BY id')
      .all()
      .map((row) => String(row.id));
  } finally {
    db.close();
  }
}

async function waitChannel(left: ServiceClient, right: ServiceClient) {
  const id = (await right.network()).local!.id;
  await until(
    () => left.network(),
    (network) =>
      !!network.nearby.find(
        (peer) => peer.id === id && peer.online && peer.trusted && peer.channelReady,
      ),
    'authenticated channel restored',
  );
}

async function ordinaryMember(owner: ServiceClient, username: string) {
  const invitation = await owner.call<{ code: string }>('/invitations', {});
  const member = new ServiceClient(owner.root);
  member.base = owner.base;
  const joined = await member.call('/auth/join', {
    code: invitation.code,
    username,
    name: 'M3.5 ordinary member',
    password: `fixture-${randomUUID()}`,
  });
  assert.equal(joined.owner, false);
  return member;
}

async function assertNoPrivateNetwork(member: ServiceClient) {
  await member.call('/node-queue', undefined, 403);
  for (const network of [await member.network(), (await member.bootstrap()).network]) {
    assert.deepEqual(network.remoteTasks, []);
    assert.deepEqual(network.brainTasks, []);
    assert(network.local?.nodeQueue);
    assert.equal(typeof network.local.nodeQueue.waitingCount, 'number');
  }
  assert.equal((await member.bootstrap()).tasks.length, 0);
}

async function assertSingleExecution(
  remoteID: string,
  expectedTaskID: string,
  expectedSessionID: string,
) {
  const [sent, received, state] = await Promise.all([
    sender.network(),
    receiver.network(),
    receiver.bootstrap(),
  ]);
  assert.equal(sent.remoteTasks.filter((task) => task.id === remoteID).length, 1);
  const incoming = received.remoteTasks.filter((task) => task.id === remoteID);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].localTaskID, expectedTaskID);
  const local = state.tasks.filter((task) => task.remoteOrigin?.remoteTaskID === remoteID);
  assert.equal(local.length, 1);
  assert.equal(local[0].id, expectedTaskID);
  assert.equal(local[0].sessionID, expectedSessionID);
  assert.deepEqual(officialSessions(receiver), [expectedSessionID]);
  assert.equal((await sender.bootstrap()).tasks.length, 0);
  assert.equal((await other.bootstrap()).tasks.length, 0);
}

try {
  for (const client of clients) {
    mkdirSync(client.root, { recursive: true });
    model.configure(client.root);
    loadNodeIdentity(client.root);
  }
  await Promise.all(clients.map(start));
  await pairServices(sender, receiver);
  await pairServices(sender, other);
  const receiverID = (await receiver.network()).local!.id;
  const otherID = (await other.network()).local!.id;
  const projectDirectory = join(receiver.root, 'authorized-folder');
  mkdirSync(projectDirectory);
  const project = await receiver.call(
    '/projects',
    {
      name: 'M3.5 isolated folder',
      directory: projectDirectory,
      trusted: true,
    },
    201,
  );
  const policy = {
    projectID: project.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  };
  await receiver.call('/network/execution-policy', { ...policy, enabled: false });
  const request = {
    requestID: randomUUID(),
    title: 'M3.5 response-loss identity',
    description: 'Reply with one short line. Do not call tools or change files.',
    criteria: 'One Task and one session even after HTTP retry and service restart.',
    requirements: {},
    confirmed: true,
  };
  const path = `/network/nodes/${receiverID}/tasks`;
  // Intentionally lose the response body after the server accepted the HTTP request.
  // The client retains only its request ID, then retries the same logical creation.
  const dropped = await fetch(`${sender.base}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rivloom-Request': '1',
      Cookie: sender.cookie,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(dropped.status, 201);
  await dropped.body?.cancel();
  const retried = await Promise.all(
    Array.from({ length: 4 }, () =>
      sender.call<NodeNetwork & { createdTaskID: string }>(path, request, 201),
    ),
  );
  const remoteID = retried[0].createdTaskID;
  assert(remoteID);
  assert(retried.every((response) => response.createdTaskID === remoteID));
  await until(
    () => receiver.network(),
    (network) =>
      network.remoteTasks.some((task) => task.id === remoteID && task.status === 'accepted'),
    'trusted offer auto-received while execution is paused',
  );
  assert.equal((await sender.network()).remoteTasks.length, 1);
  assert.equal((await receiver.network()).remoteTasks.length, 1);
  assert.equal((await receiver.bootstrap()).tasks.length, 0);
  await sender.call(path, { ...request, title: 'Changed content' }, 409);
  await sender.call(`/network/nodes/${otherID}/tasks`, request, 409);
  assert.equal((await other.network()).remoteTasks.length, 0);
  pass(
    'Lost creation response and four concurrent retries keep one invitation; conflicting content/target return 409',
    { requestID: request.requestID, remoteID, receivingPolicy: 'paused', localTaskCount: 0 },
  );

  await sender.stop();
  await start(sender);
  const afterSenderRestart = await sender.call(path, request, 201);
  assert.equal(afterSenderRestart.createdTaskID, remoteID);
  await receiver.stop();
  await start(receiver);
  await waitChannel(sender, receiver);
  await waitChannel(receiver, sender);
  const afterReceiverRestart = await sender.call(path, request, 201);
  assert.equal(afterReceiverRestart.createdTaskID, remoteID);
  assert.equal((await receiver.network()).remoteTasks.length, 1);
  assert.equal((await receiver.bootstrap()).tasks.length, 0);
  pass(
    'Sender and receiver restart before execution preserve accepted invitation and original creation ID',
    { remoteID },
  );

  await receiver.call('/network/execution-policy', { ...policy, enabled: true });
  const running = await until(
    () => receiver.bootstrap(),
    (state) =>
      state.tasks.some(
        (task) =>
          task.remoteOrigin?.remoteTaskID === remoteID &&
          task.state === 'running' &&
          !!task.sessionID,
      ),
    'one official OpenCode session starts',
  );
  const task = running.tasks.find((item) => item.remoteOrigin?.remoteTaskID === remoteID)!;
  await until(
    async () => model.requests,
    (requests) => requests > 0,
    'official engine reaches loopback model',
  );
  assert.equal((await sender.call(path, request, 201)).createdTaskID, remoteID);
  await assertSingleExecution(remoteID, task.id, task.sessionID!);
  pass(
    'Original incoming invitation creates exactly one business Task and official OpenCode session',
    { remoteID, taskID: task.id, sessionID: task.sessionID },
  );

  model.releaseNext();
  await until(
    () => receiver.bootstrap(),
    (state) => state.tasks.find((item) => item.id === task.id)?.state === 'review',
    'deterministic result reaches review',
  );
  await until(
    () => sender.network(),
    (network) =>
      network.remoteTasks.find((item) => item.id === remoteID)?.executionState === 'review',
    'sender receives review state',
  );
  await receiver.stop();
  await start(receiver);
  await waitChannel(sender, receiver);
  await waitChannel(receiver, sender);
  await sender.call(path, request, 201);
  await wait(5500); // Cross the real processor tick; no second task/session may appear.
  await assertSingleExecution(remoteID, task.id, task.sessionID!);
  const reviewed = (await receiver.bootstrap()).tasks.find((item) => item.id === task.id)!;
  assert.equal(reviewed.state, 'review');
  assert.equal((await receiver.network()).local!.worker!.load.availableSlots, 0);
  pass('Restart and late retry retain one reviewed session; review still occupies the Node slot', {
    remoteID,
    taskID: task.id,
    sessionID: task.sessionID,
  });

  // A fresh offline or revoked destination must fail without creating local work or changing target.
  await other.stop();
  await until(
    () => sender.network(),
    (network) => !network.nearby.find((peer) => peer.id === otherID)?.online,
    'other Node offline',
  );
  const offlineRequest = {
    ...request,
    requestID: randomUUID(),
    title: 'Offline fixed destination',
  };
  await sender.call(`/network/nodes/${otherID}/tasks`, offlineRequest, 409);
  assert.equal((await sender.network()).remoteTasks.length, 1);
  assert.equal((await sender.bootstrap()).tasks.length, 0);
  await start(other);
  await waitChannel(sender, other);
  await sender.call(`/network/trusted/${otherID}/revoke`, { confirmed: true });
  await sender.call(
    `/network/nodes/${otherID}/tasks`,
    { ...offlineRequest, requestID: randomUUID() },
    409,
  );
  assert.equal((await sender.network()).remoteTasks.length, 1);
  assert.equal((await other.network()).remoteTasks.length, 0);
  assert.equal((await sender.bootstrap()).tasks.length, 0);
  await assertSingleExecution(remoteID, task.id, task.sessionID!);
  pass('Offline and revoked fixed destinations produce 409 with no local or third-Node fallback');

  if (!process.argv.includes('--phase=a')) {
    await pairServices(other, receiver);
    const queue = () => receiver.call<NodeQueueSnapshot>('/node-queue');
    const remoteRow = (snapshot: NodeQueueSnapshot, id: string) =>
      snapshot.entries.find(
        (entry) => entry.source.kind === 'remote' && entry.source.remoteTaskID === id,
      );
    const receipt = (owner: ServiceClient, id: string, state: string, position?: number | null) =>
      until(
        () => owner.network(),
        (network) => {
          const value = network.remoteTasks.find((item) => item.id === id)?.queueReceipt;
          return value?.state === state && (position === undefined || value.position === position);
        },
        `sender receipt ${state} / ${id}`,
      );
    const control = async (itemID: string, action: NodeQueueAction, reason?: string) => {
      const snapshot = await queue();
      const entry = snapshot.entries.find((candidate) => candidate.id === itemID)!;
      assert(entry);
      const body = {
        operationID: randomUUID(),
        expectedVersion: entry.version,
        expectedQueueVersion: snapshot.version,
        action,
        ...(reason ? { reason } : {}),
      };
      const result = await receiver.call(`/node-queue/${itemID}/control`, body);
      return { body, result };
    };
    const pause = async (paused: boolean) =>
      receiver.call('/node-queue/pause', {
        operationID: randomUUID(),
        expectedVersion: (await queue()).version,
        paused,
      });
    const send = async (owner: ServiceClient, title: string) => {
      const result = await owner.call<NodeNetwork & { createdTaskID: string }>(
        path,
        { ...request, requestID: randomUUID(), title },
        201,
      );
      await until(
        queue,
        (snapshot) => !!remoteRow(snapshot, result.createdTaskID),
        'incoming queue intent',
      );
      return result.createdTaskID;
    };
    const acceptRemote = async (owner: ServiceClient, id: string) => {
      const network = await until(
        () => owner.network(),
        (network) =>
          network.remoteTasks.find((item) => item.id === id)?.executionState === 'review',
        'remote review available',
      );
      const invite = network.remoteTasks.find((item) => item.id === id)!;
      await owner.call(`/network/tasks/${id}/control`, {
        confirmed: true,
        expectedExecutionSequence: invite.executionSequence,
        action: { kind: 'accept', note: 'Verified the isolated deterministic result.' },
      });
      await until(
        () => receiver.bootstrap(),
        (state) =>
          state.tasks.find((item) => item.remoteOrigin?.remoteTaskID === id)?.state === 'accepted',
        'originating Node accepts its own result',
      );
    };
    const run = async (id: string, remote: boolean) => {
      const state = await until(
        () => receiver.bootstrap(),
        (state) =>
          state.tasks.some(
            (item) =>
              (remote ? item.remoteOrigin?.remoteTaskID === id : item.id === id) &&
              item.state === 'running',
          ),
        `next real execution ${id}`,
      );
      const current = state.tasks.find((item) =>
        remote ? item.remoteOrigin?.remoteTaskID === id : item.id === id,
      )!;
      assert(current.sessionID);
      assert.equal(
        state.tasks.filter((item) =>
          ['running', 'waiting_approval', 'waiting_input', 'review', 'interrupted'].includes(
            item.state,
          ),
        ).length,
        1,
      );
      await until(
        async () => model.pendingRequests,
        (count) => count > 0,
        'current official session reaches model',
      );
      return current;
    };
    const finish = async (id: string) => {
      model.releaseNext(Math.max(1, model.pendingRequests));
      await until(
        () => receiver.bootstrap(),
        (state) => state.tasks.find((item) => item.id === id)?.state === 'review',
        'current execution reaches review',
      );
    };

    // Keep the first verified session in review, creating real ordinary busy capacity.
    const a1 = await send(sender, 'M3.5 queue sender A1');
    const operator = (await receiver.bootstrap()).user.id;
    const local = await receiver.call<Task>(
      '/tasks',
      {
        requestID: randomUUID(),
        runRequested: true,
        projectID: project.id,
        title: 'M3.5 queue local L',
        description: request.description,
        criteria: request.criteria,
        assigneeID: operator,
        approverID: operator,
        reviewerID: operator,
        model: 'fixture/m34',
        approvalMode: 'ask',
      },
      201,
    );
    const c1 = await send(other, 'M3.5 queue sender C1');
    const a2 = await send(sender, 'M3.5 queue rejected A2');
    const queued = await until(
      queue,
      (snapshot) => snapshot.entries.filter((item) => item.state === 'waiting').length === 4,
      'mixed local and remote FIFO',
    );
    const waiting = queued.entries.filter((item) => item.state === 'waiting');
    assert.deepEqual(
      waiting.map((item) =>
        item.source.kind === 'local' ? item.source.taskID : item.source.remoteTaskID,
      ),
      [a1, local.id, c1, a2],
    );
    assert(waiting.every((entry, index) => entry.position === index + 1));
    assert.equal((await receiver.bootstrap()).tasks.length, 2); // Existing review + unstarted local Task.
    assert.deepEqual(officialSessions(receiver), [task.sessionID]);
    await receipt(sender, a1, 'queued', 1);
    await receipt(other, c1, 'queued', 3);
    await receipt(sender, a2, 'queued', 4);
    const senderQueueSequence = (await sender.network()).remoteTasks.find((item) => item.id === a1)!
      .queueReceipt!.queueSequence;
    const a1Entry = remoteRow(queued, a1)!;
    const c1Entry = remoteRow(queued, c1)!;
    const a2Entry = remoteRow(queued, a2)!;
    pass('Ordinary busy Node accepts mixed-source FIFO without precreating remote business Tasks', {
      receivedOrder: waiting.map((entry) => ({
        source: entry.source,
        sequence: entry.receivedSequence,
        position: entry.position,
      })),
    });

    await control(c1Entry.id, 'up');
    await control(c1Entry.id, 'up');
    const held = await control(a1Entry.id, 'hold');
    const replay = await receiver.call(`/node-queue/${a1Entry.id}/control`, held.body);
    assert.deepEqual(replay, held.result);
    await receiver.call(
      `/node-queue/${a1Entry.id}/control`,
      { ...held.body, operationID: randomUUID(), action: 'resume' },
      409,
    );
    const rejected = await control(
      a2Entry.id,
      'reject',
      `Receiver deliberately rejected ${projectDirectory.toUpperCase().replaceAll('\\', '/')}.`,
    );
    const rejectedReplay = await receiver.call(`/node-queue/${a2Entry.id}/control`, rejected.body);
    assert.deepEqual(rejectedReplay, rejected.result);
    await receipt(sender, a1, 'held', null);
    await receipt(sender, a2, 'rejected', null);
    await receipt(other, c1, 'queued', 1);
    const receiptAfterControl = (await sender.network()).remoteTasks.find(
      (item) => item.id === a1,
    )!;
    assert(receiptAfterControl.queueReceipt!.queueSequence > senderQueueSequence);
    assert.equal(receiptAfterControl.executionSequence, 0);
    assert.equal(receiptAfterControl.status, 'accepted');
    assert(!(await other.network()).remoteTasks.some((item) => [a1, a2].includes(item.id)));
    const rejectedReason = (await sender.network()).remoteTasks.find((item) => item.id === a2)!
      .queueReceipt!.reason!;
    assert(rejectedReason.includes('<project>'));
    assert(!rejectedReason.toLowerCase().includes('authorized-folder'));
    const receiverMember = await ordinaryMember(receiver, 'queue_member');
    await assertNoPrivateNetwork(receiverMember);
    assert(remoteRow(await queue(), a2));
    assert((await receiver.network()).remoteTasks.some((item) => item.id === a2));
    pass(
      'Ordinary members cannot read another owner’s queued details; public queue statistics remain visible',
      {
        paths: ['/node-queue', '/network', '/bootstrap'],
        queueReadStatus: 403,
        ownerRetainsRejectedRow: a2,
        redactedReason: rejectedReason,
      },
    );
    await pause(true);
    const beforeRestart = await queue();
    await receiver.stop();
    await start(receiver);
    await waitChannel(sender, receiver);
    await waitChannel(other, receiver);
    const afterRestart = await queue();
    assert.equal(afterRestart.paused, true);
    assert.deepEqual(
      afterRestart.entries.map((entry) => [entry.id, entry.order, entry.state, entry.localTaskID]),
      beforeRestart.entries.map((entry) => [entry.id, entry.order, entry.state, entry.localTaskID]),
    );
    await acceptRemote(sender, remoteID);
    await wait(5500);
    assert.deepEqual(officialSessions(receiver), [task.sessionID]);
    pass(
      'Reorder, hold, rejection and queue pause survive receiver restart; operation replay is idempotent and stale writes fail',
      { held: a1, rejected: a2, firstAfterResume: c1, queueVersion: afterRestart.version },
    );

    await pause(false);
    const c1Task = await run(c1, true);
    await receipt(other, c1, 'admitted', null);
    await receiver.call(
      `/node-queue/${c1Entry.id}/control`,
      {
        operationID: randomUUID(),
        expectedVersion: (await queue()).entries.find((entry) => entry.id === c1Entry.id)!.version,
        action: 'hold',
      },
      409,
    );
    await finish(c1Task.id);
    assert.equal((await receiver.network()).local!.worker!.load.availableSlots, 0);
    await acceptRemote(other, c1);
    const localTask = await run(local.id, false);
    await control(a1Entry.id, 'resume');
    await receipt(sender, a1, 'queued', 1);
    await finish(localTask.id);
    const localReview = (await receiver.bootstrap()).tasks.find((item) => item.id === local.id)!;
    await receiver.call(`/tasks/${local.id}/accept`, {
      confirmed: true,
      version: localReview.version,
      note: 'Verified local deterministic result.',
    });
    const a1Task = await run(a1, true);
    await finish(a1Task.id);
    await acceptRemote(sender, a1);
    await until(
      queue,
      (snapshot) => snapshot.entries.every((entry) => entry.state === 'ended'),
      'all completed queue entries end',
    );
    const completed = await receiver.bootstrap();
    assert.equal(completed.tasks.length, 4);
    assert(completed.tasks.every((item) => item.state === 'accepted'));
    assert(!completed.tasks.some((item) => item.remoteOrigin?.remoteTaskID === a2));
    assert.equal(officialSessions(receiver).length, 4);
    assert.equal(new Set(completed.tasks.map((item) => item.sessionID)).size, 4);
    assert.equal(
      (await sender.network()).remoteTasks.find((item) => item.id === a2)?.queueReceipt?.state,
      'rejected',
    );
    pass(
      'Actual execution order matches queue controls; review holds the slot, rejected work never starts, each task has one session',
      {
        executedAfterOriginal: [c1Task.id, localTask.id, a1Task.id],
        rejectedRemoteID: a2,
        sessions: officialSessions(receiver),
      },
    );

    // Two existing Brains contend for the same Worker; a directed queue keeps its place.
    for (const master of [sender, other])
      await until(
        () => master.network(),
        (network) =>
          network.brains.some(
            (brain) =>
              brain.hosted &&
              brain.workers.some(
                (item) => item.nodeID === receiverID && item.load.availableSlots === 1,
              ),
          ),
        'original Brain sees the shared Worker slot',
      );
    const scheduled = await Promise.all(
      [sender, other].map((master, index) =>
        master.call<NodeNetwork & { createdTaskID: string }>(
          '/network/tasks',
          {
            ...request,
            requestID: randomUUID(),
            title: `M3.5 automatic contender ${index}`,
            requestedProjectID: null,
          },
          201,
        ),
      ),
    );
    const originals = scheduled.map((result, index) => ({
      master: [sender, other][index],
      task: result.brainTasks.find((candidate) => candidate.id === result.createdTaskID)!,
    }));
    assert(originals.every((item) => item.task));
    assert.notEqual(originals[0].task.brainID, originals[1].task.brainID);
    const competing = await until(
      async () =>
        Promise.all(
          originals.map(async (item) => ({
            ...item,
            current: (await item.master.network()).brainTasks.find(
              (candidate) => candidate.id === item.task.id,
            )!,
          })),
        ),
      (items) =>
        items.some((item) => item.current.status === 'running') &&
        items.some((item) => item.current.status === 'queued'),
      'one accepted Execution and one original queued Task',
    );
    const winner = competing.find((item) => item.current.status === 'running')!;
    const loser = competing.find((item) => item.current.status === 'queued')!;
    const winTask = await run(winner.current.executionID!, true);
    const directed = await send(sender, 'M3.5 directed queue ahead of automatic retry');
    await receipt(sender, directed, 'queued', 1);
    await finish(winTask.id);
    assert.equal(
      (await loser.master.network()).brainTasks.find((item) => item.id === loser.task.id)?.status,
      'queued',
    );
    await acceptRemote(winner.master, winner.current.executionID!);
    const directedTask = await run(directed, true);
    assert.equal(
      (await loser.master.network()).brainTasks.find((item) => item.id === loser.task.id)?.id,
      loser.task.id,
    );
    assert.equal(
      (await loser.master.network()).brainTasks.find((item) => item.id === loser.task.id)?.brainID,
      loser.task.brainID,
    );
    await finish(directedTask.id);
    await acceptRemote(sender, directed);
    const retriedNetwork = await until(
      () => loser.master.network(),
      (network) =>
        network.brainTasks.find((item) => item.id === loser.task.id)?.status === 'running',
      'same losing Brain Task resumes after directed queue and cooldown',
      65_000,
    );
    const retriedTask = retriedNetwork.brainTasks.find((item) => item.id === loser.task.id)!;
    assert.equal(retriedTask.brainID, loser.task.brainID);
    assert.equal(retriedTask.masterNodeID, loser.task.masterNodeID);
    assert(retriedTask.executionAttempt >= 2);
    assert.equal(retriedTask.selectedWorkerID, receiverID);
    const retryLocal = await run(retriedTask.executionID!, true);
    assert.equal(officialSessions(receiver).length, 7);
    const allBeforeRestart = await receiver.bootstrap();
    assert.equal(allBeforeRestart.tasks.length, 7);
    assert.equal(new Set(allBeforeRestart.tasks.map((item) => item.sessionID)).size, 7);
    pass(
      'Two Brains share one slot; directed waiting work runs before automatic retry and the losing Task keeps its original Brain',
      {
        winner: winner.task.id,
        loser: loser.task.id,
        loserBrain: loser.task.brainID,
        executionAttempt: retriedTask.executionAttempt,
        directedTask: directedTask.id,
        sessions: officialSessions(receiver),
      },
    );

    // Restart a running, accepted Execution. Unknown work must remain attached to its one session.
    await receiver.stop();
    await start(receiver);
    await waitChannel(loser.master, receiver);
    await wait(5500);
    const recovered = (await receiver.bootstrap()).tasks.find((item) => item.id === retryLocal.id)!;
    assert.equal(recovered.sessionID, retryLocal.sessionID);
    assert.equal(recovered.state, 'interrupted');
    assert.equal(officialSessions(receiver).length, 7);
    assert.equal((await receiver.bootstrap()).tasks.length, 7);
    const recoveredNetwork = await until(
      () => loser.master.network(),
      (network) =>
        network.remoteTasks.find((item) => item.id === retriedTask.executionID)?.executionState ===
          'interrupted' &&
        network.brainTasks.find((item) => item.id === loser.task.id)?.status === 'waiting',
      'owning Brain and source receive the recovered interrupted execution',
    );
    const retained = recoveredNetwork.brainTasks.find((item) => item.id === loser.task.id)!;
    assert.equal(retained.executionID, retriedTask.executionID);
    assert.equal(retained.executionAttempt, retriedTask.executionAttempt);
    assert.equal(retained.brainID, loser.task.brainID);
    assert.equal((await receiver.network()).local!.worker!.load.availableSlots, 0);
    pass(
      'Accepted unknown execution survives receiver restart with the same Task/session and keeps the slot; no automatic redispatch',
      {
        taskID: recovered.id,
        sessionID: recovered.sessionID,
        executionID: retained.executionID,
        brainTaskID: retained.id,
        state: recovered.state,
        owningBrainStatus: retained.status,
        sourceExecutionState: recoveredNetwork.remoteTasks.find(
          (item) => item.id === retained.executionID,
        )!.executionState,
      },
    );
    const senderMember = await ordinaryMember(sender, 'brain_member');
    await assertNoPrivateNetwork(senderMember);
    assert((await sender.network()).brainTasks.length > 0);
    pass('Ordinary members cannot read another owner’s Brain or outgoing execution details', {
      paths: ['/network', '/bootstrap'],
      memberBrainTasks: 0,
      memberRemoteTasks: 0,
    });
  }
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  const snapshots = await Promise.all(
    clients.map(async (client) => {
      try {
        return { root: client.root, state: await client.bootstrap() };
      } catch (error) {
        return { root: client.root, error: String(error), lastOutput: client.output };
      }
    }),
  );
  writeFileSync(join(root, 'snapshots.json'), JSON.stringify(snapshots, null, 2));
  model.release();
  await Promise.all(clients.map((client) => client.stop()));
  await model.close();
  save();
  console.log('M3.5', proof.status, root);
}
