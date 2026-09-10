import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import type { Task } from '../shared/types.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';

const root = resolve(
  '.data/verification',
  `m35-session-crash-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
mkdirSync(root, { recursive: true });
const outcomes: unknown[] = [];
const model = await modelFixture();
const clients: ServiceClient[] = [];
let success = false;
function databaseRows(path: string, query: string) {
  // A forcibly killed SQLite writer can leave WAL recovery work. This is our isolated
  // fixture DB; allow SQLite to recover its journal before issuing read-only queries.
  const db = new DatabaseSync(path);
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
}
async function unusedDiscoveryPort() {
  const socket = createSocket('udp4');
  await new Promise<void>((ok, fail) => {
    socket.once('error', fail);
    socket.bind(0, '127.0.0.1', () => ok());
  });
  const address = socket.address();
  await new Promise<void>((ok) => socket.close(() => ok()));
  return address.port;
}
async function isListening(url: string) {
  return new Promise<boolean>((ok) => {
    const address = new URL(url);
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    const done = (listening: boolean) => {
      socket.destroy();
      ok(listening);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
async function crashOwnService(client: ServiceClient, directory: string) {
  const child = client.child;
  assert(
    child?.pid && child.exitCode === null,
    'Only terminate a running child owned by this fixture',
  );
  const engineURL = client.output.match(/RIVLOOM_ENGINE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(engineURL, 'Record the engine port of this exact child before terminating it');
  let killOutput = '';
  let killExitCode: number | null = null;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    killer.stdout.on('data', (part) => {
      killOutput += part;
    });
    killer.stderr.on('data', (part) => {
      killOutput += part;
    });
    await new Promise<void>((ok, fail) => {
      killer.once('error', fail);
      killer.once('exit', (code) => {
        killExitCode = code;
        ok();
      });
    });
  } else child.kill('SIGKILL');
  // taskkill may report 128 for a transient descendant that exited during traversal.
  // A successful crash requires our actual child to exit AND both its listeners to stop.
  const evidence = {
    pid: child.pid,
    serviceURL: client.base,
    engineURL,
    killExitCode,
    killOutput,
    confirmedClosed: false,
  };
  writeFileSync(join(directory, 'forced-crash.json'), JSON.stringify(evidence, null, 2));
  await until(
    async () =>
      (child.exitCode !== null || child.signalCode !== null) &&
      !(await isListening(client.base)) &&
      !(await isListening(engineURL)),
    Boolean,
    `owned service/engine exit (taskkill ${killExitCode})`,
    10_000,
  );
  evidence.confirmedClosed = true;
  writeFileSync(join(directory, 'forced-crash.json'), JSON.stringify(evidence, null, 2));
}
try {
  for (const point of ['before_create', 'after_create'] as const) {
    const requestsBefore = model.requests;
    const directory = join(root, point);
    mkdirSync(directory, { recursive: true });
    model.configure(directory);
    const client = new ServiceClient(directory);
    const discovery = { port: await unusedDiscoveryPort(), mdns: false };
    clients.push(client);
    await client.start({
      discovery,
      sessionCrashPoint: point,
      logPath: join(directory, 'service.log'),
    });
    const projectDirectory = join(directory, 'project');
    mkdirSync(projectDirectory, { recursive: true });
    const p = await client.call<{ id: string }>(
      '/projects',
      { name: 'Crash window fixture', directory: projectDirectory, trusted: true },
      201,
    );
    const initial = await client.bootstrap();
    const input = {
      requestID: randomUUID(),
      runRequested: true,
      projectID: p.id,
      title: `M3.5 ${point}`,
      description: 'Only deterministic fixture text. Do not call tools.',
      criteria: 'No tools or files.',
      assigneeID: initial.user.id,
      approverID: initial.user.id,
      reviewerID: initial.user.id,
      model: 'fixture/m34',
      approvalMode: 'ask',
    };
    const original = await client.call<Task>('/tasks', input, 201);
    await until(
      async () => existsSync(join(directory, 'session-crash-window.json')),
      Boolean,
      `${point} crash checkpoint`,
    );
    const marker = JSON.parse(readFileSync(join(directory, 'session-crash-window.json'), 'utf8'));
    const before = await client.bootstrap();
    assert.equal(before.tasks.find((t) => t.id === original.id)?.sessionID, null);
    const intentBefore = databaseRows(
      join(directory, 'rivloom.sqlite'),
      'SELECT * FROM task_engine_intents',
    );
    assert.equal(intentBefore.length, 1);
    assert.equal(intentBefore[0].state, 'creating');
    const queueBefore = await client.call<NodeQueueSnapshot>('/node-queue');
    assert.equal(
      queueBefore.entries.find((q) => q.localTaskID === original.id)?.admissionPhase,
      'starting',
    );
    await crashOwnService(client, directory);
    const expectedSessions = point === 'before_create' ? 0 : 1;
    const officialBefore = databaseRows(
      join(directory, 'engine/data/opencode/opencode.db'),
      'SELECT id FROM session',
    );
    assert.equal(officialBefore.length, expectedSessions);
    if (marker.sessionID) assert.equal(officialBefore[0].id, marker.sessionID);
    await client.start({ discovery, logPath: join(directory, 'restarted.log') });
    const recovered = await until(
      () => client.bootstrap(),
      (b) => b.tasks.find((t) => t.id === original.id)?.state === 'interrupted',
      'uncertain creation stays interrupted',
    );
    assert.equal(recovered.tasks.find((t) => t.id === original.id)?.sessionID, null);
    const replay = await client.call<Task>('/tasks', input, 201);
    assert.equal(replay.id, original.id);
    await client.call(
      `/tasks/${original.id}/run`,
      { confirmed: true, addition: 'Do not create a second session.' },
      409,
    );
    assert.equal(model.requests, requestsBefore, 'Uncertain creation must not submit a model request');
    const second = await client.call<Task>(
      '/tasks',
      { ...input, requestID: randomUUID(), title: 'Independent local work beside unknown creation' },
      201,
    );
    const after = await until(
      () => client.bootstrap(),
      (b) => b.tasks.find((t) => t.id === second.id)?.state === 'running',
      'independent local task can run with unlimited local concurrency',
    );
    assert.equal(after.tasks.length, 2);
    const secondSession = after.tasks.find((t) => t.id === second.id)?.sessionID;
    assert(secondSession);
    assert.equal(after.tasks.find((t) => t.id === original.id)?.state, 'interrupted');
    assert.equal(after.tasks.find((t) => t.id === original.id)?.sessionID, null);
    await client.stop();
    const officialAfter = databaseRows(
      join(directory, 'engine/data/opencode/opencode.db'),
      'SELECT id FROM session',
    );
    assert.deepEqual(officialAfter.filter((s) => s.id !== secondSession), officialBefore);
    assert.equal(officialAfter.length, expectedSessions + 1);
    const result = {
      point,
      status: 'passed',
      discovery,
      taskID: original.id,
      secondTaskID: second.id,
      officialSessions: officialAfter,
      intentBefore,
      queueBefore,
      marker,
      modelRequests: model.requests,
      checks: [
        'persistent creation intent',
        'real official engine window',
        'forced own process-tree crash',
        'same identity restart',
        'no second session',
        'same request/task replay',
        'manual retry rejected',
        'unknown original is never retried while independent local work can run',
      ],
    };
    outcomes.push(result);
    writeFileSync(join(directory, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(
      `PASS ${point}: original ${expectedSessions} official session(s) unchanged; independent local work runs without duplicating the uncertain original`,
    );
  }
  success = true;
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  outcomes.push({ status: 'failed', error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.stop();
  await model.close();
  writeFileSync(
    join(root, 'verification.json'),
    JSON.stringify({ success, outcomes, root }, null, 2),
  );
  console.log(`Evidence: ${root}`);
}
