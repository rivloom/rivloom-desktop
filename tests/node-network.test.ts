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
  validRemoteTaskControl,
  validRemoteTaskExecution,
  validRemoteTaskOffer,
  validRemoteTaskPreparation,
  validRemoteTaskResponse,
} from '../server/remote-tasks.ts';
import { ExecutionPolicyStore } from '../server/execution-policy.ts';
import {
  rankBrainPlacements,
  parseNvidiaMemory,
  rankWorkers,
  validWorkerRegistration,
  workerMatchesTask,
} from '../server/worker-resources.ts';
import type { BrainTopology, WorkerRegistration } from '../shared/types.ts';
import { BrainTopologyStore } from '../server/brain-topology.ts';
import {
  BrainTaskStore,
  validBrainTaskSubmission,
  validBrainTaskUpdate,
} from '../server/brain-tasks.ts';
import { WorkerAdmissionGate } from '../server/worker-admission.ts';

test('node rate limits isolate discovery, hello and channel budgets without bypassing caps', () => {
  // An unstarted store only reads this nonexistent root; no identity or files are created.
  const network = new NodeNetwork(join(tmpdir(), `rivloom-rate-${randomUUID()}`), false);
  const limiter = network as unknown as {
    rateLimited(address: string, scope: 'discovery' | 'hello' | 'control' | 'channel'): boolean;
  };
  for (const [scope, limit] of [
    ['discovery', 60],
    ['hello', 120],
    ['control', 60],
    ['channel', 600],
  ] as const) {
    for (let index = 0; index < limit; index++)
      assert.equal(limiter.rateLimited('192.168.10.2', scope), false, `${scope} legitimate budget`);
    assert.equal(
      limiter.rateLimited('::ffff:192.168.10.2', scope),
      true,
      `${scope} cap and normalized address`,
    );
    assert.equal(limiter.rateLimited('192.168.10.3', scope), false, `${scope} independent address`);
  }
});

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

async function waitForDiscoveredNode(network: NodeNetwork, nodeID: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !network.snapshot().nearby.some((node) => node.id === nodeID))
    await wait(100);
  assert(network.snapshot().nearby.some((node) => node.id === nodeID));
}

async function pairNetworks(left: NodeNetwork, right: NodeNetwork) {
  const leftID = left.snapshot().local!.id;
  const rightID = right.snapshot().local!.id;
  await waitForDiscoveredNode(left, rightID);
  await waitForDiscoveredNode(right, leftID);
  await left.requestPairing(rightID);
  let leftPairing = left.snapshot().pairings.find((pairing) => pairing.nodeID === rightID);
  let rightPairing = right.snapshot().pairings.find((pairing) => pairing.nodeID === leftID);
  assert(leftPairing && rightPairing);
  await left.confirmPairing(leftPairing.id);
  rightPairing = right.snapshot().pairings.find((pairing) => pairing.nodeID === leftID);
  assert(rightPairing);
  await right.confirmPairing(rightPairing.id);
  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline &&
    (!left.snapshot().nearby.find((node) => node.id === rightID)?.channelReady ||
      !right.snapshot().nearby.find((node) => node.id === leftID)?.channelReady)
  )
    await wait(100);
  assert(left.snapshot().nearby.find((node) => node.id === rightID)?.channelReady);
  assert(right.snapshot().nearby.find((node) => node.id === leftID)?.channelReady);
}

