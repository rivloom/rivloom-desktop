// Physical acceptance helper, not a product entry point. Never controls the existing desktops.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ServiceClient, modelFixture, until } from './m34-fixtures.ts';
import {
  checkPhysicalResume,
  inspectPhysicalHistory,
  physicalSessionIDs,
} from './m34-physical-resume.ts';

const runtime = dirname(process.execPath);
const version = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
const expectedVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
assert.equal(
  version,
  expectedVersion,
  `Run with the installed Rivloom ${expectedVersion} runtime/node.exe`,
);
assert.equal(
  JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).name,
  'rivloom-desktop-runtime',
  'Only an installed Rivloom runtime is allowed',
);
assert.equal(process.platform, 'win32');
// Identity, not the currently selected LAN/virtual-adapter address, defines the allowed peers.
const args = process.argv.slice(2);
const resumeArgs = args.filter((arg) => arg.startsWith('--resume-root='));
const identityArgs = args.filter((arg) => arg.startsWith('--expect-node='));
assert(
  resumeArgs.length <= 1 && identityArgs.length === resumeArgs.length,
  'Resume requires one --resume-root and one --expect-node',
);
const allowedPeerIDs = new Set(
  args.filter((arg) => !arg.startsWith('--resume-root=') && !arg.startsWith('--expect-node=')),
);
assert(
  allowedPeerIDs.size === 2 &&
    [...allowedPeerIDs].every((nodeID) => /^[A-Za-z0-9_-]{32}$/.test(nodeID)),
  'Pass the two verified physical-device Node IDs as arguments',
);
const root = resumeArgs.length
  ? resolve(resumeArgs[0].slice('--resume-root='.length))
  : resolve('.data', 'm34-physical', randomUUID());
const resumed = resumeArgs.length
  ? checkPhysicalResume(root, identityArgs[0].slice('--expect-node='.length))
  : null;
const report = resolve('.data', 'verification', 'm34-physical-worker.json');
const worker = new ServiceClient(join(root, 'worker'));
const fixture = await modelFixture(600_000);
let projectID = resumed?.projectID || '';
let stopped = false;
const input = createInterface({ input: process.stdin, terminal: false });

async function status() {
  const network = await worker.network();
  const state = await worker.bootstrap();
  const value = {
    at: new Date().toISOString(),
    kind: 'Physical acceptance worker observation; not a completed acceptance report',
    version,
    runtime,
    root,
    resumed: !!resumed,
    fixturePID: process.pid,
    workerPID: worker.child?.pid,
    apiURL: worker.base,
    peerPort: network.local?.port,
    enginePort: Number(
      worker.output.match(/RIVLOOM_ENGINE_READY http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
    ),
    nodeID: network.local?.id,
    name: network.local?.name,
    projectID,
    localWorker: network.local?.worker,
    brains: network.brains.map((brain) => ({
      id: brain.id,
      hosted: brain.hosted,
      state: brain.state,
      masterNodeID: brain.masterNodeID,
      online: brain.online,
      workers: brain.workers.map((item) => ({
        nodeID: item.nodeID,
        accepting: item.accepting,
        availableSlots: item.load.availableSlots,
        sampledAt: item.load.sampledAt,
      })),
    })),
    nearby: network.nearby.map((node) => ({
      id: node.id,
      name: node.name,
      addresses: node.addresses,
      online: node.online,
      trusted: node.trusted,
      channelReady: node.channelReady,
    })),
    pairings: network.pairings.map((pairing) => ({
      id: pairing.id,
      nodeID: pairing.nodeID,
      localConfirmed: pairing.localConfirmed,
      remoteConfirmed: pairing.remoteConfirmed,
      expiresAt: pairing.expiresAt,
    })),
    tasks: state.tasks.map((task) => ({
      id: task.id,
      sessionID: task.sessionID,
      state: task.state,
    })),
    sessionIDs: physicalSessionIDs(worker.root),
    remoteExecutions: network.remoteTasks.map((task) => ({
      id: task.id,
      brainTaskID: task.brainTaskID,
      ownerNodeID: task.ownerNodeID,
      ownerBrainID: task.ownerBrainID,
      targetNodeID: task.targetNodeID,
      status: task.status,
    })),
    modelRequests: fixture.requests,
  };
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify(value, null, 2));
  console.log('STATUS', JSON.stringify(value));
}

