import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { NodeNetwork } from '../server/node-network.ts';
import { RemoteTaskStore, validRemoteTaskOffer } from '../server/remote-tasks.ts';
import { BrainTaskStore, validBrainTaskSubmission } from '../server/brain-tasks.ts';
import {
  encryptChannelPayload,
  decryptChannelPayload,
  type ChannelEnvelope,
  type SecureChannelSession,
} from '../server/node-channel.ts';
import {
  taskFileCapability,
  taskFileLargeCapability,
  validTaskFileResponse,
  type TaskFileMessage,
  type TaskFileRoute,
  type TaskFileDescriptor,
} from '../shared/task-files.ts';
import type { RivloomNode } from '../shared/types.ts';
import { uploadTaskFile, type DraftTaskFile } from '../src/task-file-upload.ts';
import {
  createConversationDraft,
  updateConversationDraft,
  prepareConversationRequest,
  clearSubmittedDraft,
} from '../src/conversation-drafts.ts';
import type { api } from '../src/api.ts';

const file = (bytes: Buffer): TaskFileDescriptor => ({
  id: randomUUID(),
  name: 'example.txt',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mime: 'application/octet-stream',
});
type Internals = {
  identity: unknown;
  nodes: Map<string, RivloomNode>;
  channels: Map<string, SecureChannelSession>;
  trustStore: { record: (id: string) => unknown };
  remoteTasks: RemoteTaskStore;
  brainTasks: BrainTaskStore;
  handleChannelMessage: (
    value: ChannelEnvelope,
    remote: string,
    fileOnly?: boolean,
  ) => ChannelEnvelope;
  postToNode: (peer: RivloomNode, path: string, value: ChannelEnvelope) => Promise<unknown>;
  exchangeTaskFile: (peer: RivloomNode, message: TaskFileMessage) => Promise<unknown>;
  flushTaskFiles: (peerID: string) => Promise<void>;
  assertFilePeer: (
    route: TaskFileRoute,
    peer: string,
    direction: 'send' | 'receive',
    file: TaskFileDescriptor,
  ) => void;
};
function harness() {
  const root = resolve('.data', 'unit-task-file-flow', randomUUID());
  const networks = [
    new NodeNetwork(join(root, 'a'), false),
    new NodeNetwork(join(root, 'b'), false),
  ];
  const [a, b] = networks.map((n) => n as unknown as Internals),
    ids = ['A'.repeat(32), 'B'.repeat(32)],
    fingerprint = 'test-fingerprint';
  const peers = ids.map(
    (id) =>
      ({
        id,
        fingerprint,
        online: true,
        trusted: true,
        verified: true,
        channelReady: true,
        capabilities: [taskFileCapability],
        addresses: ['127.0.0.1'],
      }) as RivloomNode,
  );
  const forward = randomBytes(32),
    reverse = randomBytes(32),
    session = randomUUID();
  for (const [index, n] of [a, b].entries()) {
    n.identity = { nodeID: ids[index] };
    n.nodes.set(ids[1 - index], peers[1 - index]);
    n.trustStore.record = (id) => (id === ids[1 - index] ? { fingerprint } : null);
    n.channels.set(ids[1 - index], {
      id: session,
      localNodeID: ids[index],
      peerNodeID: ids[1 - index],
      sendKey: index ? reverse : forward,
      receiveKey: index ? forward : reverse,
      sendSequence: 0,
      receiveSequence: 0,
      expiresAt: Date.now() + 60000,
    });
  }
  a.postToNode = async (_peer, path, value) =>
    b.handleChannelMessage(value, '127.0.0.1', path === '/v1/channel/file');
  const reconnect = () => {
    const id = randomUUID();
    for (const [index, n] of [a, b].entries()) {
      n.nodes.set(ids[1 - index], { ...peers[1 - index], channelReady: true });
      n.channels.set(ids[1 - index], {
        id,
        localNodeID: ids[index],
        peerNodeID: ids[1 - index],
        sendKey: index ? reverse : forward,
        receiveKey: index ? forward : reverse,
        sendSequence: 0,
        receiveSequence: 0,
        expiresAt: Date.now() + 60000,
      });
    }
  };
  return {
    a,
    b,
    networks,
    ids,
    peers,
    reconnect,
    close: () => networks.forEach((n) => n.files.close()),
  };
}

