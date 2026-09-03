// Test-only lifecycle: fresh automatic formation, no identity/topology pre-seeding.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import type { NodeNetwork, Project } from '../shared/types.ts';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';
import { RaceController } from './m34-race.ts';

const runID = randomUUID();
const root = resolve('.data', 'm34-fresh-brains', runID);
const runtimeArgument = process.argv.find((arg) => arg.startsWith('--runtime-directory='));
assert(runtimeArgument, 'Pass the explicit versioned runtime directory');
const runtimeDirectory = resolve(runtimeArgument.slice('--runtime-directory='.length));
const clients = ['master-a', 'master-b', 'worker'].map(
  (name) => new ServiceClient(join(root, name)),
);
const [left, right, worker] = clients;
const scheduledRace = process.argv.includes('--scheduled-race');
const preparedRace = process.argv.includes('--prepared-race');
assert(!(scheduledRace && preparedRace), 'Select only one race coordination mode');
const raceControllers: RaceController[] = [];
const fixture = await modelFixture(600_000);
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  runID,
  root,
  runtimeDirectory,
  kind: 'one physical host / fresh automatic Brains / versioned runtime services / local model fixture',
  physicalDualBrainAcceptance: false,
  assertions: [],
  listeningPorts: [],
};
const pass = (message: string) => {
  (proof.assertions as string[]).push(message);
  console.log('PASS', message);
};
const owned = (network: NodeNetwork) =>
  network.brainTasks.filter((task) => task.direction === 'owned');
const identities = new Map<ServiceClient, { nodeID: string; brainID: string }>();
const projects = new Map<ServiceClient, Project>();
const ports = new Set<number>();
async function checkListeningPorts(client: ServiceClient) {
  const network = await client.network();
  const engine = client.output.match(/RIVLOOM_ENGINE_READY (http:\/\/127\.0\.0\.1:\d+)/);
  assert(engine, 'Official engine reported its validated URL');
  const record = {
    root: client.root,
    at: new Date().toISOString(),
    application: Number(new URL(client.base).port),
    peer: network.local!.port,
    engine: Number(new URL(engine[1]).port),
  };
  for (const port of [record.application, record.peer, record.engine])
    assert(Number.isInteger(port) && port >= 49152 && port <= 65535, `High HTTP port: ${port}`);
  (proof.listeningPorts as unknown[]).push(record);
}
async function unusedPort() {
  const socket = createSocket('udp4');
  await new Promise<void>((ok, fail) => {
    socket.once('error', fail);
    socket.bind(0, '0.0.0.0', ok);
  });
  const port = socket.address().port;
  await new Promise<void>((ok) => socket.close(ok));
  if (ports.has(port)) return unusedPort();
  ports.add(port);
  return port;
}
async function createTask(master: ServiceClient, title: string, projectID: string | null = null) {
  const network = await master.call<NodeNetwork>(
    '/network/tasks',
    {
      title,
      description: 'Reply briefly. Do not call tools or modify files.',
      criteria: 'Return only a short text; no tools or file changes.',
      requestedProjectID: projectID,
      requirements: {},
      confirmed: true,
    },
    201,
  );
  const matches = owned(network).filter((task) => task.title === title);
  assert.equal(
    matches.length,
    1,
    'Creation returns a network response containing the new owned Task',
  );
  return matches[0];
}
async function readTask(master: ServiceClient, id: string) {
  const task = owned(await master.network()).find((item) => item.id === id);
  assert(task, `Missing authoritative Task ${id}`);
  assert.equal(task.brainID, identities.get(master)!.brainID);
  assert.equal(task.masterNodeID, identities.get(master)!.nodeID);
  return task;
}
async function acceptFixtureTask(master: ServiceClient, id: string) {
  const task = await until(
    () => readTask(master, id),
    (item) => item.status === 'review',
    'review',
  );
  assert(task.executionID);
  await master.call(`/network/tasks/${task.executionID}/control`, {
    expectedExecutionSequence: task.executionSequence,
    action: {
      kind: 'accept',
      note: 'Accept only this isolated deterministic text regression task.',
    },
    confirmed: true,
  });
  return until(
    () => readTask(master, id),
    (item) => item.status === 'completed',
    'accepted test result',
  );
}
async function sharedSlot(master: ServiceClient, count: number) {
  return until(
    () => master.network(),
    (network) =>
      network.brains.some(
        (brain) =>
          brain.hosted &&
          brain.workers.some(
            (item) =>
              item.nodeID === identities.get(worker)!.nodeID &&
              item.accepting &&
              item.load.availableSlots === count,
          ),
      ),
    `shared slot ${count}`,
  );
}
function engineEvidence() {
  const db = new DatabaseSync(join(worker.root, 'engine', 'data', 'opencode', 'opencode.db'), {
    readOnly: true,
  });
  try {
    const sessions = db
      .prepare('SELECT id FROM session')
      .all()
      .map((row) => String(row.id));
    const toolParts = db
      .prepare('SELECT data FROM part')
      .all()
      .filter((row) => JSON.parse(String(row.data)).type === 'tool').length;
    return { sessions, toolParts };
  } finally {
    db.close();
  }
}

