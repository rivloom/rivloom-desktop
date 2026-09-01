import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createSocket } from 'node:dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadNodeIdentity } from '../server/node-identity.ts';
import {
  acceptSecureChannel,
  beginSecureChannel,
  decryptChannelPayload,
  encryptChannelPayload,
  finishSecureChannel,
  validChannelAck,
  validChannelEnvelope,
} from '../server/node-channel.ts';
import {
  directedBroadcastAddress,
  discoveryProbeAddresses,
  NodeNetwork,
  nodePresence,
  privateNetworkAddress,
} from '../server/node-network.ts';
import {
  NodeTrustStore,
  unsignedPairingMessage,
  type PairingMessage,
} from '../server/node-trust.ts';
import {
  RemoteTaskStore,
  validRemoteTaskCancel,
  validRemoteTaskExecution,
  validRemoteTaskOffer,
  validRemoteTaskPreparation,
  validRemoteTaskResponse,
} from '../server/remote-tasks.ts';
import { ExecutionPolicyStore } from '../server/execution-policy.ts';

async function availableUdpPort() {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', () => resolve());
  });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (typeof address === 'string') throw new Error('无法分配 UDP 测试端口。');
  return address.port;
}

async function waitForMutualDiscovery(networks: NodeNetwork[]) {
  const deadline = Date.now() + 20_000;
  while (
    Date.now() < deadline &&
    networks.some((network) => network.snapshot().nearby.length !== 1)
  )
    await wait(250);
  assert(networks.every((network) => network.snapshot().nearby.length === 1));
}

async function waitForSecureChannels(networks: NodeNetwork[]) {
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    networks.some((network) => network.snapshot().nearby[0]?.channelReady !== true)
  )
    await wait(100);
  assert(networks.every((network) => network.snapshot().nearby[0]?.channelReady === true));
}

async function waitForRemoteTaskStatus(networks: NodeNetwork[], status: string) {
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    networks.some(
      (network) =>
        network.snapshot().remoteTasks.length !== 1 ||
        network.snapshot().remoteTasks[0]?.status !== status ||
        network.snapshot().remoteTasks[0]?.deliveryPending,
    )
  )
    await wait(50);
  assert(
    networks.every(
      (network) =>
        network.snapshot().remoteTasks.length === 1 &&
        network.snapshot().remoteTasks[0]?.status === status &&
        !network.snapshot().remoteTasks[0]?.deliveryPending,
    ),
  );
}

async function waitForRemoteExecutionStatus(networks: NodeNetwork[], status: string) {
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    networks.some(
      (network) =>
        network.snapshot().remoteTasks[0]?.executionStatus !== status ||
        network.snapshot().remoteTasks[0]?.deliveryPending,
    )
  )
    await wait(50);
  assert(
    networks.every(
      (network) =>
        network.snapshot().remoteTasks[0]?.executionStatus === status &&
        !network.snapshot().remoteTasks[0]?.deliveryPending,
    ),
  );
}

test('node network only accepts local and private source addresses', () => {
  assert(privateNetworkAddress('127.0.0.1'));
  assert(privateNetworkAddress('::1'));
  assert(privateNetworkAddress('::ffff:192.168.1.7'));
  assert(privateNetworkAddress('10.1.2.3'));
  assert(privateNetworkAddress('172.31.2.3'));
  assert(!privateNetworkAddress('172.32.2.3'));
  assert(!privateNetworkAddress('8.8.8.8'));
  assert(!privateNetworkAddress('example.com'));
  assert.deepEqual(
    discoveryProbeAddresses({
      referer: { address: '192.168.1.7' },
      addresses: ['192.168.1.99'],
    }),
    ['192.168.1.7'],
  );
  assert.deepEqual(
    discoveryProbeAddresses({
      referer: { address: '8.8.8.8' },
      addresses: ['192.168.1.99'],
    }),
    [],
  );
  assert.equal(directedBroadcastAddress('192.168.5.20', '255.255.255.0'), '192.168.5.255');
  assert.equal(directedBroadcastAddress('172.18.0.1', '255.255.255.252'), '172.18.0.3');
  assert.equal(directedBroadcastAddress('bad', '255.255.255.0'), null);
  const seenAt = new Date('2026-09-01T00:00:00.000Z').toISOString();
  const at = Date.parse(seenAt);
  assert.equal(nodePresence(seenAt, at + 14_999), 'online');
  assert.equal(nodePresence(seenAt, at + 15_000), 'offline');
  assert.equal(nodePresence(seenAt, at + 29_999), 'offline');
  assert.equal(nodePresence(seenAt, at + 30_000), 'expired');
  assert.equal(nodePresence('invalid', at), 'expired');
});