async function waitForRemoteTaskStatus(networks: NodeNetwork[], status: string) {
  const deadline = Date.now() + 20_000;
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
  const snapshots = networks.map((network) => network.snapshot());
  assert(
    snapshots.every(
      (network) =>
        network.remoteTasks.length === 1 &&
        network.remoteTasks[0]?.status === status &&
        !network.remoteTasks[0]?.deliveryPending,
    ),
    JSON.stringify(
      snapshots.map((snapshot) => ({
        local: snapshot.local?.id,
        channelReady: snapshot.nearby.map((node) => [node.id, node.channelReady]),
        tasks: snapshot.remoteTasks.map((task) => ({
          direction: task.direction,
          status: task.status,
          deliveryPending: task.deliveryPending,
          deliveryError: task.deliveryError,
          ownerBrainID: task.ownerBrainID,
          targetNodeID: task.targetNodeID,
        })),
      })),
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

const workerFixture = (
  nodeID: string,
  input: Partial<WorkerRegistration> = {},
): WorkerRegistration => ({
  nodeID,
  accepting: true,
  projects: [{ id: '11111111-1111-4111-8111-111111111111', name: 'alpha' }],
  hardware: {
    platform: 'win32',
    release: '10.0.26100',
    architecture: 'x64',
    cpuModel: 'Example CPU',
    physicalCores: 8,
    logicalCores: 16,
    memoryBytes: 32 * 1024 ** 3,
    gpus: [{ name: 'Example GPU', memoryBytes: 12 * 1024 ** 3 }],
    diskBytes: 1000 * 1024 ** 3,
    collectedAt: '2026-09-02T00:00:00.000Z',
  },
  load: {
    cpuPercent: 25,
    memoryAvailableBytes: 20 * 1024 ** 3,
    memoryUsedPercent: 37.5,
    gpuPercent: 10,
    gpuMemoryAvailableBytes: 10 * 1024 ** 3,
    diskAvailableBytes: 600 * 1024 ** 3,
    runningTasks: 0,
    availableSlots: 1,
    sampledAt: '2026-09-02T00:00:10.000Z',
  },
  ...input,
});

test('GPU memory parsing preserves values above 4 GiB and treats unavailable values as unknown', () => {
  const values = parseNvidiaMemory('NVIDIA Test GPU, 16311\nUnknown GPU, [N/A]\nBad GPU, -1\n');
  assert.equal(values.get('NVIDIA Test GPU'), 16311 * 1024 ** 2);
  assert.equal(values.size, 1);
  assert.equal(values.get('Unknown GPU'), undefined);
});

test('worker resource validation excludes identity and secret-shaped hardware fields', () => {
  const worker = workerFixture('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert(validWorkerRegistration(worker));
  assert.equal('mac' in worker.hardware, false);
  assert.equal('serial' in worker.hardware, false);
  assert.equal('username' in worker.hardware, false);
  assert.equal('directory' in worker.hardware, false);
  assert.equal('model' in worker, false);
  assert(
    !validWorkerRegistration({
      ...worker,
      hardware: { ...worker.hardware, serial: 'must-not-cross-the-node-boundary' },
    }),
  );
});

test('worker scheduling filters stale and incompatible reports before ranking live capacity', () => {
  const at = Date.parse('2026-09-02T00:00:20.000Z');
  const lowLoad = workerFixture('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const highLoad = workerFixture('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', {
    load: {
      ...workerFixture('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB').load,
      cpuPercent: 85,
      memoryAvailableBytes: 8 * 1024 ** 3,
      memoryUsedPercent: 75,
    },
  });
  const noGpu = workerFixture('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', {
    hardware: {
      ...workerFixture('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC').hardware,
      gpus: [],
    },
    load: {
      ...workerFixture('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC').load,
      gpuPercent: null,
      gpuMemoryAvailableBytes: null,
    },
  });
  const stale = workerFixture('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', {
    load: {
      ...workerFixture('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD').load,
      sampledAt: '2026-09-01T23:59:00.000Z',
    },
  });
  const task = {
    projectID: '11111111-1111-4111-8111-111111111111',
    requirements: {
      platform: 'win32',
      architecture: 'x64',
      minimumLogicalCores: 8,
      minimumMemoryBytes: 16 * 1024 ** 3,
      gpu: true,
      minimumGpuMemoryBytes: 8 * 1024 ** 3,
    },
  } as const;
  assert(workerMatchesTask(lowLoad, task, at));
  assert(!workerMatchesTask(noGpu, task, at));
  assert(!workerMatchesTask(stale, task, at));
  assert.deepEqual(
    rankWorkers([highLoad, stale, noGpu, lowLoad], task, at).map((worker) => worker.nodeID),
    [lowLoad.nodeID, highLoad.nodeID],
  );
});

test('worker scheduling uses stable node IDs to break equal load scores', () => {
  const at = Date.parse('2026-09-02T00:00:20.000Z');
  const first = workerFixture('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const second = workerFixture('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  assert.deepEqual(
    rankWorkers([second, first], { projectID: null, requirements: {} }, at).map(
      (worker) => worker.nodeID,
    ),
    [first.nodeID, second.nodeID],
  );
});

test('node final admission serializes competing Brains before reserving one global slot', async () => {
  const gate = new WorkerAdmissionGate();
  let occupied = false;
  let reservations = 0;
  const attempt = () =>
    gate.run(async () => {
      if (occupied) return false;
      await wait(10);
      occupied = true;
      reservations += 1;
      return true;
    });
  const results = await Promise.all([attempt(), attempt()]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(reservations, 1);
});

test('brain task placement chooses an established online Brain and its lowest-load Worker', () => {
  const at = Date.parse('2026-09-02T00:00:20.000Z');
  const busy = workerFixture('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', {
    load: {
      ...workerFixture('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB').load,
      cpuPercent: 90,
      memoryUsedPercent: 80,
    },
  });
  const idle = workerFixture('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const brain = (
    id: string,
    workers: WorkerRegistration[],
    input: Partial<BrainTopology> = {},
  ): BrainTopology => ({
    id,
    name: `Brain ${id.slice(0, 6)}`,
    masterNodeID: workers[0]?.nodeID || 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    state: 'established',
    hosted: false,
    online: true,
    queueDepth: 0,
    workers,
    ...input,
  });
  const placements = rankBrainPlacements(
    [
      brain('22222222-2222-4222-8222-222222222222', [busy]),
      brain('11111111-1111-4111-8111-111111111111', [idle]),
      brain('33333333-3333-4333-8333-333333333333', [idle], { online: false }),
      brain('44444444-4444-4444-8444-444444444444', [idle], {
        state: 'provisional',
      }),
    ],
    { projectID: null, requirements: {} },
    at,
  );
  assert.deepEqual(
    placements.map((placement) => [placement.brain.id, placement.worker.nodeID]),
    [
      ['11111111-1111-4111-8111-111111111111', idle.nodeID],
      ['22222222-2222-4222-8222-222222222222', busy.nodeID],
    ],
  );
  assert.deepEqual(
    rankBrainPlacements(
      [
        brain('11111111-1111-4111-8111-111111111111', [idle], { queueDepth: 3 }),
        brain('22222222-2222-4222-8222-222222222222', [idle], { queueDepth: 0 }),
      ],
      { projectID: null, requirements: {} },
      at,
    ).map((placement) => placement.brain.id),
    ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'],
  );
});

test('brain topology migrates a legacy node Brain as established and stable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-brain-legacy-'));
  const nodeID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const brainID = '11111111-1111-4111-8111-111111111111';
  try {
    const first = new BrainTopologyStore(root);
    first.load({ nodeID, legacyBrainID: brainID, legacyIdentityExisted: true });
    assert.deepEqual(first.hosted(), [
      {
        id: brainID,
        name: 'Brain 111111',
        masterNodeID: nodeID,
        state: 'established',
      },
    ]);
    const reloaded = new BrainTopologyStore(root);
    reloaded.load({
      nodeID,
      legacyBrainID: '22222222-2222-4222-8222-222222222222',
      legacyIdentityExisted: true,
    });
    assert.equal(reloaded.hosted()[0]?.id, brainID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('brain task submission gives the Master an authoritative Task and a separate Execution ID', () => {
  const submitterRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-task-submitter-'));
  const masterRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-task-master-'));
  const submitterNodeID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const masterNodeID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const workerNodeID = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const brainID = '11111111-1111-4111-8111-111111111111';
  try {
    const submitter = new BrainTaskStore(submitterRoot);
    const master = new BrainTaskStore(masterRoot);
    const submitted = submitter.create('submitted', submitterNodeID, brainID, masterNodeID, {
      title: '两跳提交',
      description: 'Task 先交给 Brain Master，再产生 Worker Execution。',
      criteria: 'Task ID 与 Execution ID 分离。',
      requestedProjectID: null,
      requirements: { minimumLogicalCores: 4 },
    });
    const submission = submitter.message(submitted.id);
    assert(validBrainTaskSubmission(submission));
    assert.equal(master.receiveSubmission(submission), true);
    assert.equal(master.receiveSubmission(submission), false);
    assert(submitter.markDelivered(submitted.id, submission));

    const executionID = randomUUID();
    const assigned = master.assign(submitted.id, workerNodeID, executionID);
    assert.notEqual(assigned.id, assigned.executionID);
    const update = master.message(submitted.id);
    assert(validBrainTaskUpdate(update));
    const mirrored = submitter.receiveUpdate(update);
    assert.equal(mirrored.status, 'assigned');
    assert.equal(mirrored.selectedWorkerID, workerNodeID);
    assert.equal(mirrored.executionID, executionID);
  } finally {
    rmSync(submitterRoot, { recursive: true, force: true });
    rmSync(masterRoot, { recursive: true, force: true });
  }
});

test('brain task retries a safely rejected Execution and fences delayed results from the old ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-brain-task-retry-'));
  const remoteRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-task-retry-remote-'));
  const submitterNodeID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const masterNodeID = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const firstWorkerID = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const secondWorkerID = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const brainID = '11111111-1111-4111-8111-111111111111';
  try {
    const tasks = new BrainTaskStore(root);
    const executions = new RemoteTaskStore(remoteRoot);
    const owned = tasks.create('owned', submitterNodeID, brainID, masterNodeID, {
      title: '安全重调度',
      description: 'Worker 明确拒绝后创建新的 Execution。',
      criteria: '旧 Execution 的迟到状态不能覆盖新尝试。',
      requestedProjectID: null,
      requirements: {},
    });
    const first = executions.create(masterNodeID, brainID, firstWorkerID, brainID, {
      title: owned.title,
      description: owned.description,
      criteria: owned.criteria,
    });
    tasks.assign(owned.id, firstWorkerID, first.id);
    const offer = executions.message(first.id);
    assert(validRemoteTaskOffer(offer));
    const workerExecutions = new RemoteTaskStore(join(remoteRoot, 'worker'));
    workerExecutions.receiveOffer(offer);
    workerExecutions.decide(first.id, 'declined');
    const response = workerExecutions.message(first.id);
    assert(validRemoteTaskResponse(response));
    executions.receiveResponse(response);
    const declined = executions.list()[0];
    assert(tasks.syncExecution(owned.id, declined));
    assert(
      tasks.requeueExecution(owned.id, declined, 'Worker 在本机最终准入时拒绝了这次 Execution。'),
    );
    const queued = tasks.list()[0];
    assert.equal(queued.status, 'queued');
    assert.equal(queued.executionID, null);
    assert.equal(queued.executionAttempt, 1);
    assert.equal(queued.executions[0]?.status, 'failed');
    assert(queued.retryNotBefore);

    const secondExecutionID = randomUUID();
    const assigned = tasks.assign(owned.id, secondWorkerID, secondExecutionID);
    assert.equal(assigned.executionAttempt, 2);
    assert.equal(assigned.executionID, secondExecutionID);
    assert.equal(assigned.executions.length, 2);
    assert.equal(tasks.syncExecution(owned.id, declined), false);
    assert.equal(tasks.list()[0]?.executionID, secondExecutionID);
    assert.equal(tasks.list()[0]?.status, 'assigned');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('brain task store migrates version 1 records into explicit Execution history', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-brain-task-v1-'));
  try {
    const store = new BrainTaskStore(root);
    const task = store.create(
      'owned',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '11111111-1111-4111-8111-111111111111',
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      {
        title: '迁移 Task',
        description: '保留既有 Task 与 Execution 标识。',
        criteria: '升级后形成第一条 Execution 历史。',
        requestedProjectID: null,
        requirements: {},
      },
    );
    const executionID = randomUUID();
    store.assign(task.id, 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', executionID);
    const path = join(root, 'brain-tasks.json');
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    legacy.version = 1;
    for (const record of legacy.tasks) {
      delete record.executionAttempt;
      delete record.executions;
      delete record.retryNotBefore;
    }
    writeFileSync(path, JSON.stringify(legacy));
    const migrated = new BrainTaskStore(root);
    migrated.load();
    assert.equal(migrated.list()[0]?.executionAttempt, 1);
    assert.equal(migrated.list()[0]?.executions[0]?.executionID, executionID);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic brain formation adopts established masters and never merges established Brains', () => {
  const freshRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-fresh-'));
  const establishedRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-established-'));
  const freshNode = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const masterNode = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const freshBrain = '22222222-2222-4222-8222-222222222222';
  const establishedBrain = '11111111-1111-4111-8111-111111111111';
  try {
    const fresh = new BrainTopologyStore(freshRoot);
    fresh.load({ nodeID: freshNode, legacyBrainID: freshBrain, legacyIdentityExisted: false });
    assert.equal(fresh.hosted()[0]?.state, 'provisional');
    fresh.reconcile(masterNode, [
      {
        id: establishedBrain,
        name: 'Brain 111111',
        masterNodeID: masterNode,
        state: 'established',
      },
    ]);
    assert.deepEqual(fresh.hosted(), []);
    assert.equal(fresh.all()[0]?.id, establishedBrain);

    const established = new BrainTopologyStore(establishedRoot);
    established.load({
      nodeID: masterNode,
      legacyBrainID: establishedBrain,
      legacyIdentityExisted: true,
    });
    established.reconcile(freshNode, [
      {
        id: freshBrain,
        name: 'Brain 222222',
        masterNodeID: freshNode,
        state: 'established',
      },
    ]);
    assert.deepEqual(
      established.all().map((brain) => brain.id),
      [establishedBrain, freshBrain],
    );
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
    rmSync(establishedRoot, { recursive: true, force: true });
  }
});

test('authenticated Master withdrawal removes only its provisional registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-provisional-withdrawal-'));
  try {
    const store = new BrainTopologyStore(root);
    store.load({
      nodeID: 'A'.repeat(32),
      legacyBrainID: randomUUID(),
      legacyIdentityExisted: true,
    });
    const provisional = {
      id: randomUUID(),
      name: 'Empty bootstrap',
      masterNodeID: 'B'.repeat(32),
      state: 'provisional' as const,
    };
    const established = {
      id: randomUUID(),
      name: 'Existing Brain',
      masterNodeID: 'C'.repeat(32),
      state: 'established' as const,
    };
    store.reconcile(provisional.masterNodeID, [provisional]);
    store.reconcile(established.masterNodeID, [established]);
    store.reconcile('D'.repeat(32), []);
    assert.equal(store.all().length, 3);
    assert(store.reconcile(provisional.masterNodeID, []));
    assert(!store.all().some((brain) => brain.id === provisional.id));
    store.reconcile(established.masterNodeID, []);
    assert(store.all().some((brain) => brain.id === established.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic brain formation deterministically keeps the lower provisional master', () => {
  const leftRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-left-'));
  const rightRoot = mkdtempSync(join(tmpdir(), 'rivloom-brain-right-'));
  const leftNode = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const rightNode = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const leftBrain = '11111111-1111-4111-8111-111111111111';
  const rightBrain = '22222222-2222-4222-8222-222222222222';
  try {
    const left = new BrainTopologyStore(leftRoot);
    const right = new BrainTopologyStore(rightRoot);
    left.load({ nodeID: leftNode, legacyBrainID: leftBrain, legacyIdentityExisted: false });
    right.load({ nodeID: rightNode, legacyBrainID: rightBrain, legacyIdentityExisted: false });
    left.reconcile(rightNode, right.hosted());
    right.reconcile(leftNode, left.hosted());
    assert.equal(left.hosted()[0]?.id, leftBrain);
    assert.equal(left.hosted()[0]?.state, 'established');
    assert.deepEqual(right.hosted(), []);
    assert.equal(right.all()[0]?.id, leftBrain);
  } finally {
    rmSync(leftRoot, { recursive: true, force: true });
    rmSync(rightRoot, { recursive: true, force: true });
  }
});

test(
  'shared workers register with two Brains and a declined Execution is reassigned safely',
  { skip: process.platform !== 'win32', timeout: 90_000 },
  async () => {
    const previousMdns = process.env.RIVLOOM_MDNS_NETWORK;
    const previousPort = process.env.RIVLOOM_DISCOVERY_PORT;
    process.env.RIVLOOM_MDNS_NETWORK = 'disabled';
    process.env.RIVLOOM_DISCOVERY_PORT = String(await availableUdpPort());
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-shared-master-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-shared-master-b-')),
      mkdtempSync(join(tmpdir(), 'rivloom-shared-worker-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-shared-worker-b-')),
    ];
    // Two pre-existing identities migrate as independent established Brains; both Workers are fresh.
    roots.slice(0, 2).forEach((root) => loadNodeIdentity(root));
    const networks = roots.map((root) => new NodeNetwork(root, true));
    try {
      for (const workerNetwork of networks.slice(2))
        workerNetwork.setWorkerRegistrationProvider((nodeID) => {
          const worker = workerFixture(nodeID);
          const sampledAt = new Date().toISOString();
          return {
            ...worker,
            hardware: { ...worker.hardware, collectedAt: sampledAt },
            load: { ...worker.load, sampledAt },
          };
        });
      await Promise.all(networks.map((network) => network.start()));
      for (const master of networks.slice(0, 2))
        for (const worker of networks.slice(2)) await pairNetworks(master, worker);

      const workerIDs = networks.slice(2).map((network) => network.snapshot().local!.id);
      const deadline = Date.now() + 15_000;
      while (
        Date.now() < deadline &&
        networks.slice(0, 2).some((network) => {
          const hosted = network.snapshot().brains.find((brain) => brain.hosted);
          return workerIDs.some(
            (workerID) => !hosted?.workers.some((worker) => worker.nodeID === workerID),
          );
        })
      )
        await wait(100);

      for (const master of networks.slice(0, 2)) {
        const hosted = master.snapshot().brains.find((brain) => brain.hosted);
        for (const workerID of workerIDs) {
          const registered = hosted?.workers.find((worker) => worker.nodeID === workerID);
          assert(registered);
          assert(validWorkerRegistration(registered));
          assert.equal('serial' in registered.hardware, false);
          assert.equal('model' in registered, false);
          assert.equal(registered.projects[0]?.name, 'alpha');
        }
      }

      for (const worker of networks.slice(2))
        assert.deepEqual(
          worker.snapshot().brains.filter((brain) => brain.hosted),
          [],
        );
      await networks[2].createScheduledTask({
        title: '自动安排到共享 Worker',
        description: '验证普通 Worker 先固定 Brain，再由 Master 选择 Worker Execution。',
        criteria: '权威 Task 与 Execution ID 分离，Brain 和目标 Worker 在各端一致。',
        requestedProjectID: null,
        requirements: { minimumLogicalCores: 8, minimumMemoryBytes: 8 * 1024 ** 3 },
      });
      const brainTaskDeadline = Date.now() + 20_000;
      while (
        Date.now() < brainTaskDeadline &&
        networks[2].snapshot().brainTasks[0]?.status !== 'assigned'
      )
        await wait(100);
      const submittedTask = networks[2].snapshot().brainTasks[0];
      assert(submittedTask);
      assert.equal(submittedTask.direction, 'submitted');
      assert.equal(submittedTask.status, 'assigned');
      assert(submittedTask.executionID);
      const master = networks
        .slice(0, 2)
        .find((network) => network.snapshot().local!.id === submittedTask.masterNodeID)!;
      const ownedTask = master.snapshot().brainTasks.find((task) => task.id === submittedTask.id);
      assert.equal(ownedTask?.direction, 'owned');
      assert.equal(ownedTask?.executionID, submittedTask.executionID);
      assert.notEqual(submittedTask.id, submittedTask.executionID);
      const deliveryDeadline = Date.now() + 20_000;
      while (
        Date.now() < deliveryDeadline &&
        !networks
          .slice(2)
          .some((network) =>
            network
              .snapshot()
              .remoteTasks.some(
                (execution) =>
                  execution.id === submittedTask.executionID && !execution.deliveryPending,
              ),
          )
      )
        await wait(50);
      const scheduled = master
        .snapshot()
        .remoteTasks.find((execution) => execution.id === submittedTask.executionID)!;
      const selectedWorker = networks
        .slice(2)
        .find((network) => network.snapshot().local!.id === scheduled.targetNodeID)!;
      const received = selectedWorker
        .snapshot()
        .remoteTasks.find((execution) => execution.id === submittedTask.executionID)!;
      assert(scheduled);
      assert(received);
      assert.equal(scheduled.status, 'pending');
      assert.equal(received.status, 'pending');
      assert(workerIDs.includes(scheduled.targetNodeID));
      assert.equal(scheduled.ownerBrainID, scheduled.targetBrainID);
      assert.equal(received.ownerBrainID, scheduled.ownerBrainID);
      assert.equal(received.requestedProjectID, null);
      assert.deepEqual(received.requirements, {
        minimumLogicalCores: 8,
        minimumMemoryBytes: 8 * 1024 ** 3,
      });
      const firstExecutionID = submittedTask.executionID;
      await selectedWorker.respondRemoteTask(firstExecutionID, 'declined');
      const retryDeadline = Date.now() + 10_000;
      while (
        Date.now() < retryDeadline &&
        networks[2].snapshot().brainTasks[0]?.executionAttempt !== 2
      )
        await wait(100);
      const retried = networks[2].snapshot().brainTasks[0];
      assert.equal(
        retried.executionAttempt,
        2,
        JSON.stringify({
          submitted: networks[2].snapshot().brainTasks,
          master: master.snapshot().brainTasks,
          executions: master.snapshot().remoteTasks.map((execution) => ({
            id: execution.id,
            target: execution.targetNodeID,
            status: execution.status,
            pending: execution.deliveryPending,
          })),
          workers: master
            .snapshot()
            .brains.find((brain) => brain.hosted)
            ?.workers.map((worker) => ({
              id: worker.nodeID,
              accepting: worker.accepting,
              slots: worker.load.availableSlots,
              sampledAt: worker.load.sampledAt,
            })),
        }),
      );
      assert.notEqual(retried.executionID, firstExecutionID);
      assert.equal(retried.executions[0]?.status, 'failed');
      assert.equal(retried.executions[1]?.status, 'assigned');
      assert.notEqual(retried.selectedWorkerID, scheduled.targetNodeID);
      assert(
        master
          .snapshot()
          .remoteTasks.some(
            (execution) =>
              execution.id === retried.executionID &&
              execution.targetNodeID === retried.selectedWorkerID &&
              execution.status === 'pending',
          ),
      );

      // Simulate missing multicast/broadcast refresh while authenticated unicast still works.
      for (const network of networks) {
        const discovery = network as unknown as {
          probe(): Promise<void>;
          sendDiscoveryQuery(): void;
        };
        discovery.probe = async () => {};
        discovery.sendDiscoveryQuery = () => {};
      }
      await wait(20_000);
      for (const master of networks.slice(0, 2))
        for (const workerID of workerIDs)
          assert(
            master
              .snapshot()
              .nearby.some((node) => node.id === workerID && node.online && node.channelReady),
            'Authenticated directory heartbeats must keep a live Worker online without discovery refresh',
          );

      const stoppedBrainID = networks[0].snapshot().brains.find((brain) => brain.hosted)!.id;
      await networks[0].stop();
      const offlineDeadline = Date.now() + 5_000;
      while (
        Date.now() < offlineDeadline &&
        networks[2].snapshot().brains.find((brain) => brain.id === stoppedBrainID)?.online
      )
        await wait(100);
      assert.equal(
        networks[2].snapshot().brains.find((brain) => brain.id === stoppedBrainID)?.online,
        false,
      );
      const survivingBrain = networks[1].snapshot().brains.find((brain) => brain.hosted);
      assert.equal(survivingBrain?.online, true);
      assert(survivingBrain?.workers.some((worker) => workerIDs.includes(worker.nodeID)));
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
      if (previousMdns === undefined) delete process.env.RIVLOOM_MDNS_NETWORK;
      else process.env.RIVLOOM_MDNS_NETWORK = previousMdns;
      if (previousPort === undefined) delete process.env.RIVLOOM_DISCOVERY_PORT;
      else process.env.RIVLOOM_DISCOVERY_PORT = previousPort;
    }
  },
);

test(
  'offline pending Execution retries, late acceptance is fenced, accepted unknown waits',
  { skip: process.platform !== 'win32', timeout: 90_000 },
  async () => {
    const previousMdns = process.env.RIVLOOM_MDNS_NETWORK;
    const previousPort = process.env.RIVLOOM_DISCOVERY_PORT;
    process.env.RIVLOOM_MDNS_NETWORK = 'disabled';
    process.env.RIVLOOM_DISCOVERY_PORT = String(await availableUdpPort());
    const roots = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), 'rivloom-fault-')));
    loadNodeIdentity(roots[0]);
    const networks = roots.map((root) => new NodeNetwork(root, true));
    const [master, ...workers] = networks;
    const until = async (check: () => boolean, label: string, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      while (!check() && Date.now() < deadline) await wait(50);
      assert(check(), label);
    };
    try {
      for (const worker of workers)
        worker.setWorkerRegistrationProvider((nodeID) => {
          const report = workerFixture(nodeID);
          report.load.sampledAt = new Date().toISOString();
          return report;
        });
      await Promise.all(networks.map((network) => network.start()));
      for (const worker of workers) await pairNetworks(master, worker);
      await until(
        () =>
          workers.every((worker) =>
            master
              .snapshot()
              .brains.find((brain) => brain.hosted)
              ?.workers.some((report) => report.nodeID === worker.snapshot().local!.id),
          ),
        'two Workers registered',
      );
      await master.createScheduledTask({
        title: '故障注入',
        description: '不运行工具',
        criteria: '旧 Execution 不会启动，接受未知不重派',
        requestedProjectID: null,
        requirements: {},
      });
      const initial = master.snapshot().brainTasks[0];
      assert(initial.executionID);
      const first = workers.find(
        (worker) => worker.snapshot().local!.id === initial.selectedWorkerID,
      )!;
      const second = workers.find((worker) => worker !== first)!;
      await until(() => !!first.remoteTask(initial.executionID!), 'first offer delivered');
      // Acceptance has been persisted locally, but its network response has not left the Worker.
      const firstStore = (first as unknown as { remoteTasks: RemoteTaskStore }).remoteTasks;
      firstStore.decide(initial.executionID, 'accepted');
      // Lose only the cancellation packet. The late acceptance still travels over real encrypted HTTP.
      const faultMaster = master as unknown as {
        sendChannelEvent(node: unknown, message: { type: string; taskID?: string }): Promise<void>;
      };
      const originalSend = faultMaster.sendChannelEvent.bind(master);
      faultMaster.sendChannelEvent = async (node, message) => {
        if (message.type === 'remote-task-cancel' && message.taskID === initial.executionID)
          throw new Error('test fault: cancellation packet lost');
        return originalSend(node, message);
      };
      await first.stop();
      await until(
        () => master.snapshot().brainTasks[0]?.executionAttempt === 2,
        'pending offline retries',
      );
      const retried = master.snapshot().brainTasks[0];
      assert.notEqual(retried.executionID, initial.executionID);
      assert.equal(retried.selectedWorkerID, second.snapshot().local!.id);
      assert.equal(retried.brainID, initial.brainID);
      await first.start();
      await until(
        () => !!first.remoteTask(initial.executionID!)?.deliveryError,
        'late acceptance rejected',
        25_000,
      );
      assert.equal(master.remoteTask(initial.executionID)?.status, 'cancelled');
      assert.equal(first.remoteTask(initial.executionID)?.localTaskID, null);
      assert.throws(() => firstStore.bindLocalTask(initial.executionID!, randomUUID()), /同步/);
      faultMaster.sendChannelEvent = originalSend;
      await until(() => !!second.remoteTask(retried.executionID!), 'second offer delivered');
      await second.respondRemoteTask(retried.executionID!, 'accepted');
      await until(
        () => master.remoteTask(retried.executionID!)?.status === 'accepted',
        'acceptance acknowledged',
      );
      await second.stop();
      await until(
        () => master.snapshot().brainTasks[0]?.status === 'waiting',
        'accepted unknown waits',
      );
      await wait(5500); // Cross a real scheduler tick with the other Worker available.
      const unknown = master.snapshot().brainTasks[0];
      assert.equal(unknown.executionAttempt, 2);
      assert.equal(unknown.executionID, retried.executionID);
      assert.match(unknown.executionSummary, /结果未知/);
      await assert.rejects(master.cancelRemoteTask(retried.executionID!), /已接受/);
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
      if (previousMdns === undefined) delete process.env.RIVLOOM_MDNS_NETWORK;
      else process.env.RIVLOOM_MDNS_NETWORK = previousMdns;
      if (previousPort === undefined) delete process.env.RIVLOOM_DISCOVERY_PORT;
      else process.env.RIVLOOM_DISCOVERY_PORT = previousPort;
    }
  },
);

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
    const unsent = owner.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '未提交 Execution',
      description: '验证 Brain Task 持久化失败时不会遗留可发送的孤儿 Execution。',
      criteria: '只有尚未发送且未开始的记录可以安全删除。',
    });
    assert(owner.discardUnsent(unsent.id));
    assert(!owner.list().some((task) => task.id === unsent.id));
    const requestedProjectID = randomUUID();
    const created = owner.create('A'.repeat(32), randomUUID(), 'B'.repeat(32), randomUUID(), {
      title: '检查构建失败',
      description: '请先复现失败并说明原因，不要开始执行工具。',
      criteria: '双方确认任务范围后再选择项目和模型。',
      requestedProjectID,
      requirements: { minimumLogicalCores: 8, minimumMemoryBytes: 16 * 1024 ** 3 },
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
    assert.equal(target.list()[0].requestedProjectID, requestedProjectID);
    assert.deepEqual(target.list()[0].requirements, {
      minimumLogicalCores: 8,
      minimumMemoryBytes: 16 * 1024 ** 3,
    });
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
        'requestedProjectID',
        'requirements',
        'localTaskID',
        'executionState',
        'executionSequence',
        'executionSummary',
        'remoteApprovals',
        'remoteQuestions',
        'remoteArtifacts',
        'remoteDiffSource',
        'pendingControl',
        'incomingControls',
        'appliedControlIDs',
      ])
        delete task[key];
    writeFileSync(legacyPath, JSON.stringify(legacyValue, null, 2));
    const migrated = new RemoteTaskStore(roots[2]);
    migrated.load();
    assert.equal(migrated.list()[0].executionStatus, 'unprepared');
    assert.equal(migrated.list()[0].automaticEligible, false);
    assert.equal(JSON.parse(readFileSync(legacyPath, 'utf8')).version, 7);

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
    const legacyExecution = structuredClone(readyExecution) as Record<string, unknown>;
    delete legacyExecution.approvals;
    delete legacyExecution.questions;
    delete legacyExecution.artifacts;
    delete legacyExecution.diffSource;
    assert(validRemoteTaskExecution(legacyExecution));
    assert.equal(owner.receiveExecution(legacyExecution), true);
    assert.equal(owner.receiveExecution(readyExecution), false);
    target.markDelivered(executing.id, readyExecution);
    target.updateLocalExecution(localTaskID, 'running', 'OpenCode 正在执行任务。');
    const runningExecution = target.message(executing.id);
    assert(validRemoteTaskExecution(runningExecution));
    assert.equal(owner.receiveExecution(runningExecution), true);
    target.markDelivered(executing.id, runningExecution);
    assert.equal(owner.list().find((task) => task.id === executing.id)?.executionState, 'running');
    target.updateLocalExecution(localTaskID, 'waiting_approval', '等待归属 Brain 审批。', [
      { id: 'permission-1', permission: 'edit', patterns: ['<project>/RESULT.txt'], metadata: {} },
    ]);
    const approvalExecution = target.message(executing.id);
    assert(validRemoteTaskExecution(approvalExecution));
    assert.equal(owner.receiveExecution(approvalExecution), true);
    target.markDelivered(executing.id, approvalExecution);
    const approvalSnapshot = owner.list().find((task) => task.id === executing.id)!;
    assert.equal(approvalSnapshot.remoteApprovals[0]?.patterns[0], '<project>/RESULT.txt');
    owner.requestControl(executing.id, approvalSnapshot.executionSequence, {
      kind: 'permission',
      requestID: 'permission-1',
      reply: 'once',
    });
    const approvalControl = owner.message(executing.id);
    assert(validRemoteTaskControl(approvalControl));
    assert.equal(target.receiveControl(approvalControl), true);
    assert.equal(target.receiveControl(approvalControl), false);
    owner.markDelivered(executing.id, approvalControl);
    assert.equal(target.pendingIncomingControls()[0]?.control.controlID, approvalControl.controlID);
    assert(target.finishIncomingControl(executing.id, approvalControl.controlID));
    assert.equal(target.pendingIncomingControls().length, 0);
    target.updateLocalExecution(
      localTaskID,
      'review',
      '结果等待归属 Brain 验收。',
      [],
      [],
      [
        {
          file: 'RESULT.txt',
          patch: '@@ -0,0 +1 @@\n+verified',
          additions: 1,
          deletions: 0,
          status: 'added',
        },
      ],
      'OpenCode 会话差异',
    );
    const reviewExecution = target.message(executing.id);
    assert(validRemoteTaskExecution(reviewExecution));
    assert.equal(owner.receiveExecution(reviewExecution), true);
    target.markDelivered(executing.id, reviewExecution);
    const reviewSnapshot = owner.list().find((task) => task.id === executing.id)!;
    assert.equal(reviewSnapshot.remoteArtifacts[0]?.file, 'RESULT.txt');
    assert.equal(reviewSnapshot.remoteDiffSource, 'OpenCode 会话差异');
    owner.requestControl(executing.id, reviewSnapshot.executionSequence, {
      kind: 'supplement',
      text: '请补充一条边界测试。',
    });
    const supplementControl = owner.message(executing.id);
    assert(validRemoteTaskControl(supplementControl));
    assert.equal(target.receiveControl(supplementControl), true);
    owner.markDelivered(executing.id, supplementControl);
    assert(
      owner
        .list()
        .find((task) => task.id === executing.id)
        ?.description.includes('边界测试'),
    );
    assert(
      target
        .list()
        .find((task) => task.id === executing.id)
        ?.description.includes('边界测试'),
    );
    owner.requestControl(executing.id, reviewSnapshot.executionSequence, {
      kind: 'accept',
      note: '已核对差异和验收标准。',
    });
    const acceptanceControl = owner.message(executing.id);
    assert(validRemoteTaskControl(acceptanceControl));
    assert.equal(
      validRemoteTaskControl({
        ...acceptanceControl,
        action: { ...acceptanceControl.action, extra: true },
      }),
      false,
    );
    assert.throws(() => target.receiveControl(acceptanceControl), /上一项远程操作仍在执行/);
    assert(target.finishIncomingControl(executing.id, supplementControl.controlID));
    assert.equal(target.receiveControl(acceptanceControl), true);
    owner.markDelivered(executing.id, acceptanceControl);
    assert(target.finishIncomingControl(executing.id, acceptanceControl.controlID));
    owner.requestControl(executing.id, reviewSnapshot.executionSequence, {
      kind: 'accept',
      note: '验证过期验收控制不会在重启后执行。',
    });
    const ownerStorePath = join(roots[0], 'remote-task-invites.json');
    const staleControlStore = JSON.parse(readFileSync(ownerStorePath, 'utf8'));
    const staleControlTask = staleControlStore.tasks.find(
      (task: { id: string }) => task.id === executing.id,
    );
    staleControlTask.pendingControl.issuedAt = new Date(
      Date.now() - 24 * 60 * 60_000 - 1000,
    ).toISOString();
    writeFileSync(ownerStorePath, JSON.stringify(staleControlStore, null, 2));
    const staleControlReload = new RemoteTaskStore(roots[0]);
    staleControlReload.load();
    const staleControlSnapshot = staleControlReload
      .list()
      .find((task) => task.id === executing.id)!;
    assert.equal(staleControlSnapshot.controlPending, false);
    assert.equal(staleControlSnapshot.deliveryPending, false);
    assert.match(staleControlSnapshot.deliveryError || '', /已过期/);
    assert.throws(
      () =>
        owner.requestControl(executing.id, approvalSnapshot.executionSequence - 1, {
          kind: 'stop',
        }),
      /状态已经更新/,
    );
    assert.throws(() => owner.cancel(executing.id), /停止操作/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('execution policy trusts paired senders and persists the local AI approval mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-execution-policy-'));
  try {
    const store = new ExecutionPolicyStore(root);
    store.load();
    assert.equal(store.snapshot().enabled, false);
    const projectID = randomUUID();
    store.save({
      enabled: true,
      approvalMode: 'auto',
      projectID,
      model: 'opencode/mimo-v2.5-free',
    });
    assert(store.allows());
    assert.equal(store.snapshot().approvalMode, 'auto');
    store.save({
      enabled: true,
      approvalMode: 'full',
      projectID,
      model: 'opencode/mimo-v2.5-free',
    });
    const reloaded = new ExecutionPolicyStore(root);
    reloaded.load();
    assert.equal(reloaded.snapshot().approvalMode, 'full');
    assert(reloaded.allows());
    reloaded.save({
      enabled: false,
      approvalMode: 'ask',
      projectID: null,
      model: null,
    });
    assert.equal(reloaded.allows(), false);
    writeFileSync(
      join(root, 'execution-policy.json'),
      JSON.stringify({
        version: 1,
        policy: {
          enabled: true,
          mode: 'limited',
          projectID,
          model: 'opencode/mimo-v2.5-free',
          allowedNodeIDs: ['T'.repeat(32)],
          maxConcurrent: 1,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    const migrated = new ExecutionPolicyStore(root);
    migrated.load();
    assert.equal(migrated.snapshot().approvalMode, 'ask');
    assert.equal(migrated.allows(), false);
    assert.equal(migrated.snapshot().projectID, null);
    assert.equal(migrated.snapshot().model, null);
    const migratedFile = JSON.parse(readFileSync(join(root, 'execution-policy.json'), 'utf8'));
    assert.equal(migratedFile.version, 2);
    assert.equal('mode' in migratedFile.policy, false);
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
  { skip: process.platform !== 'win32', timeout: 60_000 },
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

      const higherIndex = snapshots[0].local!.id.localeCompare(snapshots[1].local!.id) > 0 ? 0 : 1;
      const lowerIndex = higherIndex === 0 ? 1 : 0;
      const higherNetwork = networks[higherIndex] as unknown as {
        closeChannel(nodeID: string): void;
      };
      higherNetwork.closeChannel(snapshots[lowerIndex].local!.id);
      assert.equal(networks[higherIndex].snapshot().nearby[0].channelReady, false);
      assert.equal(networks[lowerIndex].snapshot().nearby[0].channelReady, true);
      await waitForSecureChannels(networks);

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
        hostedBrains: snapshots[initiatorIndex].local!.brains.filter(
          (brain) => brain.masterNodeID === snapshots[initiatorIndex].local!.id,
        ),
        worker: null,
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
      assert((directory.brains?.length || 0) >= 1);
      const misboundDirectory = encryptChannelPayload(manualChannel, {
        type: 'brain-directory-request',
        requestID: randomUUID(),
        capabilities: ['brain', 'executor', 'human-ui'],
        brains: snapshots[initiatorIndex].local!.brains,
        hostedBrains: snapshots[initiatorIndex].local!.brains.filter(
          (brain) => brain.masterNodeID === snapshots[initiatorIndex].local!.id,
        ),
        worker: workerFixture('Z'.repeat(32)),
      });
      assert.equal(
        (
          await fetch(`${channelUrl}/v1/channel/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(misboundDirectory),
          })
        ).status,
        409,
      );
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