test('file transfer waits for the authenticated task offer and then completes without manual retry', async () => {
  const h = harness();
  try {
    const bytes = Buffer.from('首次发送：中文与 emoji ✅'),
      f = file(bytes),
      brainID = randomUUID();
    const task = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'first transfer',
      description: 'selected input',
      criteria: 'verify',
      inputFiles: [f],
    });
    const route: TaskFileRoute = { scope: 'remote', taskID: task.id, purpose: 'input' };
    h.networks[0].files.beginUpload('sender', f);
    h.networks[0].files.uploadChunk('sender', f.id, 0, bytes.toString('base64'));
    h.networks[0].files.bindUploaded(route, 'sender', [f.id]);
    h.networks[0].files.queueDelivery(route, f.id, h.ids[1]);
    const channel = h.a.channels.get(h.ids[1])!;
    await h.a.flushTaskFiles(h.ids[1]);
    assert.equal(channel.sendSequence, 0, 'file cannot precede the task offer');
    assert.equal(h.networks[0].files.views(route)[0].deliveries[0].state, 'waiting');
    const offer = h.a.remoteTasks.message(task.id);
    assert(validRemoteTaskOffer(offer));
    h.b.remoteTasks.receiveOffer(offer);
    h.networks[1].files.expectIncoming(route, [f], h.ids[0]);
    h.a.remoteTasks.markDelivered(task.id, offer, false);
    await h.a.flushTaskFiles(h.ids[1]);
    assert.equal(channel.sendSequence, 0, 'unauthenticated HTTP success is not task receipt');
    h.a.remoteTasks.markDelivered(task.id, offer, true);
    await h.a.flushTaskFiles(h.ids[1]);
    assert.deepEqual(h.networks[1].files.content(f.id), bytes);
    assert.equal(h.networks[0].files.views(route)[0].deliveries[0].state, 'complete');
  } finally {
    h.close();
  }
});