test(
  'node identity is stable and the private key is protected with Windows DPAPI',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rivloom-identity-test-'));
    try {
      const first = loadNodeIdentity(root);
      const second = loadNodeIdentity(root);
      const stored = readFileSync(join(root, 'node-identity.json'), 'utf8');
      assert.equal(first.nodeID, second.nodeID);
      assert.equal(first.brainID, second.brainID);
      assert.equal(first.sign('same-value'), second.sign('same-value'));
      assert(stored.includes('windows-dpapi-current-user'));
      assert(!stored.includes('PRIVATE KEY'));
      assert(!stored.includes('same-value'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'node trust storage rejects conflicting trusted and revoked records',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rivloom-trust-test-'));
    try {
      const identity = loadNodeIdentity(root);
      const trust = new NodeTrustStore(root);
      const pairedAt = new Date().toISOString();
      trust.trust({
        nodeID: identity.nodeID,
        fingerprint: identity.fingerprint,
        publicKey: identity.publicKey,
        pairedAt,
      });
      const path = join(root, 'trusted-nodes.json');
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      stored.revoked.push({
        nodeID: identity.nodeID,
        fingerprint: identity.fingerprint,
        revokedAt: pairedAt,
      });
      writeFileSync(path, JSON.stringify(stored));
      assert.throws(() => new NodeTrustStore(root).load(), /存在冲突/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'secure node channel derives directional keys and rejects tamper, replay and expiry',
  { skip: process.platform !== 'win32' },
  () => {
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-channel-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-channel-b-')),
    ];
    try {
      const identities = roots.map(loadNodeIdentity);
      const pending = beginSecureChannel(identities[0], identities[1].nodeID);
      const accepted = acceptSecureChannel(pending.message, identities[1]);
      const initiator = finishSecureChannel(pending, accepted.ack);
      const responder = accepted.session;
      const envelope = encryptChannelPayload(initiator, { type: 'proof', value: 42 });
      const replacement = envelope.ciphertext[0] === 'A' ? 'B' : 'A';
      const tampered = {
        ...envelope,
        ciphertext: replacement + envelope.ciphertext.slice(1),
      };
      assert.throws(() => decryptChannelPayload(responder, tampered), /完整性校验失败/);
      assert.equal(responder.receiveSequence, 0);
      assert.deepEqual(decryptChannelPayload(responder, envelope), { type: 'proof', value: 42 });
      assert.throws(() => decryptChannelPayload(responder, envelope), /会话、顺序或时间无效/);

      const reply = encryptChannelPayload(responder, { type: 'reply', accepted: true });
      assert.deepEqual(decryptChannelPayload(initiator, reply), {
        type: 'reply',
        accepted: true,
      });
      initiator.expiresAt = Date.now() - 1;
      assert.throws(() => encryptChannelPayload(initiator, { type: 'late' }), /已过期/);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
);

test('remote task invitations persist and apply idempotent offer and response messages', () => {
  const roots = [
    mkdtempSync(join(tmpdir(), 'rivloom-remote-task-owner-')),
    mkdtempSync(join(tmpdir(), 'rivloom-remote-task-target-')),
    mkdtempSync(join(tmpdir(), 'rivloom-remote-task-legacy-')),
  ];
  try {
    const owner = new RemoteTaskStore(roots[0]);
    const target = new RemoteTaskStore(roots[1]);
    const created = owner.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '检查构建失败',
      description: '请先复现失败并说明原因，不要开始执行工具。',
      criteria: '双方确认任务范围后再选择项目和模型。',
    });
    const offer = owner.message(created.id);
    assert(validRemoteTaskOffer(offer));
    assert.equal(target.receiveOffer(offer), true);
    assert.equal(target.receiveOffer(offer), false);
    assert.throws(() => target.receiveOffer({ ...offer, title: '冲突标题' }), /冲突/);
    assert(owner.markDelivered(created.id, offer));

    target.decide(created.id, 'accepted');
    const response = target.message(created.id);
    assert(validRemoteTaskResponse(response));
    assert.equal(owner.receiveResponse(response), true);
    assert.equal(owner.receiveResponse(response), false);
    assert(target.markDelivered(created.id, response));
    assert.equal(owner.list()[0].status, 'accepted');
    assert.equal(target.list()[0].status, 'accepted');
    assert.equal('idempotencyKey' in owner.list()[0], false);

    const projectID = randomUUID();
    target.prepare(created.id, projectID, 'opencode/mimo-v2.5-free');
    const preparation = target.message(created.id);
    assert(validRemoteTaskPreparation(preparation));
    assert.equal(owner.receivePreparation(preparation), true);
    assert.equal(owner.receivePreparation(preparation), false);
    assert(target.markDelivered(created.id, preparation));
    assert.equal(target.projectLeased(projectID), true);
    assert.equal(owner.list()[0].executionStatus, 'ready');
    assert.equal(owner.list()[0].localProjectID, null);
    assert.equal(target.list()[0].localProjectID, projectID);

    target.revokePreparation(created.id);
    const revokedPreparation = target.message(created.id);
    assert(validRemoteTaskPreparation(revokedPreparation));
    assert.equal(owner.receivePreparation(revokedPreparation), true);
    assert(target.markDelivered(created.id, revokedPreparation));
    assert.equal(target.projectLeased(projectID), false);

    target.prepare(created.id, projectID, 'opencode/mimo-v2.5-free');
    const renewedPreparation = target.message(created.id);
    assert(validRemoteTaskPreparation(renewedPreparation));
    assert.equal(owner.receivePreparation(renewedPreparation), true);
    assert(target.markDelivered(created.id, renewedPreparation));
    const expiring = target.record(created.id)!;
    expiring.executionLeaseExpiresAt = new Date(Date.now() - 1).toISOString();
    assert(target.expire());
    const expiredPreparation = target.message(created.id);
    assert(validRemoteTaskPreparation(expiredPreparation));
    assert.equal(owner.receivePreparation(expiredPreparation), true);
    assert(target.markDelivered(created.id, expiredPreparation));
    assert.equal(target.projectLeased(projectID), false);

    const reloadedOwner = new RemoteTaskStore(roots[0]);
    const reloadedTarget = new RemoteTaskStore(roots[1]);
    reloadedOwner.load();
    reloadedTarget.load();
    assert.equal(reloadedOwner.list()[0].executionStatus, 'expired');
    assert.equal(reloadedTarget.list()[0].executionStatus, 'expired');

    const legacy = new RemoteTaskStore(roots[2]);
    legacy.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '旧版本邀请',
      description: '验证第一切片的持久记录可以安全迁移。',
      criteria: '迁移不改变任务路由和文本。',
    });
    const legacyPath = join(roots[2], 'remote-task-invites.json');
    const legacyValue = JSON.parse(readFileSync(legacyPath, 'utf8'));
    legacyValue.version = 1;
    for (const task of legacyValue.tasks)
      for (const key of [
        'executionStatus',
        'executionLeaseID',
        'executionLeaseExpiresAt',
        'executionUpdatedAt',
        'localProjectID',
        'localModel',
        'automaticEligible',
        'localTaskID',
        'executionState',
        'executionSequence',
        'executionSummary',
      ])
        delete task[key];
    writeFileSync(legacyPath, JSON.stringify(legacyValue, null, 2));
    const migrated = new RemoteTaskStore(roots[2]);
    migrated.load();
    assert.equal(migrated.list()[0].executionStatus, 'unprepared');
    assert.equal(migrated.list()[0].automaticEligible, false);
    assert.equal(JSON.parse(readFileSync(legacyPath, 'utf8')).version, 3);

    const cancelled = owner.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '取消邀请',
      description: '验证归属 Brain 可以取消尚未执行的邀请。',
      criteria: '目标端幂等地显示已取消。',
    });
    const cancelledOffer = owner.message(cancelled.id);
    assert(validRemoteTaskOffer(cancelledOffer));
    target.receiveOffer(cancelledOffer);
    owner.markDelivered(cancelled.id, cancelledOffer);
    owner.cancel(cancelled.id);
    const cancellation = owner.message(cancelled.id);
    assert(validRemoteTaskCancel(cancellation));
    assert.equal(target.receiveCancel(cancellation), true);
    assert.equal(target.receiveCancel(cancellation), false);

    const executing = owner.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '策略化执行',
      description: '验证远端任务与本机业务任务只绑定一次。',
      criteria: '归属 Brain 按单调序号收到执行状态。',
    });
    const executingOffer = owner.message(executing.id);
    assert(validRemoteTaskOffer(executingOffer));
    target.receiveOffer(executingOffer);
    owner.markDelivered(executing.id, executingOffer);
    target.decide(executing.id, 'accepted');
    const executingResponse = target.message(executing.id);
    assert(validRemoteTaskResponse(executingResponse));
    owner.receiveResponse(executingResponse);
    target.markDelivered(executing.id, executingResponse);
    const localTaskID = randomUUID();
    target.bindLocalTask(executing.id, localTaskID);
    const readyExecution = target.message(executing.id);
    assert(validRemoteTaskExecution(readyExecution));
    assert.equal(owner.receiveExecution(readyExecution), true);
    assert.equal(owner.receiveExecution(readyExecution), false);
    target.markDelivered(executing.id, readyExecution);
    target.updateLocalExecution(localTaskID, 'running', 'OpenCode 正在执行任务。');
    const runningExecution = target.message(executing.id);
    assert(validRemoteTaskExecution(runningExecution));
    assert.equal(owner.receiveExecution(runningExecution), true);
    assert.equal(owner.list().find((task) => task.id === executing.id)?.executionState, 'running');
    assert.throws(() => owner.cancel(executing.id), /停止操作/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('execution policy persists automatic, limited and disabled local capability rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-execution-policy-'));
  try {
    const store = new ExecutionPolicyStore(root);
    store.load();
    assert.equal(store.snapshot().enabled, false);
    const projectID = randomUUID();
    const trustedNodeID = 'T'.repeat(32);
    store.save({
      enabled: true,
      mode: 'automatic',
      projectID,
      model: 'opencode/mimo-v2.5-free',
      allowedNodeIDs: [],
    });
    assert(store.allows('A'.repeat(32)));
    store.save({
      enabled: true,
      mode: 'limited',
      projectID,
      model: 'opencode/mimo-v2.5-free',
      allowedNodeIDs: [trustedNodeID],
    });
    assert(store.allows(trustedNodeID));
    assert.equal(store.allows('A'.repeat(32)), false);
    const reloaded = new ExecutionPolicyStore(root);
    reloaded.load();
    assert.deepEqual(reloaded.snapshot().allowedNodeIDs, [trustedNodeID]);
    reloaded.save({
      enabled: false,
      mode: 'automatic',
      projectID: null,
      model: null,
      allowedNodeIDs: [],
    });
    assert.equal(reloaded.allows(trustedNodeID), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'two isolated Rivloom instances discover and cryptographically verify each other',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async () => {
    const previous = process.env.RIVLOOM_DISCOVERY_FALLBACK;
    process.env.RIVLOOM_DISCOVERY_FALLBACK = 'disabled';
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-network-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-network-b-')),
    ];
    const networks = roots.map((root) => new NodeNetwork(root, true));
    try {
      await Promise.all(networks.map((network) => network.start()));
      const localIDs = networks.map((network) => network.snapshot().local!.id);
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        networks.some((network, index) =>
          network.snapshot().nearby.every((node) => node.id !== localIDs[index === 0 ? 1 : 0]),
        )
      )
        await wait(250);
      const snapshots = networks.map((network) => network.snapshot());
      const testPeers = snapshots.map((snapshot, index) =>
        snapshot.nearby.find((node) => node.id === localIDs[index === 0 ? 1 : 0]),
      );
      assert(snapshots.every((snapshot) => snapshot.status === 'online'));
      assert(snapshots.every((snapshot) => snapshot.local?.verified));
      assert(testPeers.every((node) => node?.verified));
      assert(testPeers.every((node) => !node?.trusted));
      assert.equal(testPeers[0]?.id, snapshots[1].local?.id);
      assert.equal(testPeers[1]?.id, snapshots[0].local?.id);

      const port = snapshots[0].local!.port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/hello?nonce=bad`)).status, 400);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).status, 404);
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RIVLOOM_DISCOVERY_FALLBACK;
      else process.env.RIVLOOM_DISCOVERY_FALLBACK = previous;
    }
  },
);

test(
  'UDP broadcast fallback discovers and verifies two nodes without mDNS',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async () => {
    const previous = process.env.RIVLOOM_MDNS_NETWORK;
    const previousPort = process.env.RIVLOOM_DISCOVERY_PORT;
    process.env.RIVLOOM_MDNS_NETWORK = 'disabled';
    process.env.RIVLOOM_DISCOVERY_PORT = String(await availableUdpPort());
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-fallback-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-fallback-b-')),
    ];
    const networks = roots.map((root) => new NodeNetwork(root, true));
    try {
      await Promise.all(networks.map((network) => network.start()));
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        networks.some((network) => network.snapshot().nearby.length !== 1)
      )
        await wait(250);
      const snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => snapshot.status === 'online'));
      assert(snapshots.every((snapshot) => snapshot.nearby.length === 1));
      assert(snapshots.every((snapshot) => snapshot.nearby[0].verified));
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].trusted));
      assert.equal(snapshots[0].nearby[0].id, snapshots[1].local?.id);
      assert.equal(snapshots[1].nearby[0].id, snapshots[0].local?.id);

      await networks[1].stop();
      const departureDeadline = Date.now() + 3000;
      while (Date.now() < departureDeadline && networks[0].snapshot().nearby[0]?.online !== false)
        await wait(50);
      assert.equal(networks[0].snapshot().nearby[0]?.online, false);
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.RIVLOOM_MDNS_NETWORK;
      else process.env.RIVLOOM_MDNS_NETWORK = previous;
      if (previousPort === undefined) delete process.env.RIVLOOM_DISCOVERY_PORT;
      else process.env.RIVLOOM_DISCOVERY_PORT = previousPort;
    }
  },
);

test(
  'two nodes require bilateral confirmation, persist trust, reject replay and revoke both sides',
  { skip: process.platform !== 'win32', timeout: 45_000 },
  async () => {
    const previousMdns = process.env.RIVLOOM_MDNS_NETWORK;
    const previousPort = process.env.RIVLOOM_DISCOVERY_PORT;
    process.env.RIVLOOM_MDNS_NETWORK = 'disabled';
    process.env.RIVLOOM_DISCOVERY_PORT = String(await availableUdpPort());
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-pairing-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-pairing-b-')),
    ];
    let networks = roots.map((root) => new NodeNetwork(root, true));
    try {
      await Promise.all(networks.map((network) => network.start()));
      await waitForMutualDiscovery(networks);

      const first = networks[0].snapshot();
      const second = networks[1].snapshot();
      const requester = loadNodeIdentity(roots[0]);
      const unsigned: Omit<PairingMessage, 'signature'> = {
        protocol: 'rivloom-node-pairing',
        version: 1,
        type: 'request',
        pairingID: randomUUID(),
        requesterNodeID: first.local!.id,
        responderNodeID: second.local!.id,
        nonce: randomBytes(24).toString('base64url'),
        actorNodeID: first.local!.id,
        issuedAt: Date.now(),
        publicKey: requester.publicKey,
      };
      const request: PairingMessage = {
        ...unsigned,
        signature: requester.sign(unsignedPairingMessage(unsigned)),
      };
      const target = first.nearby[0];
      const requestUrl = `http://${target.addresses[0]}:${target.port}/v1/pairing/request`;
      const accepted = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      assert.equal(accepted.status, 200);
      const replayed = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      assert.equal(replayed.status, 409);
      await networks[1].cancelPairing(unsigned.pairingID);

      await networks[0].requestPairing(second.local!.id);
      let snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => snapshot.pairings.length === 1));
      assert.equal(snapshots[0].pairings[0].code, snapshots[1].pairings[0].code);
      assert(/^\d{6}$/.test(snapshots[0].pairings[0].code));
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].trusted));

      await networks[0].confirmPairing(snapshots[0].pairings[0].id);
      snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].trusted));
      assert.equal(snapshots[0].pairings[0].localConfirmed, true);
      assert.equal(snapshots[1].pairings[0].remoteConfirmed, true);

      await networks[1].confirmPairing(snapshots[1].pairings[0].id);
      await waitForSecureChannels(networks);
      snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => snapshot.nearby[0].trusted));
      assert(snapshots.every((snapshot) => snapshot.nearby[0].channelReady));
      assert(snapshots.every((snapshot) => snapshot.pairings.length === 0));
      assert(roots.every((root) => readFileSync(join(root, 'trusted-nodes.json'), 'utf8')));

      await networks[0].createRemoteTask(
        snapshots[0].nearby[0].id,
        snapshots[0].nearby[0].brains[0].id,
        {
          title: '验证远端任务邀请',
          description: '只接受或拒绝这条邀请，不启动 OpenCode，也不访问任何项目。',
          criteria: '两端状态一致，重启后仍可读取。',
        },
      );
      await waitForRemoteTaskStatus(networks, 'pending');
      snapshots = networks.map((network) => network.snapshot());
      assert.equal(snapshots[0].remoteTasks[0].direction, 'outgoing');
      assert.equal(snapshots[1].remoteTasks[0].direction, 'incoming');
      assert.equal(snapshots[0].remoteTasks[0].id, snapshots[1].remoteTasks[0].id);
      await networks[1].respondRemoteTask(snapshots[1].remoteTasks[0].id, 'accepted');
      await waitForRemoteTaskStatus(networks, 'accepted');
      const leasedProjectID = randomUUID();
      await networks[1].prepareRemoteTask(
        snapshots[1].remoteTasks[0].id,
        leasedProjectID,
        'opencode/mimo-v2.5-free',
      );
      await waitForRemoteExecutionStatus(networks, 'ready');
      snapshots = networks.map((network) => network.snapshot());
      assert.equal(snapshots[0].remoteTasks[0].localProjectID, null);
      assert.equal(snapshots[0].remoteTasks[0].localModel, null);
      assert.equal(snapshots[1].remoteTasks[0].localProjectID, leasedProjectID);
      assert(networks[1].projectLeased(leasedProjectID));

      await Promise.all(networks.map((network) => network.stop()));
      networks = roots.map((root) => new NodeNetwork(root, true));
      await Promise.all(networks.map((network) => network.start()));
      await waitForMutualDiscovery(networks);
      await waitForSecureChannels(networks);
      snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => snapshot.nearby[0].trusted));
      assert(snapshots.every((snapshot) => snapshot.nearby[0].channelReady));
      assert(snapshots.every((snapshot) => snapshot.remoteTasks[0]?.status === 'accepted'));
      assert(snapshots.every((snapshot) => snapshot.remoteTasks[0]?.executionStatus === 'ready'));
      assert(networks[1].projectLeased(leasedProjectID));

      const initiatorIndex =
        snapshots[0].local!.id.localeCompare(snapshots[1].local!.id) < 0 ? 0 : 1;
      const initiatorIdentity = loadNodeIdentity(roots[initiatorIndex]);
      const channelTarget = snapshots[initiatorIndex].nearby[0];
      const channelUrl = `http://${channelTarget.addresses[0]}:${channelTarget.port}`;
      const pendingChannel = beginSecureChannel(initiatorIdentity, channelTarget.id);
      const forgedOpen = {
        ...pendingChannel.message,
        ephemeralPublicKey:
          (pendingChannel.message.ephemeralPublicKey[0] === 'A' ? 'B' : 'A') +
          pendingChannel.message.ephemeralPublicKey.slice(1),
      };
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(forgedOpen),
          })
        ).status,
        403,
      );
      const channelAccepted = await fetch(`${channelUrl}/v1/channel/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingChannel.message),
      });
      assert.equal(channelAccepted.status, 200);
      const channelAck = (await channelAccepted.json()) as unknown;
      assert(validChannelAck(channelAck));
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingChannel.message),
          })
        ).status,
        409,
      );

      const manualChannel = finishSecureChannel(pendingChannel, channelAck);
      const directoryRequest = encryptChannelPayload(manualChannel, {
        type: 'brain-directory-request',
        requestID: randomUUID(),
        capabilities: ['brain', 'executor', 'human-ui'],
        brains: snapshots[initiatorIndex].local!.brains,
      });
      const forgedCiphertext = {
        ...directoryRequest,
        ciphertext:
          (directoryRequest.ciphertext[0] === 'A' ? 'B' : 'A') +
          directoryRequest.ciphertext.slice(1),
      };
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...directoryRequest, sessionID: randomUUID() }),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(forgedCiphertext),
          })
        ).status,
        403,
      );
      const directoryAccepted = await fetch(`${channelUrl}/v1/channel/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(directoryRequest),
      });
      assert.equal(directoryAccepted.status, 200);
      const directoryEnvelope = (await directoryAccepted.json()) as unknown;
      assert(validChannelEnvelope(directoryEnvelope));
      const directory = decryptChannelPayload(manualChannel, directoryEnvelope) as {
        type?: unknown;
        brains?: unknown[];
      };
      assert.equal(directory.type, 'brain-directory-response');
      assert.equal(directory.brains?.length, 1);
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(directoryRequest),
          })
        ).status,
        403,
      );

      const revokedNodeIDs: string[][] = [[], []];
      networks.forEach((network, index) =>
        network.on('trust-revoked', (value: { nodeID: string }) =>
          revokedNodeIDs[index].push(value.nodeID),
        ),
      );
      await networks[0].revokeTrust(snapshots[0].nearby[0].id);
      const revocationDeadline = Date.now() + 2_000;
      while (Date.now() < revocationDeadline && revokedNodeIDs.some((values) => !values.length))
        await wait(20);
      snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].trusted));
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].channelReady));
      assert(snapshots.every((snapshot) => snapshot.remoteTasks[0]?.status === 'cancelled'));
      assert.deepEqual(revokedNodeIDs[0], [snapshots[0].nearby[0].id]);
      assert.deepEqual(revokedNodeIDs[1], [snapshots[1].nearby[0].id]);
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      if (previousMdns === undefined) delete process.env.RIVLOOM_MDNS_NETWORK;
      else process.env.RIVLOOM_MDNS_NETWORK = previousMdns;
      if (previousPort === undefined) delete process.env.RIVLOOM_DISCOVERY_PORT;
      else process.env.RIVLOOM_DISCOVERY_PORT = previousPort;
    }
  },
);
