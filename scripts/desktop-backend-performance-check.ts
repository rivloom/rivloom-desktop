// In-memory SQLite only: never imports the real application store or starts an engine.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { TaskQueries, decodeTask, taskQuerySQL } from '../server/task-queries.ts';
import { activeStates, type Task } from '../shared/types.ts';

const output = resolve(process.argv[2] || '.data/verification/desktop-native-performance-20260908');
await mkdir(output, { recursive: true });
const tasks = Array.from({ length: 300 }, (_, index): Task => ({
  id: `task-${index}`,
  number: index + 1,
  projectID: 'synthetic-project',
  title: `Synthetic task ${index}`,
  description: 'Synthetic benchmark only',
  criteria: '',
  creatorID: 'owner',
  assigneeID: 'owner',
  approverID: 'owner',
  reviewerID: 'owner',
  acceptedBy: 'owner',
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  model: 'synthetic/model',
  runAfter: 0,
  artifacts: [],
  diffSource: '',
  error: null,
  state: 'accepted',
  approvalMode: 'ask',
  version: 1,
  sessionID: `synthetic-session-${index}`,
  remoteOrigin: index
    ? undefined
    : { ownerNodeID: 'peer', ownerBrainID: 'brain', remoteTaskID: 'synthetic-remote' },
  messages: Array.from({ length: index ? 10 : 120 }, (_, message) => ({
    id: `message-${message}`,
    role: 'assistant',
    text: `合成正文 ${message}。${' Keep content unchanged. 中文性能验证。'.repeat(8)}`,
    tools: [],
  })),
  approvals: [],
  questions: [],
}));
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE tasks(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,project_id TEXT NOT NULL,body TEXT NOT NULL)',
  );
  const insert = db.prepare('INSERT INTO tasks VALUES(?,?,?,?)');
  db.exec('BEGIN');
  for (const task of tasks) insert.run(task.id, task.number, task.projectID, JSON.stringify(task));
  db.exec('COMMIT');
  return db;
}
const before = database(),
  after = database();
const indexedAt = performance.now();
const reads = new TaskQueries(after);
const indexBuildMs = performance.now() - indexedAt;
const legacyTasks = () =>
  before
    .prepare('SELECT body FROM tasks ORDER BY number DESC')
    .all()
    .map((row) => decodeTask(String(row.body)));
type Sample = { elapsedMs: number; cpuMs: number; timerDelayMs: number };
type Series = { iterations: number; before: Sample[]; after: Sample[] };
async function batch(count: number, action: () => void): Promise<Sample> {
  await new Promise<void>((ok) => setImmediate(ok));
  const start = performance.now(),
    cpu = process.cpuUsage();
  let tickAt = 0;
  const tick = new Promise<void>((ok) =>
    setTimeout(() => {
      tickAt = performance.now();
      ok();
    }, 0),
  );
  for (let i = 0; i < count; i++) action();
  const end = performance.now(),
    used = process.cpuUsage(cpu);
  await tick;
  return {
    elapsedMs: end - start,
    cpuMs: (used.user + used.system) / 1000,
    timerDelayMs: tickAt - start,
  };
}
const scenarios: Record<string, { iterations: number; before: Sample[]; after: Sample[] }> = {};
async function compare(
  name: string,
  iterations: number,
  oldRead: () => unknown,
  newRead: () => unknown,
) {
  assert.deepEqual(newRead(), oldRead(), `${name}: changed result`);
  for (let warmup = 0; warmup < 3; warmup++) {
    oldRead();
    newRead();
  }
  const samples: Series = (scenarios[name] = { iterations, before: [], after: [] });
  for (let repeat = 0; repeat < 3; repeat++) {
    samples.before.push(
      await batch(iterations, () => {
        oldRead();
      }),
    );
    samples.after.push(
      await batch(iterations, () => {
        newRead();
      }),
    );
  }
}
try {
  await compare(
    'idleMonitor',
    30,
    () => legacyTasks().filter((task) => activeStates.includes(task.state)),
    () => reads.inStates(activeStates),
  );
  const active = { ...tasks[0], state: 'running' as const };
  for (const db of [before, after])
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(active), active.id);
  await compare(
    'activeMonitor',
    30,
    () => legacyTasks().filter((task) => activeStates.includes(task.state)),
    () => reads.inStates(activeStates),
  );
  await compare(
    'streamRoute',
    100,
    () => {
      const task = legacyTasks().find((task) => task.sessionID === active.sessionID)!;
      return { id: task.id, state: task.state };
    },
    () => reads.routeForSession(active.sessionID),
  );
  await compare(
    'remoteBinding',
    30,
    () => legacyTasks().find((task) => task.remoteOrigin?.remoteTaskID === 'synthetic-remote'),
    () => reads.forRemote('synthetic-remote'),
  );
  await compare(
    'nextNumber',
    30,
    () => Math.max(0, ...legacyTasks().map((task) => task.number)) + 1,
    () => reads.nextNumber(),
  );
  // Measure the index maintenance cost too, using exactly the same durable write shape.
  const writes = [before, after].map((db) =>
    db.prepare(
      'INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
    ),
  );
  const writeSamples: Series = (scenarios.saveTask = { iterations: 30, before: [], after: [] });
  for (let repeat = 0; repeat < 3; repeat++)
    for (const [index, label] of ['before', 'after'].entries()) {
      writeSamples[label as 'before' | 'after'].push(
        await batch(30, () => {
          const value = { ...active, version: 2 };
          writes[index].run(value.id, value.number, value.projectID, JSON.stringify(value));
        }),
      );
    }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
  const summary = Object.fromEntries(
    Object.entries(scenarios).map(([name, sample]) => {
      const beforeMs = median(sample.before.map((value) => value.elapsedMs));
      const afterMs = median(sample.after.map((value) => value.elapsedMs));
      return [
        name,
        {
          iterations: sample.iterations,
          beforeMs,
          afterMs,
          reductionPercent: (1 - afterMs / beforeMs) * 100,
          beforeTimerDelayMs: median(sample.before.map((value) => value.timerDelayMs)),
          afterTimerDelayMs: median(sample.after.map((value) => value.timerDelayMs)),
        },
      ];
    }),
  );
  const plans = Object.fromEntries(
    Object.entries({
      polling: [taskQuerySQL.states(1), 'running'],
      stream: [taskQuerySQL.session, active.sessionID],
      remote: [taskQuerySQL.remote, 'synthetic-remote'],
    }).map(([name, [sql, parameter]]) => [
      name,
      after.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameter!),
    ]),
  );
  const bytes = (db: DatabaseSync) =>
    Number(db.prepare('PRAGMA page_size').get()!.page_size) *
    Number(db.prepare('PRAGMA page_count').get()!.page_count);
  const result = {
    status: 'passed',
    synthetic: true,
    realModelRequests: 0,
    node: process.version,
    sqlite: before.prepare('SELECT sqlite_version() AS version').get()!.version,
    tasks: tasks.length,
    taskJsonBytes: tasks.reduce((sum, task) => sum + Buffer.byteLength(JSON.stringify(task)), 0),
    indexBuildMs,
    allocatedBytes: { before: bytes(before), after: bytes(after) },
    plans,
    summary,
    samples: scenarios,
    limitation:
      'Three alternating batches against in-memory SQLite; event-loop delay is a synthetic request burst, not measured desktop drag, disk latency or application-wide CPU.',
  };
  await writeFile(
    resolve(output, 'backend-performance.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      status: result.status,
      indexBuildMs,
      allocatedBytes: result.allocatedBytes,
      summary,
    }),
  );
} finally {
  before.close();
  after.close();
}
