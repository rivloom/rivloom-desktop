// Read-only live observation of the existing physical acceptance instances.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ServiceClient } from './m34-fixtures.ts';
import { physicalSessionIDs } from './m34-physical-resume.ts';

const masterID = 'tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7';
const joiningID = 'As64SUH5wlu5deeBDPuHLsE47DWempcQ';
const workerID = 't9MUCFG44Q3nM4txwjG3UPI7mbwePMsM';
const brainID = '0ed79cba-4ed8-4373-ad3f-1dfc4a695800';
const taskID = '45b70f73-e911-4f65-8e75-db31c3efa2fa';
const executionID = '2414f24a-a968-4e19-8b5d-24b493e7db4e';
const businessID = '503ce474-6c44-4152-b8db-4f31015595be';
const sessionID = 'ses_f9f184136ffexqtgBdYAJ7vpb4';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const observation = read(resolve('.data/verification/m34-physical-worker.json'));
assert.equal(observation.version, '0.1.3');
assert.equal(observation.nodeID, workerID);
assert.equal(observation.modelRequests, 0);
const master = new ServiceClient(
  join(process.env.LOCALAPPDATA!, 'com.rivloom.desktop', 'workspace'),
);
const desktop = read(join(master.root, 'desktop-runtime.json'));
assert.equal(desktop.version, '0.1.3');
master.base = desktop.url;
const worker = new ServiceClient(join(observation.root, 'worker'));
worker.base = observation.apiURL;
const report = {
  kind: 'Physical 0.1.3 upgrade retention and original Worker recovery; not dual-Brain acceptance',
  startedAt: new Date().toISOString(),
  finishedAt: '',
  passed: false,
  error: '',
  durationMs: 0,
  samples: 0,
  resourceUpdates: 0,
  maximumResourceAgeMs: 0,
  versions: {
    localDesktop: desktop.version,
    worker: observation.version,
    remoteDesktop: 'User-reported 0.1.3; executable not independently read',
  },
  ports: {
    masterApplication: Number(new URL(master.base).port),
    masterPeer: 0,
    joiningPeer: 0,
    workerApplication: Number(new URL(worker.base).port),
    workerPeer: observation.peerPort,
    workerEngine: observation.enginePort,
  },
  identities: {
    masterID,
    joiningID,
    workerID,
    brainID,
    taskID,
    executionID,
    businessID,
    sessionID,
  },
  modelRequestsAtStartup: observation.modelRequests,
  modelRequestsAfterObservation: null as number | null,
};
try {
  await Promise.all([master.authenticate(), worker.authenticate()]);
  const started = Date.now();
  const updates = new Set<string>();
  do {
    const [m, w, state] = await Promise.all([
      master.network(),
      worker.network(),
      worker.bootstrap(),
    ]);
    assert.equal(m.local?.id, masterID);
    assert.equal(w.local?.id, workerID);
    for (const [network, peers] of [
      [m, [joiningID, workerID]],
      [w, [masterID, joiningID]],
    ] as const)
      for (const id of peers)
        assert(
          network.nearby.some(
            (peer) => peer.id === id && peer.online && peer.trusted && peer.channelReady,
          ),
          `Original trusted channel lost: ${id}`,
        );
    assert.equal(m.brains.filter((brain) => brain.hosted).length, 1);
    assert.equal(w.brains.filter((brain) => brain.hosted).length, 0);
    const brain = m.brains.find((brain) => brain.id === brainID && brain.hosted)!;
    assert(brain?.online && brain.state === 'established');
    const resource = brain.workers.find((item) => item.nodeID === workerID)!;
    assert(resource?.accepting);
    assert.equal(resource.load.runningTasks, 0);
    assert.equal(resource.load.availableSlots, 1);
    assert(resource.hardware.logicalCores > 0 && resource.hardware.memoryBytes > 0);
    const age = Date.now() - Date.parse(resource.load.sampledAt);
    assert(age >= -60_000 && age < 15_000, 'Worker resource report is stale');
    report.maximumResourceAgeMs = Math.max(report.maximumResourceAgeMs, age);
    updates.add(resource.load.sampledAt);
    const task = m.brainTasks.find((item) => item.id === taskID)!;
    assert.equal(task?.status, 'completed');
    assert.equal(task.brainID, brainID);
    assert.equal(task.executionID, executionID);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, businessID);
    assert.equal(state.tasks[0].state, 'accepted');
    assert.equal(state.tasks[0].sessionID, sessionID);
    assert.equal(state.projects.length, 2);
    assert.deepEqual(
      w.remoteTasks.map((item) => item.id).sort(),
      [executionID, '44b41f60-dc4c-4427-9e62-a20a5716ea47'].sort(),
    );
    report.ports.masterPeer = m.local!.port;
    report.ports.joiningPeer = m.nearby.find((peer) => peer.id === joiningID)!.port;
    assert(
      Object.values(report.ports).every(
        (port) => Number.isInteger(port) && port >= 49152 && port <= 65535,
      ),
    );
    report.samples++;
    await wait(1000);
    report.durationMs = Date.now() - started;
  } while (report.durationMs < 90_000);
  assert(updates.size >= 10, 'Dynamic resources did not refresh');
  report.resourceUpdates = updates.size;
  assert.deepEqual(physicalSessionIDs(worker.root), [sessionID]);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve('.data/verification/m34-physical-upgrade-0.1.3.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
