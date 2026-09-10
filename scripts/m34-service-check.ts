// Complete services, three isolated databases, official OpenCode; model replies are local fixtures.
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';

const clockArgument = process.argv.find((value) => value.startsWith('--master-clock-offset='));
const masterClockOffset = clockArgument ? Number(clockArgument.split('=')[1]) : undefined;
assert(
  masterClockOffset === undefined ||
    (Number.isSafeInteger(masterClockOffset) && Math.abs(masterClockOffset) <= 60_000),
);
const runtimeArgument = process.argv.find((value) => value.startsWith('--runtime-directory='));
const runtimeDirectory = runtimeArgument
  ? resolve(runtimeArgument.slice('--runtime-directory='.length))
  : undefined;
const root = resolve('.data', 'm34-service', String(Date.now()));
const clients = ['master-a', 'master-b', 'worker'].map(
  (name) => new ServiceClient(join(root, name)),
);
const fixture = await modelFixture();
const proof: Record<string, unknown> = {
  at: new Date().toISOString(),
  root,
  runtimeDirectory: runtimeDirectory || resolve('.'),
  masterClockOffsetMilliseconds: masterClockOffset ?? 0,
  workerClockOffsetMilliseconds: 0,
  workerRelativeClockOffsetMilliseconds: -(masterClockOffset ?? 0),
  kind: 'three full services / official OpenCode / deterministic loopback model (not live AI)',
  assertions: [],
};
function pass(message: string) {
  (proof.assertions as string[]).push(message);
  console.log('PASS', message);
}
try {
  for (const client of clients) fixture.configure(client.root);
  clients.slice(0, 2).forEach((client) => loadNodeIdentity(client.root));
  await Promise.all(
    clients.map((client, index) =>
      client.start({
        runtimeDirectory,
        // Keep the executing backend and its official engine on the same local clock.
        clockOffsetMilliseconds: index < 2 ? masterClockOffset : undefined,
      }),
    ),
  );
  const [left, right, worker] = clients;
  if (masterClockOffset !== undefined) {
    for (const master of [left, right]) {
      const injected = master.output.match(/RIVLOOM_TEST_CLOCK_OFFSET (-?\d+) (-?\d+)/);
      assert(injected, 'Clock preload ran only in the isolated Master processes');
      assert.equal(Number(injected[1]), masterClockOffset);
      assert(Math.abs(Number(injected[2]) - masterClockOffset) <= 100);
    }
    assert(!worker.output.includes('RIVLOOM_TEST_CLOCK_OFFSET'));
    pass(
      `Both isolated Masters clock offset ${masterClockOffset} ms confirmed; Worker and its official engine share the unchanged system clock`,
    );
  }
  const directory = join(worker.root, 'authorized-folder');
  mkdirSync(directory);
  const project = await worker.call(
    '/projects',
    { name: 'M3.4 plain folder', directory, trusted: true },
    201,
  );
  await worker.call('/network/execution-policy', {
    maxConcurrent: 1,
    enabled: true,
    projectID: project.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  });
  await pairServices(left, worker);
  await pairServices(right, worker);
  const workerID = (await worker.network()).local!.id;
  for (const master of [left, right])
    await until(
      () => master.network(),
      (network) =>
        network.brains.some(
          (brain) =>
            brain.hosted &&
            brain.workers.some(
              (item) =>
                item.nodeID === workerID && item.accepting && item.load.availableSlots === 1,
            ),
        ),
      'shared slot report',
    );
  const masterBrains = await Promise.all(
    [left, right].map(
      async (client) => (await client.network()).brains.find((brain) => brain.hosted)!.id,
    ),
  );
  assert.notEqual(masterBrains[0], masterBrains[1]);
  pass('Two independent established Brains share one real Worker and keep separate databases');
  for (let sample = 0; sample < 180; sample += 1) {
    await wait(500);
    for (const master of [left, right]) {
      const network = await master.network();
      assert(
        network.nearby.find((node) => node.id === workerID)?.channelReady,
        'Hardware sampling must not interrupt encrypted heartbeats',
      );
      assert(
        network.brains
          .find((brain) => brain.hosted)
          ?.workers.some((item) => item.nodeID === workerID && item.load.availableSlots === 1),
      );
    }
  }
  pass(
    'Real hardware sampling keeps shared Worker channels and slot reports stable over 90 seconds (crossing the rate-limit window)',
  );
  await Promise.all(
    [left, right].map((master, index) =>
      master.call(
        '/network/tasks',
        {
          title: `M3.4 slot contender ${index}`,
          description: 'Reply briefly. Do not call tools or modify files.',
          criteria: 'Return a short text',
          confirmed: true,
          requestedProjectID: null,
          requirements: {},
        },
        201,
      ),
    ),
  );
  const workerState = await until(
    () => worker.bootstrap(),
    (state) =>
      state.tasks.length === 1 && !!state.tasks[0].sessionID && state.tasks[0].state === 'running',
    'one official session',
  );
  await until(
    async () =>
      (await Promise.all([left.network(), right.network()])).flatMap(
        (network) => network.brainTasks,
      ),
    (tasks) =>
      tasks.length === 2 &&
      tasks.filter((task) => task.status === 'queued').length === 1 &&
      tasks.filter((task) => task.status === 'running').length === 1,
    'loser queued, winner running',
  );
  const running = workerState.tasks[0];
  await until(
    async () => fixture.requests,
    (count) => count >= 1,
    'official engine called only local fixture',
  );
  const db = new DatabaseSync(join(worker.root, 'engine', 'data', 'opencode', 'opencode.db'), {
    readOnly: true,
  });
  try {
    const sessions = db.prepare('SELECT id FROM session').all();
    assert.deepEqual(
      sessions.map((session) => session.id),
      [running.sessionID],
    );
  } finally {
    db.close();
  }
  proof.sessionID = running.sessionID;
  proof.taskID = running.id;
  pass(
    'Simultaneous offers create exactly one business Task and exactly one official OpenCode session',
  );
  const portable = workerState.projects.find((candidate) => candidate.id === running.projectID)!;
  assert(portable.directory.startsWith(join(worker.root, 'portable-tasks')));
  assert(!existsSync(join(portable.directory, '.git')));
  assert(!existsSync(join(directory, '.git')));
  pass(
    'Portable Task runs in an ordinary per-Execution folder; authorized Project is not copied or initialized with Git',
  );
  const operator = (await worker.bootstrap()).user;
  const local = await worker.call(
    '/tasks',
    {
      projectID: project.id,
      title: 'Local slot contender',
      description: 'Reply briefly without tools',
      criteria: 'Local execution is independent of incoming capacity',
      assigneeID: operator.id,
      approverID: operator.id,
      reviewerID: operator.id,
      model: 'fixture/m34',
      approvalMode: 'ask',
    },
    201,
  );
  await worker.call(`/tasks/${local.id}/claim`, {});
  await worker.call(`/tasks/${local.id}/run`, { confirmed: true });
  assert((await worker.call(`/tasks/${local.id}`)).task.sessionID);
  pass('Local manual start runs independently while the configured incoming slot remains reserved');
  fixture.release();
  await until(
    () => worker.bootstrap(),
    (state) => state.tasks.find((task) => task.id === running.id)?.state === 'accepted',
    'first result completes automatically',
  );
  await until(
    async () =>
      (await Promise.all([left.network(), right.network()])).flatMap(
        (network) => network.brainTasks,
      ),
    (tasks) => tasks.length === 2 && tasks.every((task) => task.status === 'completed'),
    'both Brains complete their original tasks',
  );
  const report = await until(
    () => worker.network(),
    (network) =>
      network.local?.worker?.load.availableSlots === 1 &&
      network.local.worker.load.runningTasks === 0,
    'completed tasks release all capacity',
  );
  assert.equal(report.local!.worker!.load.availableSlots, 1);
  pass(
    'Successful tasks complete automatically; the queued Brain proceeds and the Worker releases capacity',
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
  await Promise.all(clients.map((client) => client.stop()));
  await fixture.close();
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
  writeFileSync(
    resolve(
      '.data',
      'verification',
      masterClockOffset === undefined
        ? 'm34-service.json'
        : `m34-service-master-clock-${masterClockOffset}.json`,
    ),
    JSON.stringify(proof, null, 2),
  );
}