test('a pending Brain submission does not block another task file for the same peer', async () => {
  const h = harness();
  try {
    const brainID = randomUUID(),
      brainBytes = Buffer.from('Brain selected input'),
      brainFile = file(brainBytes);
    const brain = h.a.brainTasks.create('submitted', h.ids[0], brainID, h.ids[1], {
      title: 'Brain input',
      description: 'selected input',
      criteria: 'verify',
      requestedProjectID: null,
      requirements: {},
      inputFiles: [brainFile],
    });
    const brainRoute: TaskFileRoute = { scope: 'brain', taskID: brain.id, purpose: 'input' };
    h.networks[0].files.beginUpload('sender', brainFile);
    h.networks[0].files.uploadChunk('sender', brainFile.id, 0, brainBytes.toString('base64'));
    h.networks[0].files.bindUploaded(brainRoute, 'sender', [brainFile.id]);
    h.networks[0].files.queueDelivery(brainRoute, brainFile.id, h.ids[1]);
    await h.a.flushTaskFiles(h.ids[1]);
    assert.equal(h.a.channels.get(h.ids[1])!.sendSequence, 0);

    const readyBytes = Buffer.from('Ready task input'),
      readyFile = file(readyBytes);
    const ready = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'Ready task',
      description: 'selected input',
      criteria: 'verify',
      inputFiles: [readyFile],
    });
    const readyRoute: TaskFileRoute = { scope: 'remote', taskID: ready.id, purpose: 'input' };
    h.networks[0].files.beginUpload('sender', readyFile);
    h.networks[0].files.uploadChunk('sender', readyFile.id, 0, readyBytes.toString('base64'));
    h.networks[0].files.bindUploaded(readyRoute, 'sender', [readyFile.id]);
    h.networks[0].files.queueDelivery(readyRoute, readyFile.id, h.ids[1]);
    const offer = h.a.remoteTasks.message(ready.id);
    assert(validRemoteTaskOffer(offer));
    h.b.remoteTasks.receiveOffer(offer);
    h.networks[1].files.expectIncoming(readyRoute, [readyFile], h.ids[0]);
    h.a.remoteTasks.markDelivered(ready.id, offer, true);
    await h.a.flushTaskFiles(h.ids[1]);
    assert.deepEqual(h.networks[1].files.content(readyFile.id), readyBytes);
    assert.equal(h.networks[0].files.views(brainRoute)[0].deliveries[0].state, 'waiting');

    const submission = h.a.brainTasks.message(brain.id);
    assert(validBrainTaskSubmission(submission));
    h.b.brainTasks.receiveSubmission(submission);
    h.networks[1].files.expectIncoming(brainRoute, [brainFile], h.ids[0]);
    h.a.brainTasks.markDelivered(brain.id, submission);
    await h.a.flushTaskFiles(h.ids[1]);
    assert.deepEqual(h.networks[1].files.content(brainFile.id), brainBytes);
    assert.equal(h.networks[0].files.views(brainRoute)[0].deliveries[0].state, 'complete');
  } finally {
    h.close();
  }
});
test('file protocol authenticates exact replies and rejects unrelated tasks, capabilities, replay and revoked senders', async () => {
  const h = harness();
  try {
    const bytes = Buffer.from('encrypted selected bytes'),
      f = file(bytes),
      brainID = randomUUID();
    const created = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'file task',
      description: 'file input',
      criteria: 'verify',
      inputFiles: [f],
    });
    const offer = h.a.remoteTasks.message(created.id);
    assert(validRemoteTaskOffer(offer));
    h.b.remoteTasks.receiveOffer(offer);
    const route: TaskFileRoute = { scope: 'remote', taskID: created.id, purpose: 'input' };
    h.networks[1].files.expectIncoming(route, [f], h.ids[0]);
    const begin: TaskFileMessage = {
      type: 'task-file',
      version: 1,
      requestID: randomUUID(),
      route,
      file: f,
    };
    const forged = { ...begin, route: { ...route, taskID: randomUUID() } };
    await assert.rejects(h.a.exchangeTaskFile(h.peers[1], forged), /关系不匹配/);
    const post = h.a.postToNode;
    h.a.postToNode = async () => null;
    await assert.rejects(h.a.exchangeTaskFile(h.peers[1], begin), /认证文件回执/);
    assert.equal(h.a.channels.size, 0);
    h.a.postToNode = post;
    h.reconnect();
    const reply = await h.a.exchangeTaskFile(h.peers[1], begin);
    assert(validTaskFileResponse(reply, begin));
    h.b.nodes.get(h.ids[0])!.capabilities = [];
    await assert.rejects(
      h.a.exchangeTaskFile(h.peers[1], { ...begin, requestID: randomUUID() }),
      /协商/,
    );
    h.b.nodes.get(h.ids[0])!.capabilities = [taskFileCapability];
    h.reconnect();
    const request = {
      ...begin,
      requestID: randomUUID(),
      offset: 0,
      data: bytes.toString('base64'),
    };
    const channel = h.a.channels.get(h.ids[1])!,
      envelope = encryptChannelPayload(channel, request);
    const received = h.b.handleChannelMessage(envelope, '127.0.0.1', true);
    assert(validTaskFileResponse(decryptChannelPayload(channel, received), request));
    assert.throws(() => h.b.handleChannelMessage(envelope, '127.0.0.1', true), /顺序/);
    assert.deepEqual(h.networks[1].files.content(f.id), bytes);
    h.b.trustStore.record = () => null;
    await assert.rejects(
      h.a.exchangeTaskFile(h.peers[1], { ...begin, requestID: randomUUID() }),
      /失效/,
    );
  } finally {
    h.close();
  }
});
test('file protocol returns authenticated hash failure and never marks corrupted bytes complete', async () => {
  const h = harness();
  try {
    const bytes = Buffer.from('good'),
      f = file(bytes),
      brainID = randomUUID();
    const task = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'hash',
      description: 'hash',
      criteria: 'hash',
      inputFiles: [f],
    });
    h.b.remoteTasks.receiveOffer(h.a.remoteTasks.message(task.id) as any);
    const route: TaskFileRoute = { scope: 'remote', taskID: task.id, purpose: 'input' };
    h.networks[1].files.expectIncoming(route, [f], h.ids[0]);
    const request: TaskFileMessage = {
      type: 'task-file',
      version: 1,
      requestID: randomUUID(),
      route,
      file: f,
      offset: 0,
      data: Buffer.from('evil').toString('base64'),
    };
    const response = await h.a.exchangeTaskFile(h.peers[1], request);
    assert(validTaskFileResponse(response, request));
    assert.equal(response.state, 'failed');
    assert.equal(h.networks[1].files.view(f.id).state, 'failed');
  } finally {
    h.close();
  }
});
test('Brain result routing fences stale Executions, wrong direction and unrelated peers', () => {
  const h = harness();
  try {
    const f = file(Buffer.alloc(0)),
      brainID = randomUUID();
    const brain = h.a.brainTasks.create('owned', h.ids[0], brainID, h.ids[0], {
      title: 'Brain',
      description: 'Brain',
      criteria: 'Brain',
      requestedProjectID: null,
      requirements: {},
      inputFiles: [f],
    });
    const execution = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'worker',
      description: 'worker',
      criteria: 'worker',
      brainTaskID: brain.id,
    });
    h.a.remoteTasks.record(execution.id)!.status = 'accepted';
    h.a.brainTasks.assign(brain.id, h.ids[1], execution.id);
    const route: TaskFileRoute = { scope: 'remote', taskID: execution.id, purpose: 'result' };
    h.a.assertFilePeer(route, h.ids[1], 'receive', f);
    assert.throws(() => h.a.assertFilePeer(route, h.ids[1], 'send', f), /关系不匹配/);
    assert.throws(() => h.a.assertFilePeer(route, 'C'.repeat(32), 'receive', f), /不受信/);
    h.a.brainTasks.record(brain.id)!.executionID = randomUUID();
    assert.throws(() => h.a.assertFilePeer(route, h.ids[1], 'receive', f), /当前执行/);
  } finally {
    h.close();
  }
});
test('file manifests survive task stores and participate in creation identity while text-only hashes stay stable', () => {
  const root = resolve('.data', 'unit-task-file-manifest', randomUUID()),
    store = new RemoteTaskStore(root),
    bytes = file(Buffer.from('manifest'));
  const input = { title: 'file manifest', description: 'immutable', criteria: 'saved' };
  const task = store.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
    ...input,
    inputFiles: [bytes],
  });
  assert(store.matchesCreation(task.id, { ...input, inputFiles: [{ ...bytes }] }));
  assert(!store.matchesCreation(task.id, input));
  const plain = store.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), input);
  assert(store.matchesCreation(plain.id, { ...input, inputFiles: [] }));
  const restarted = new RemoteTaskStore(root);
  restarted.load();
  assert.deepEqual(restarted.record(task.id)!.inputFiles, [bytes]);
  const brain = new BrainTaskStore(root),
    created = brain.create('submitted', 'A'.repeat(32), randomUUID(), 'B'.repeat(32), {
      ...input,
      requestedProjectID: null,
      requirements: {},
      inputFiles: [bytes],
    });
  const message = brain.message(created.id);
  assert(validBrainTaskSubmission(message));
  assert(!validBrainTaskSubmission({ ...message, inputFiles: [{ ...bytes, name: '../escape' }] }));
  const restored = new BrainTaskStore(root);
  restored.load();
  assert.deepEqual(restored.record(created.id)!.inputFiles, [bytes]);
});
test('encrypted large-file receiver requires the negotiated capability before accepting any bytes', async () => {
  const h = harness();
  try {
    const f = { ...file(Buffer.from('large descriptor')), bytes: 200 * 1024 ** 2 };
    const brainID = randomUUID();
    const task = h.a.remoteTasks.create(h.ids[0], brainID, h.ids[1], brainID, {
      title: 'large attachment',
      description: 'negotiated transfer',
      criteria: 'bounded',
      inputFiles: [f],
    });
    const offer = h.a.remoteTasks.message(task.id);
    assert(validRemoteTaskOffer(offer));
    h.b.remoteTasks.receiveOffer(offer);
    const route: TaskFileRoute = { scope: 'remote', taskID: task.id, purpose: 'input' };
    h.networks[1].files.expectIncoming(route, [f], h.ids[0]);
    const request: TaskFileMessage = {
      type: 'task-file',
      version: 1,
      requestID: randomUUID(),
      route,
      file: f,
    };
    await assert.rejects(h.a.exchangeTaskFile(h.peers[1], request), /协商/);
    h.peers[0].capabilities.push(taskFileLargeCapability);
    h.peers[1].capabilities.push(taskFileLargeCapability);
    h.reconnect();
    const received = await h.a.exchangeTaskFile(h.peers[1], {
      ...request,
      requestID: randomUUID(),
    });
    assert.equal((received as { state: string }).state, 'receiving');
    assert.equal(h.networks[1].files.views(route)[0].receivedBytes, 0);
  } finally {
    h.close();
  }
});