async function pair(nodeID: string) {
  assert(allowedPeerIDs.has(nodeID), 'Only the two explicitly verified Node IDs are in scope');
  const network = await worker.network();
  const peer = network.nearby.find((node) => node.id === nodeID && node.online);
  assert(peer, 'The exact peer must already be discovered and online');
  assert(!peer.trusted, 'Already trusted; no new pairing is needed');
  await worker.call('/network/pairings', { nodeID }, 201);
  const pairing = (await worker.network()).pairings.find((item) => item.nodeID === nodeID)!;
  assert(pairing);
  console.log(
    'PAIRING_CHECK',
    JSON.stringify({ nodeID, name: peer.name, pairingID: pairing.id, code: pairing.code }),
  );
  // Confirm only this test Worker's side; the user must compare and confirm in the real desktop.
  await worker.call(`/network/pairings/${pairing.id}/confirm`, {});
  console.log('WORKER_CONFIRMED; waiting for the user on the physical desktop');
}

try {
  fixture.configure(worker.root);
  await worker.start({ runtimeDirectory: runtime });
  if (resumed) {
    const network = await worker.network();
    const state = await worker.bootstrap();
    assert.equal(network.local?.id, resumed.nodeID);
    assert.deepEqual(
      inspectPhysicalHistory(
        worker.root,
        resumed.nodeID,
        projectID,
        state.projects,
        state.tasks,
        network.remoteTasks,
      ),
      resumed.history,
      'Resume must preserve original Projects, accepted tasks and execution ownership',
    );
    assert.deepEqual(
      physicalSessionIDs(worker.root),
      resumed.sessionIDs,
      'Resume must not create another session',
    );
  } else {
    const directory = join(worker.root, 'authorized-folder');
    mkdirSync(directory);
    const project = await worker.call(
      '/projects',
      { name: 'M3.4 物理验收专用文件夹', directory, trusted: true },
      201,
    );
    projectID = project.id;
    await worker.call('/network/execution-policy', {
      enabled: true,
      projectID,
      model: 'fixture/m34',
      approvalMode: 'ask',
      confirmed: true,
    });
  }
  await until(
    () => worker.network(),
    (network) =>
      !!network.local?.worker?.accepting && network.local.worker.load.availableSlots === 1,
    'one available physical-test Worker slot',
  );
  const network = await worker.network();
  const ports = [
    Number(new URL(worker.base).port),
    network.local?.port,
    Number(worker.output.match(/RIVLOOM_ENGINE_READY http:\/\/127\.0\.0\.1:(\d+)/)?.[1]),
  ];
  assert(
    ports.every(
      (port) =>
        typeof port === 'number' && Number.isInteger(port) && port >= 49152 && port <= 65535,
    ),
    'All physical Worker HTTP ports must be high',
  );
  assert.equal(fixture.requests, 0, 'Starting the Worker must not call a model');
  console.log('READY; commands: status | pair <NodeID> | release | stop');
  await status();
  for await (const line of input) {
    const command = line.trim();
    if (command === 'stop') break;
    try {
      if (command === 'status') await status();
      else if (command.startsWith('pair ')) await pair(command.slice(5));
      else if (command === 'release') {
        fixture.release();
        console.log('LOCAL MODEL RELEASED; no tools or user files will be changed');
      } else console.log('Commands: status | pair <NodeID> | release | stop');
    } catch (error) {
      console.error('COMMAND FAILED:', String(error));
    }
  }
} finally {
  input.close();
  try {
    await worker.stop();
    stopped = true;
  } finally {
    await fixture.close();
    console.log('CLEANUP', JSON.stringify({ stopped, root, modelRequests: fixture.requests }));
  }
}
