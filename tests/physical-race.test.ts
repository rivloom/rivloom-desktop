import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import type { Bootstrap, BrainTask, NodeNetwork } from '../shared/types.ts';
import { RaceController, validateRaceTime } from '../scripts/m34-race.ts';

const base = resolve('.data', 'race-unit');
mkdirSync(base, { recursive: true });
const nodeID = 'a'.repeat(32);
const workerID = 'w'.repeat(32);
const brainID = '11111111-1111-4111-8111-111111111111';
function fixture() {
  let now = Date.parse('2026-09-02T13:00:00.000Z');
  let posts = 0;
  let fail = false;
  const tasks: BrainTask[] = [];
  const controls: unknown[] = [];
  const network = {
    local: { id: nodeID },
    nearby: [{ id: workerID, online: true, trusted: true, channelReady: true }],
    brains: [
      {
        id: brainID,
        hosted: true,
        online: true,
        state: 'established',
        masterNodeID: nodeID,
        workers: [
          {
            nodeID: workerID,
            accepting: true,
            load: { availableSlots: 1, runningTasks: 0, sampledAt: new Date(now).toISOString() },
          },
        ],
      },
    ],
    brainTasks: tasks,
  } as unknown as NodeNetwork;
  const client = {
    network: async () => network,
    bootstrap: async () =>
      ({ executionPolicy: { enabled: false }, tasks: [] }) as unknown as Bootstrap,
    call: async <T>(path: string, body?: unknown): Promise<T> => {
      if (path === '/network/tasks') {
        posts++;
        if (fail) throw new Error('uncertain HTTP result');
        const payload = body as Pick<
          BrainTask,
          'title' | 'description' | 'criteria' | 'requestedProjectID'
        >;
        tasks.push({
          ...payload,
          id: randomUUID(),
          direction: 'owned',
          masterNodeID: nodeID,
          brainID,
          submitterNodeID: nodeID,
          requirements: {},
          status: 'review',
          selectedWorkerID: workerID,
          executionID: randomUUID(),
          executionSequence: 3,
          executionAttempt: 1,
          executions: [],
          executionSummary: '',
          retryNotBefore: null,
          deliveryPending: false,
          deliveryError: null,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
      } else controls.push({ path, body });
      return network as T;
    },
  };
  const options = {
    client,
    role: 'A' as const,
    nodeID,
    brainID,
    workerID,
    ledgerDirectory: join(mkdtempSync(join(base, 'case-')), 'ledger'),
    now: () => now,
  };
  const controller = new RaceController(options);
  return {
    controller,
    options,
    tasks,
    network,
    controls,
    posts: () => posts,
    fail: () => {
      fail = true;
    },
    due: () => {
      now += 6000;
    },
    late: () => {
      now += 9000;
    },
    at: () => new Date(now + 6000).toISOString(),
    id: randomUUID(),
  };
}

test('race timing rejects ambiguous, past, too-close and distant timestamps', () => {
  const now = Date.parse('2026-09-02T13:00:00.000Z');
  assert.throws(() => validateRaceTime('2026-09-02 13:01:00', now));
  assert.throws(() => validateRaceTime('2026-09-02T12:59:00.000Z', now));
  assert.throws(() => validateRaceTime('2026-09-02T13:00:04.000Z', now));
  assert.throws(() => validateRaceTime('2026-09-02T13:11:00.000Z', now));
  assert.equal(validateRaceTime('2026-09-02T13:00:06.000Z', now), now + 6000);
});
test('arming validates identity and only one available target Worker', async () => {
  const f = fixture();
  f.network.local!.id = 'x'.repeat(32);
  await assert.rejects(f.controller.arm(f.id, f.at()));
  assert.equal(f.posts(), 0);
});
test('unready and occupied Workers cannot be armed', async () => {
  const f = fixture();
  f.network.nearby[0].channelReady = false;
  await assert.rejects(f.controller.arm(f.id, f.at()));
  f.network.nearby[0].channelReady = true;
  f.network.brains[0].workers[0].load.availableSlots = 0;
  await assert.rejects(f.controller.arm(f.id, f.at()));
  assert.equal(f.posts(), 0);
});
test('bad IDs and duplicate persisted race IDs never submit', async () => {
  const f = fixture();
  await assert.rejects(f.controller.arm('../escape', f.at()));
  await f.controller.arm(f.id, f.at());
  await assert.rejects(f.controller.arm(f.id, f.at()));
  const resumed = new RaceController(f.options);
  await assert.rejects(resumed.arm(f.id, f.at()));
  assert.equal(f.posts(), 0);
});
test('one-shot dispatch survives concurrent callers and persists exact Task', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.due();
  const results = await Promise.allSettled([
    f.controller.dispatch(f.id),
    f.controller.dispatch(f.id),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.posts(), 1);
  assert.equal(f.tasks[0].requestedProjectID, null);
  assert.equal(f.controller.records()[0].phase, 'submitted');
  assert.equal(f.controller.records()[0].taskID, f.tasks[0].id);
  await assert.rejects(new RaceController(f.options).dispatch(f.id));
  assert.equal(f.posts(), 1);
});
test('cancel before dispatch consumes the attempt without a model/task request', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.controller.cancel(f.id);
  f.due();
  await assert.rejects(f.controller.dispatch(f.id));
  assert.equal(f.posts(), 0);
});
test('late wakeup is missed, not a delayed competing submission', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.late();
  await f.controller.dispatch(f.id);
  assert.equal(f.controller.records()[0].phase, 'missed');
  assert.equal(f.posts(), 0);
});
test('HTTP uncertainty is persisted and never retried, including after restart', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.fail();
  f.due();
  await f.controller.dispatch(f.id);
  assert.equal(f.controller.records()[0].phase, 'uncertain');
  await assert.rejects(new RaceController(f.options).dispatch(f.id));
  assert.equal(f.posts(), 1);
});
test('status is read-only and original unrelated tasks cannot be accepted', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  await f.controller.status();
  assert.equal(f.posts(), 0);
  await assert.rejects(f.controller.accept(f.id));
  assert.equal(f.controls.length, 0);
});
test('accept binds exact owned test Task, Execution and latest sequence', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.due();
  await f.controller.dispatch(f.id);
  await f.controller.accept(f.id);
  assert.deepEqual(f.controls, [
    {
      path: `/network/tasks/${f.tasks[0].executionID}/control`,
      body: {
        expectedExecutionSequence: 3,
        action: {
          kind: 'accept',
          note: 'Accept only this reviewed deterministic physical race test result.',
        },
        confirmed: true,
      },
    },
  ]);
});
test('wrong Brain or Worker cannot be recognized or controlled', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.due();
  await f.controller.dispatch(f.id);
  f.tasks[0].brainID = randomUUID();
  assert.equal(f.controller.owns(f.tasks[0]), false);
  await assert.rejects(f.controller.accept(f.id));
  f.tasks[0].brainID = brainID;
  f.tasks[0].selectedWorkerID = 'x'.repeat(32);
  await assert.rejects(f.controller.accept(f.id));
  assert.equal(f.controls.length, 0);
});
test('restart only inspects armed records and does not restore timers', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.due();
  const resumed = new RaceController(f.options);
  await resumed.status();
  assert.equal(f.posts(), 0);
  assert.equal(resumed.records()[0].phase, 'armed');
  await resumed.close();
  assert.equal(f.posts(), 0);
});
test('closing a scheduled controller cancels its timer without submitting', async () => {
  const f = fixture();
  const output: unknown[] = [];
  await f.controller.schedule(f.id, f.at(), (event, value) => output.push({ event, value }));
  assert.throws(() => f.controller.assertIdle());
  await f.controller.close();
  f.controller.assertIdle();
  assert.equal(f.controller.records()[0].phase, 'cancelled');
  assert.equal(f.posts(), 0);
});
test('existing incomplete master Tasks block another race', async () => {
  const f = fixture();
  await f.controller.arm(f.id, f.at());
  f.due();
  await f.controller.dispatch(f.id);
  await assert.rejects(f.controller.arm(randomUUID(), f.at()));
  assert.equal(f.posts(), 1);
});