test('upload retry resumes the same selected file after an uncertain block acknowledgement', async () => {
  const bytes = Buffer.alloc(40000, 65),
    id = randomUUID(),
    item: DraftTaskFile = {
      id,
      file: new File([bytes], 'input.txt'),
      state: 'preparing',
      receivedBytes: 0,
      error: null,
    };
  let saved = 0,
    fail = true;
  const seenIDs: string[] = [];
  const call = (async (path: string, body: any) => {
    if (path === '/task-files/uploads') {
      seenIDs.push(body.id);
      return {
        ...body,
        state: saved === bytes.length ? 'complete' : 'receiving',
        receivedBytes: saved,
      };
    }
    const chunk = Buffer.from(body.data, 'base64');
    assert.equal(body.offset, saved);
    saved += chunk.length;
    if (fail) {
      fail = false;
      throw new Error('lost reply');
    }
    return { state: saved === bytes.length ? 'complete' : 'receiving', receivedBytes: saved };
  }) as typeof api;
  await assert.rejects(
    uploadTaskFile(item, (p) => Object.assign(item, p), call),
    /lost reply/,
  );
  await uploadTaskFile(item, (p) => Object.assign(item, p), call);
  assert.deepEqual(seenIDs, [id, id]);
  assert.equal(item.state, 'complete');
});
test('draft file progress preserves request identity; changed selection and stale submission cannot clear another draft', () => {
  const f: DraftTaskFile = {
    id: randomUUID(),
    file: new File(['data'], 'a.txt'),
    state: 'uploading',
    receivedBytes: 0,
    error: null,
  };
  const first = updateConversationDraft(createConversationDraft(), { text: 'task', files: [f] });
  const uploaded = updateConversationDraft(first, { files: [{ ...f, state: 'complete' }] });
  assert.equal(first.requestID, uploaded.requestID);
  const sent = prepareConversationRequest(uploaded, { attachmentIDs: [f.id] });
  const changed = updateConversationDraft(sent, { files: [] });
  assert.notEqual(changed.requestID, sent.requestID);
  const drafts = { new: changed, other: createConversationDraft() };
  assert.equal(clearSubmittedDraft(drafts, 'new', sent.requestID), drafts);
});