try {
  const runtimePackage = JSON.parse(readFileSync(join(runtimeDirectory, 'package.json'), 'utf8'));
  assert.equal(runtimePackage.name, 'rivloom-desktop-runtime');
  assert.equal(
    runtimePackage.version,
    JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version,
  );
  proof.runtimeVersion = runtimePackage.version;
  for (const client of clients) {
    assert(!existsSync(client.root));
    fixture.configure(client.root);
    assert(!existsSync(join(client.root, 'node-identity.json')));
    assert(!existsSync(join(client.root, 'brain-topology.json')));
  }
  const formation: unknown[] = [];
  await Promise.all(
    [left, right].map(async (master) => {
      const port = await unusedPort();
      await master.start({ runtimeDirectory, discovery: { port, mdns: false } });
      await checkListeningPorts(master);
      const initial = await master.network();
      assert.equal(initial.status, 'online');
      assert.equal(initial.nearby.length, 0);
      assert.equal(initial.brains.length, 1);
      assert.equal(
        initial.brains[0].state,
        'provisional',
        'Observe fresh state before automatic settlement',
      );
      const firstAt = new Date().toISOString();
      const settled = await until(
        () => master.network(),
        (network) => {
          assert.equal(network.nearby.length, 0);
          return network.brains[0]?.state === 'established';
        },
        'fresh isolated Brain settles',
      );
      assert.equal(settled.brains[0].id, initial.brains[0].id);
      assert(settled.brains[0].hosted);
      identities.set(master, { nodeID: settled.local!.id, brainID: settled.brains[0].id });
      formation.push({
        root: master.root,
        port,
        firstAt,
        settledAt: new Date().toISOString(),
        ...identities.get(master),
      });
      await master.stop();
    }),
  );
  proof.formation = formation;
  assert.notEqual(identities.get(left)!.brainID, identities.get(right)!.brainID);
  pass(
    'Two fresh roots each visibly progress provisional -> established without pre-created identity or topology',
  );

  const sharedPort = await unusedPort();
  proof.sharedDiscoveryPort = sharedPort;
  const start = async (client: ServiceClient) => {
    await client.start({ runtimeDirectory, discovery: { port: sharedPort, mdns: false } });
    await checkListeningPorts(client);
  };
  await Promise.all(clients.map(start));
  for (const master of [left, right]) {
    const network = await master.network();
    assert.equal(network.local!.id, identities.get(master)!.nodeID);
    assert.equal(network.brains.find((brain) => brain.hosted)?.id, identities.get(master)!.brainID);
  }
  identities.set(worker, { nodeID: (await worker.network()).local!.id, brainID: '' });
  for (const client of clients) {
    const directory = join(client.root, 'same-name-folder');
    mkdirSync(directory);
    projects.set(
      client,
      await client.call(
        '/projects',
        { name: 'Same name is not identity', directory, trusted: true },
        201,
      ),
    );
  }
  assert.equal(new Set([...projects.values()].map((project) => project.id)).size, 3);
  const project = projects.get(worker)!;
  await worker.call('/network/execution-policy', {
    enabled: true,
    projectID: project.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  });
  await pairServices(left, worker);
  await pairServices(right, worker);
  await Promise.all([left, right].map((master) => sharedSlot(master, 1)));
  await until(
    () => worker.network(),
    (network) =>
      network.brains.filter((brain) => brain.online).length === 2 &&
      !network.brains.some((brain) => brain.hosted),
    'Worker adopts both established Brains',
  );
  pass(
    'Unchanged established identities survive joining one discovery domain; fresh Worker joins both without creating a third Brain',
  );

  const stability = {
    startedAt: new Date().toISOString(),
    durationMilliseconds: 0,
    samples: 0,
    maxReportAgeMilliseconds: 0,
  };
  const since = performance.now();
  do {
    for (const master of [left, right]) {
      const network = await master.network();
      assert.equal(network.brains.filter((brain) => brain.hosted).length, 1);
      assert(
        network.nearby.find((node) => node.id === identities.get(worker)!.nodeID)?.channelReady,
      );
      const report = network.brains
        .find((brain) => brain.hosted)!
        .workers.find((item) => item.nodeID === identities.get(worker)!.nodeID)!;
      assert(report.accepting && report.load.availableSlots === 1);
      const age = Date.now() - Date.parse(report.load.sampledAt);
      assert(age >= -1000 && age <= 15_000);
      stability.maxReportAgeMilliseconds = Math.max(stability.maxReportAgeMilliseconds, age);
    }
    stability.samples += 1;
    await wait(500);
    stability.durationMilliseconds = Math.round(performance.now() - since);
  } while (stability.durationMilliseconds < 90_000);
  proof.stability = stability;
  pass('Both encrypted channels and shared slot reports remain stable for at least 90 seconds');

  await left.call(
    '/network/tasks',
    {
      title: 'Non-exported same-name Project must not match',
      description: 'Do not run',
      criteria: 'Reject placement',
      requestedProjectID: projects.get(left)!.id,
      requirements: {},
      confirmed: true,
    },
    409,
  );
  assert.equal(owned(await left.network()).length, 0);
  pass('A non-exported same-name Project is rejected instead of substituting the Worker Project');

  let tasks;
  if (scheduledRace || preparedRace) {
    const raceID = randomUUID();
    const fireAt = new Date(Date.now() + 7000).toISOString();
    if (preparedRace) {
      await worker.call('/network/execution-policy', {
        enabled: false,
        projectID: null,
        model: null,
        approvalMode: 'ask',
        confirmed: true,
      });
      await Promise.all(
        [left, right].map((master) =>
          until(
            () => master.network(),
            (network) => {
              const report = network.brains
                .find((b) => b.hosted)!
                .workers.find((w) => w.nodeID === identities.get(worker)!.nodeID);
              return !!report && !report.accepting && report.load.availableSlots === 0;
            },
            'closed Worker gate at both Masters',
          ),
        ),
      );
    }
    for (const [index, master] of [left, right].entries()) {
      const controller = new RaceController({
        client: master,
        role: index === 0 ? 'A' : 'B',
        ...identities.get(master)!,
        workerID: identities.get(worker)!.nodeID,
        ledgerDirectory: join(master.root, 'physical-races'),
      });
      raceControllers.push(controller);
      const output = (event: string, value: unknown) => console.log(event, JSON.stringify(value));
      if (preparedRace) await controller.command(`prepare ${raceID}`, output);
      else await controller.schedule(raceID, fireAt, output);
    }
    if (preparedRace) {
      await wait(750);
      proof.preparedBeforeRelease = await Promise.all(raceControllers.map((c) => c.status()));
      for (const controller of raceControllers)
        assert.equal(controller.records()[0].phase, 'prepared');
      for (const master of [left, right]) assert.equal(owned(await master.network()).length, 0);
      assert.equal((await worker.bootstrap()).tasks.length, 0);
      assert.equal(fixture.requests, 0);
      assert.equal(engineEvidence().sessions.length, 0);
      pass(
        'Both prepare commands persist intent with no Task/session/model request until the real Worker policy opens',
      );
      await worker.call('/network/execution-policy', {
        enabled: true,
        projectID: project.id,
        model: 'fixture/m34',
        approvalMode: 'ask',
        confirmed: true,
      });
    }
    await until(
      async () => raceControllers.map((c) => c.records()[0]),
      (records) => {
        assert(
          !records.some((r) => ['uncertain', 'missed', 'cancelled'].includes(r.phase)),
          'Race trigger failed; preserve evidence, no retry',
        );
        return records.every((r) => r.phase === 'submitted');
      },
      'both one-shot helper submissions',
      15000,
    );
    proof[preparedRace ? 'preparedRace' : 'scheduledRace'] = await Promise.all(
      raceControllers.map((c) => c.status()),
    );
    tasks = await Promise.all(
      [left, right].map((master, index) =>
        readTask(master, raceControllers[index].records()[0].taskID!),
      ),
    );
  } else
    tasks = await Promise.all(
      [left, right].map((master, index) =>
        createTask(master, `Fresh Brain contender ${index + 1}`),
      ),
    );
  const competing = await until(
    async () =>
      Promise.all([left, right].map((master, index) => readTask(master, tasks[index].id))),
    (items) =>
      items.filter((task) => task.status === 'running').length === 1 &&
      items.filter((task) => task.status === 'queued').length === 1,
    'one running Task and one queued Task',
  );
  const winnerIndex = competing.findIndex((task) => task.status === 'running');
  const loserIndex = 1 - winnerIndex;
  const winner = [left, right][winnerIndex];
  const loser = [left, right][loserIndex];
  const winnerTaskID = tasks[winnerIndex].id;
  const loserTaskID = tasks[loserIndex].id;
  const runningState = await worker.bootstrap();
  assert.equal(runningState.tasks.length, 1);
  assert(runningState.tasks[0].sessionID);
  assert.deepEqual(engineEvidence().sessions, [runningState.tasks[0].sessionID]);
  proof.competition = competing;
  pass(
    'Concurrent offers from distinct Brains produce one business Task/session and one queued Task with original ownership',
  );
  await until(
    async () => fixture.requests,
    (count) => count === 1,
    'fixture receives the one model request',
  );
  fixture.release();
  await until(
    () => readTask(winner, winnerTaskID),
    (task) => task.status === 'review',
    'winner review',
  );
  assert.equal((await worker.network()).local!.worker!.load.availableSlots, 0);
  assert.equal((await readTask(loser, loserTaskID)).status, 'queued');
  pass('Review keeps the only Worker slot occupied and the other Brain queued');

  const beforeStop = await readTask(loser, loserTaskID);
  await loser.stop();
  await until(
    () => worker.network(),
    (network) =>
      network.brains.some(
        (brain) => brain.id === identities.get(loser)!.brainID && !brain.online,
      ) &&
      network.brains.some((brain) => brain.id === identities.get(winner)!.brainID && brain.online),
    'only stopped Master Brain becomes offline',
  );
  await acceptFixtureTask(winner, winnerTaskID);
  await sharedSlot(winner, 1);
  const projectTask = await createTask(winner, 'Project while other Master is stopped', project.id);
  const projectReview = await until(
    () => readTask(winner, projectTask.id),
    (task) => task.status === 'review',
    'Project Task review',
  );
  assert.equal(projectReview.selectedWorkerID, identities.get(worker)!.nodeID);
  const workerWithProject = await worker.bootstrap();
  const projectBusiness = workerWithProject.tasks.find((task) => task.projectID === project.id)!;
  assert(projectBusiness?.sessionID);
  assert.equal(projectBusiness.state, 'review');
  assert.equal(workerWithProject.tasks.length, 2);
  assert.equal(
    workerWithProject.projects.find((item) => item.id === projectBusiness.projectID)!.directory,
    project.directory,
  );
  assert(!(await worker.network()).brains.some((brain) => brain.hosted));
  assert(!owned(await winner.network()).some((task) => task.id === loserTaskID));
  pass(
    'Stopping one Master pauses only its Brain; the surviving Brain completes work on the exact authorized ordinary Project without takeover',
  );

  await start(loser);
  const restarted = await loser.network();
  assert.equal(restarted.local!.id, identities.get(loser)!.nodeID);
  assert.equal(restarted.brains.find((brain) => brain.hosted)!.id, identities.get(loser)!.brainID);
  await sharedSlot(loser, 0);
  const restored = await readTask(loser, loserTaskID);
  assert.equal(restored.id, beforeStop.id);
  assert.equal(restored.status, 'queued');
  assert.deepEqual(restored.executions, beforeStop.executions);
  proof.masterRestart = { beforeStop, restored };
  pass(
    'Restart restores the same Node, Brain, queued Task and Execution history; occupied Project review prevents duplicate dispatch',
  );
  await acceptFixtureTask(winner, projectTask.id);
  await until(
    () => readTask(loser, loserTaskID),
    (task) => task.status === 'review',
    'original queued Task resumes after slot release',
  );
  const loserCompleted = await acceptFixtureTask(loser, loserTaskID);
  assert.equal(loserCompleted.brainID, beforeStop.brainID);
  assert(loserCompleted.executions.length > beforeStop.executions.length);
  await sharedSlot(loser, 1);
  pass(
    'Released slot resumes the original queued Task under its original Brain with one new Execution attempt',
  );

  const finalState = await worker.bootstrap();
  const evidence = engineEvidence();
  assert.equal(finalState.tasks.length, 3);
  assert(finalState.tasks.every((task) => task.state === 'accepted'));
  assert.equal(new Set(finalState.tasks.map((task) => task.sessionID)).size, 3);
  assert.deepEqual(
    evidence.sessions.sort(),
    finalState.tasks.map((task) => task.sessionID!).sort(),
  );
  assert.equal(evidence.toolParts, 0);
  assert.equal(fixture.requests, 3);
  for (const task of finalState.tasks) {
    const used = finalState.projects.find((item) => item.id === task.projectID)!;
    if (used.id !== project.id)
      assert(used.directory.startsWith(join(worker.root, 'portable-tasks')));
    assert.deepEqual(readdirSync(used.directory), []);
    assert(!existsSync(join(used.directory, '.git')));
  }
  proof.finalTasks = await Promise.all(
    [left, right].map(async (master) => owned(await master.network())),
  );
  proof.workerTasks = finalState.tasks.map((task) => ({
    id: task.id,
    state: task.state,
    projectID: task.projectID,
    sessionID: task.sessionID,
  }));
  proof.engine = evidence;
  pass(
    'Three accepted text tasks have exactly three official sessions, no tool calls, empty ordinary execution folders and no Git',
  );
  pass(
    'Every service start and Master restart uses high HTTP ports for application, peer and official engine',
  );
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.error = String(error);
  process.exitCode = 1;
  console.error(error);
  for (const client of clients) console.error(client.root, client.output);
} finally {
  await Promise.all(raceControllers.map((controller) => controller.close()));
  fixture.release();
  const cleanup = await Promise.allSettled(clients.map((client) => client.stop()));
  await fixture.close();
  proof.cleanup = cleanup.map((result, index) => ({
    root: clients[index].root,
    status: result.status,
    exited: !clients[index].child || clients[index].child!.exitCode !== null,
  }));
  if (cleanup.some((result) => result.status === 'rejected')) {
    proof.status = 'failed';
    process.exitCode = 1;
  }
  proof.modelRequests = fixture.requests;
  proof.finishedAt = new Date().toISOString();
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
  const reportPath = resolve('.data', 'verification', `m34-fresh-brains-${runID}.json`);
  writeFileSync(reportPath, JSON.stringify(proof, null, 2));
  console.log(
    'REPORT',
    reportPath,
    'STATUS',
    proof.status,
    'CLEANUP',
    JSON.stringify(proof.cleanup),
  );
}