function gatedFixture() {
  const f = fixture();
  const worker = f.network.brains[0].workers[0];
  worker.accepting = false;
  worker.load.availableSlots = 0;
  const open = () => {
    worker.accepting = true;
    worker.load.availableSlots = 1;
  };
  return { ...f, worker, open };
}
test('prepare records intent without Task or UTC deadline while original Worker is closed', async () => {
  const f = gatedFixture();
  const record = await f.controller.prepare(f.id);
  assert.equal(record.version, 2);
  assert.equal(record.fireAt, null);
  assert.equal(record.phase, 'prepared');
  f.late();
  assert.equal((await f.controller.pollPrepared(f.id)).phase, 'prepared');
  assert.equal(f.posts(), 0);
  await assert.rejects(f.controller.prepare(f.id));
  await assert.rejects(f.controller.prepare(randomUUID()));
});
test('prepare requires a fresh closed idle Worker and the correct Master', async () => {
  const f = gatedFixture();
  f.open();
  await assert.rejects(f.controller.prepare(f.id));
  f.worker.accepting = false;
  f.worker.load.availableSlots = 0;
  f.worker.load.runningTasks = 1;
  await assert.rejects(f.controller.prepare(f.id));
  f.worker.load.runningTasks = 0;
  f.worker.load.sampledAt = '2026-09-02T12:59:00.000Z';
  await assert.rejects(f.controller.prepare(f.id));
  f.worker.load.sampledAt = '2026-09-02T13:00:00.000Z';
  f.network.local!.id = 'x'.repeat(32);
  await assert.rejects(f.controller.prepare(f.id));
  assert.equal(f.controller.records().length, 0);
  assert.equal(f.posts(), 0);
});
test('gate polling waits on disconnected or stale reports then submits exactly once', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  f.open();
  f.network.nearby[0].channelReady = false;
  assert.equal((await f.controller.pollPrepared(f.id)).phase, 'prepared');
  f.network.nearby[0].channelReady = true;
  f.worker.load.sampledAt = '2026-09-02T12:59:00.000Z';
  assert.equal((await f.controller.pollPrepared(f.id)).phase, 'prepared');
  assert.equal(f.posts(), 0);
  f.worker.load.sampledAt = '2026-09-02T13:00:00.000Z';
  await Promise.all([f.controller.pollPrepared(f.id), f.controller.pollPrepared(f.id)]);
  assert.equal(f.posts(), 1);
  assert.equal(f.controller.records()[0].phase, 'submitted');
  assert.equal(f.controller.records()[0].taskID, f.tasks[0].id);
  await f.controller.pollPrepared(f.id);
  assert.equal(f.posts(), 1);
});
test('opened but occupied gate is missed without catch-up submission', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  f.open();
  f.worker.load.availableSlots = 0;
  assert.equal((await f.controller.pollPrepared(f.id)).phase, 'missed');
  f.worker.load.availableSlots = 1;
  await f.controller.pollPrepared(f.id);
  assert.equal(f.posts(), 0);
});
test('cancel while a gate read is in flight cannot submit', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  let finish!: (n: NodeNetwork) => void;
  f.options.client.network = () =>
    new Promise((ok) => {
      finish = ok;
    });
  const polling = f.controller.pollPrepared(f.id);
  f.controller.cancel(f.id);
  f.open();
  finish(f.network);
  assert.equal((await polling).phase, 'cancelled');
  assert.equal(f.posts(), 0);
});
test('prepared uncertainty and restart never resubmit a consumed attempt', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  const resumed = new RaceController(f.options);
  f.open();
  await resumed.status();
  assert.equal(f.posts(), 0);
  f.fail();
  assert.equal((await f.controller.pollPrepared(f.id)).phase, 'uncertain');
  await new RaceController(f.options).pollPrepared(f.id);
  await assert.rejects(resumed.prepare(f.id));
  assert.equal(f.posts(), 1);
});
test('prepare command watches the gate and close cancels without creating a Task', async () => {
  const f = gatedFixture();
  const events: string[] = [];
  assert(await f.controller.command(`prepare ${f.id}`, (event) => events.push(event)));
  assert.deepEqual(events, ['RACE_PREPARED']);
  assert.throws(() => f.controller.assertIdle());
  await f.controller.close();
  f.open();
  f.controller.assertIdle();
  assert.equal(f.controller.records()[0].phase, 'cancelled');
  assert.equal(f.posts(), 0);
});
test('prepared accept retains exact Task and Execution checks', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  f.open();
  await f.controller.pollPrepared(f.id);
  await f.controller.accept(f.id);
  assert.equal(f.controls.length, 1);
  f.tasks[0].brainID = randomUUID();
  await assert.rejects(f.controller.accept(f.id));
  assert.equal(f.controls.length, 1);
});
test('concurrent preparation of different IDs cannot create two active intents', async () => {
  const f = gatedFixture();
  const results = await Promise.allSettled([
    f.controller.prepare(f.id),
    f.controller.prepare(randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.controller.records().length, 1);
  assert.equal(f.posts(), 0);
});
test('close waits for an in-flight watcher and cancels intent before its reply can submit', async () => {
  const f = gatedFixture();
  await f.controller.command(`prepare ${f.id}`, () => {});
  let finish!: (n: NodeNetwork) => void;
  let started!: () => void;
  const entered = new Promise<void>((ok) => {
    started = ok;
  });
  f.options.client.network = () =>
    new Promise((ok) => {
      finish = ok;
      started();
    });
  await entered;
  const closing = f.controller.close();
  f.open();
  finish(f.network);
  await closing;
  f.controller.assertIdle();
  assert.equal(f.controller.records()[0].phase, 'cancelled');
  assert.equal(f.posts(), 0);
});
test('new unrelated work appearing during preparation blocks the trigger', async () => {
  const f = gatedFixture();
  await f.controller.prepare(f.id);
  f.tasks.push({ direction: 'owned', status: 'running' } as BrainTask);
  f.open();
  await assert.rejects(f.controller.pollPrepared(f.id));
  assert.equal(f.posts(), 0);
});
