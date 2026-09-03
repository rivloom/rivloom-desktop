// Test orchestration only. No listener, model access, service lifecycle or product state patching.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bootstrap, BrainTask, NodeNetwork } from '../shared/types.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const description = 'Reply briefly. Do not call tools or modify files.';
const criteria = 'Only deterministic short text; no tools or file changes.';
type Phase =
  'armed' | 'prepared' | 'dispatching' | 'submitted' | 'uncertain' | 'cancelled' | 'missed';
export type RaceRecord = {
  version: 1 | 2;
  raceID: string;
  role: 'A' | 'B';
  nodeID: string;
  brainID: string;
  workerID: string;
  title: string;
  fireAt: string | null;
  phase: Phase;
  createdAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  taskID: string | null;
};
type Client = {
  network(): Promise<NodeNetwork>;
  bootstrap(): Promise<Bootstrap>;
  call<T = unknown>(path: string, body?: unknown, expected?: number): Promise<T>;
};
type Options = {
  client: Client;
  ledgerDirectory: string;
  role: 'A' | 'B';
  nodeID: string;
  brainID: string;
  workerID: string;
  now?: () => number;
};
export function validateRaceTime(value: string, now: number) {
  const at = Date.parse(value);
  assert(
    Number.isFinite(at) && new Date(at).toISOString() === value,
    'Use exact UTC ISO timestamp including milliseconds and Z',
  );
  assert(at - now >= 5000 && at - now <= 600000, 'Schedule must be 5 seconds to 10 minutes ahead');
  return at;
}
export class RaceController {
  private readonly options: Options;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now || Date.now;
    assert(['A', 'B'].includes(options.role));
    assert.match(options.nodeID, /^[A-Za-z0-9_-]{32}$/);
    assert.match(options.workerID, /^[A-Za-z0-9_-]{32}$/);
    assert.match(options.brainID, uuid);
    this.directory = resolve(options.ledgerDirectory);
    mkdirSync(this.directory, { recursive: true });
    this.noLink(this.directory);
    // Deliberately never restore timers or dispatch on construction.
    this.records();
  }
  private noLink(path: string) {
    assert.equal(
      realpathSync(path).toLowerCase(),
      path.toLowerCase(),
      'Linked race state is not allowed',
    );
  }
  private path(id: string, suffix = '.json') {
    assert.match(id, uuid, 'Use a fresh canonical UUID v4 race ID');
    return join(this.directory, id + suffix);
  }
  private title(id: string) {
    return `M3.4 physical race ${id} ${this.options.role}`;
  }
  private validate(value: RaceRecord) {
    assert(value.version === 1 || value.version === 2);
    for (const key of ['role', 'nodeID', 'brainID', 'workerID'] as const)
      assert.equal(value[key], this.options[key], `Race ${key} changed`);
    assert.match(value.raceID, uuid);
    assert.equal(value.title, this.title(value.raceID));
    if (value.version === 1) {
      assert.equal(typeof value.fireAt, 'string');
      assert.equal(new Date(value.fireAt!).toISOString(), value.fireAt);
      assert.notEqual(value.phase, 'prepared');
    } else {
      assert.equal(value.fireAt, null);
      assert.notEqual(value.phase, 'armed');
    }
    assert(
      [
        'armed',
        'prepared',
        'dispatching',
        'submitted',
        'uncertain',
        'cancelled',
        'missed',
      ].includes(value.phase),
    );
    assert(value.taskID === null || uuid.test(value.taskID));
    return value;
  }
  private read(id: string) {
    const path = this.path(id);
    this.noLink(path);
    assert(statSync(path).size <= 65536, 'Unexpected race record size');
    const record = this.validate(JSON.parse(readFileSync(path, 'utf8')));
    assert.equal(record.raceID, id);
    return record;
  }
  private save(record: RaceRecord, create = false) {
    this.validate(record);
    const path = this.path(record.raceID);
    if (existsSync(path)) this.noLink(path);
    writeFileSync(path, JSON.stringify(record, null, 2), { flag: create ? 'wx' : 'w' });
  }
  records() {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => this.read(name.slice(0, -5)));
  }
  private matches(record: RaceRecord, task: BrainTask) {
    return (
      task.title === record.title &&
      task.direction === 'owned' &&
      task.brainID === record.brainID &&
      task.masterNodeID === record.nodeID &&
      task.submitterNodeID === record.nodeID &&
      task.requestedProjectID === null &&
      task.description === description &&
      task.criteria === criteria &&
      (!record.taskID || task.id === record.taskID) &&
      (task.selectedWorkerID === null || task.selectedWorkerID === record.workerID)
    );
  }
  owns(task: BrainTask) {
    return this.records().some((record) => this.matches(record, task));
  }
  private find(record: RaceRecord, network: NodeNetwork) {
    this.identity(network);
    const tasks = network.brainTasks.filter((task) => task.title === record.title);
    assert(
      tasks.length <= 1 && tasks.every((task) => this.matches(record, task)),
      'Unexpected race Task ownership or duplicate title',
    );
    return tasks[0] || null;
  }
  private identity(network: NodeNetwork) {
    assert.equal(network.local?.id, this.options.nodeID, 'Wrong Master Node');
    const hosted = network.brains.filter((brain) => brain.hosted);
    assert.equal(hosted.length, 1);
    assert.equal(hosted[0].id, this.options.brainID);
    assert.equal(hosted[0].masterNodeID, this.options.nodeID);
    assert(
      hosted[0].online && hosted[0].state === 'established',
      'Master must be established and online',
    );
  }
  private assertNew(id: string) {
    assert(!this.closing, 'Controller is closing');
    this.path(id);
    assert(!existsSync(this.path(id)), 'Race ID already consumed; inspect it, do not repeat');
    assert(
      !this.records().some((r) =>
        ['armed', 'prepared', 'dispatching', 'uncertain'].includes(r.phase),
      ),
      'Resolve prior unfinished attempt first',
    );
  }
  private fresh(sampledAt: string) {
    const age = this.now() - Date.parse(sampledAt);
    return Number.isFinite(age) && age >= -60000 && age < 15000;
  }
  private async preflight(id: string, closed: boolean) {
    this.assertNew(id);
    const [network, state] = await Promise.all([
      this.options.client.network(),
      this.options.client.bootstrap(),
    ]);
    this.identity(network);
    assert.equal(state.executionPolicy.enabled, false, 'Master must not execute locally');
    assert.equal(state.tasks.length, 0, 'Master must not have local business tasks');
    assert(
      network.brainTasks
        .filter((t) => t.direction === 'owned')
        .every((t) => t.status === 'completed'),
      'Existing owned Task is not completed',
    );
    assert(
      network.nearby.some(
        (p) => p.id === this.options.workerID && p.online && p.trusted && p.channelReady,
      ),
      'Original Worker channel is not ready',
    );
    const workers = network.brains.find((b) => b.hosted)!.workers;
    const worker = workers.find((w) => w.nodeID === this.options.workerID);
    assert(worker, 'Original Worker report missing');
    assert(this.fresh(worker.load.sampledAt), 'Stale Worker report');
    if (closed) {
      assert(!workers.some((w) => w.accepting), 'Coordinator must close test Worker first');
      assert.equal(worker.load.runningTasks, 0, 'Original Worker must be idle before preparation');
      assert.equal(worker.load.availableSlots, 0);
    } else {
      const available = workers.filter((w) => w.accepting && w.load.availableSlots > 0);
      assert.equal(available.length, 1, 'Expected only the original available test Worker');
      assert.equal(available[0].nodeID, this.options.workerID);
      assert.equal(available[0].load.availableSlots, 1);
    }
    // Recheck after awaits: concurrent preparations may already have consumed this attempt.
    this.assertNew(id);
  }
  private record(id: string, fireAt: string | null): RaceRecord {
    return {
      version: fireAt === null ? 2 : 1,
      raceID: id,
      role: this.options.role,
      nodeID: this.options.nodeID,
      brainID: this.options.brainID,
      workerID: this.options.workerID,
      title: this.title(id),
      fireAt,
      phase: fireAt === null ? 'prepared' : 'armed',
      createdAt: new Date(this.now()).toISOString(),
      dispatchedAt: null,
      finishedAt: null,
      taskID: null,
    };
  }
  async arm(id: string, fireAt: string) {
    validateRaceTime(fireAt, this.now());
    await this.preflight(id, false);
    this.assertNew(id);
    validateRaceTime(fireAt, this.now());
    const record = this.record(id, fireAt);
    this.save(record, true);
    return record;
  }
  async prepare(id: string) {
    await this.preflight(id, true);
    this.assertNew(id);
    const record = this.record(id, null);
    this.save(record, true);
    return record;
  }
  async pollPrepared(id: string) {
    let record = this.read(id);
    if (record.phase !== 'prepared' || this.closing) return record;
    const network = await this.options.client.network();
    // Cancellation/another poll may have run while the HTTP request was pending.
    record = this.read(id);
    if (record.phase !== 'prepared' || this.closing) return record;
    this.identity(network);
    const peer = network.nearby.find((p) => p.id === record.workerID);
    const workers = network.brains.find((b) => b.hosted)!.workers;
    const worker = workers.find((w) => w.nodeID === record.workerID);
    if (
      !peer?.online ||
      !peer.trusted ||
      !peer.channelReady ||
      !worker ||
      !this.fresh(worker.load.sampledAt)
    )
      return record;
    assert(
      !workers.some((w) => w.nodeID !== record.workerID && w.accepting),
      'Unexpected enabled Worker',
    );
    if (!worker.accepting) return record;
    assert(
      network.brainTasks
        .filter((t) => t.direction === 'owned')
        .every((t) => t.status === 'completed'),
      'Another owned Task appeared while preparing; inspect before continuing',
    );
    if (worker.load.availableSlots !== 1) {
      record.phase = 'missed';
      record.finishedAt = new Date(this.now()).toISOString();
      this.save(record);
      return record;
    }
    return this.submit(record);
  }
  async dispatch(id: string) {
    const record = this.read(id);
    assert.equal(record.phase, 'armed', 'Only an unconsumed armed attempt can dispatch');
    assert(!this.closing, 'Controller is closing');
    const lateness = this.now() - Date.parse(record.fireAt!);
    assert(lateness >= 0, 'Not at scheduled time');
    if (lateness > 2000) {
      record.phase = 'missed';
      record.finishedAt = new Date(this.now()).toISOString();
      this.save(record);
      return record;
    }
    return this.submit(record);
  }
  private async submit(record: RaceRecord) {
    // Exclusive marker remains even after crashes; there is no retry or unlink path.
    writeFileSync(this.path(record.raceID, '.claim'), '', { flag: 'wx' });
    record.phase = 'dispatching';
    record.dispatchedAt = new Date(this.now()).toISOString();
    this.save(record);
    try {
      const network = await this.options.client.call<NodeNetwork>(
        '/network/tasks',
        {
          title: record.title,
          description,
          criteria,
          requestedProjectID: null,
          requirements: {},
          confirmed: true,
        },
        201,
      );
      const task = this.find(record, network);
      assert(task, 'Missing created owned Task');
      record.taskID = task.id;
      record.phase = 'submitted';
    } catch {
      // A transport error can occur after creation. Persist uncertainty, never POST again.
      record.phase = 'uncertain';
    }
    record.finishedAt = new Date(this.now()).toISOString();
    this.save(record);
    return record;
  }
  cancel(id: string) {
    const record = this.read(id);
    assert(
      ['armed', 'prepared'].includes(record.phase),
      'Cannot cancel an already dispatched Task here',
    );
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    record.phase = 'cancelled';
    record.finishedAt = new Date(this.now()).toISOString();
    this.save(record);
  }
  assertIdle() {
    assert(
      this.timers.size === 0 && this.pending.size === 0,
      'Cancel armed/prepared race / wait for dispatch before taking Master offline',
    );
  }
  async status() {
    const network = await this.options.client.network();
    this.identity(network);
    return {
      at: new Date(this.now()).toISOString(),
      role: this.options.role,
      races: this.records().map((record) => {
        const task = this.find(record, network);
        return {
          ...record,
          task: task
            ? {
                id: task.id,
                brainID: task.brainID,
                status: task.status,
                executionID: task.executionID,
                executionSequence: task.executionSequence,
                executionAttempt: task.executionAttempt,
                selectedWorkerID: task.selectedWorkerID,
                executions: task.executions,
              }
            : null,
        };
      }),
    };
  }
  async accept(id: string) {
    const record = this.read(id);
    assert(['submitted', 'uncertain'].includes(record.phase), 'No submitted race Task');
    const task = this.find(record, await this.options.client.network());
    assert(task);
    assert.equal(task.status, 'review', 'Inspect fixture result before accepting a review Task');
    assert.equal(task.selectedWorkerID, record.workerID);
    assert(task.executionID);
    await this.options.client.call(`/network/tasks/${task.executionID}/control`, {
      expectedExecutionSequence: task.executionSequence,
      action: {
        kind: 'accept',
        note: 'Accept only this reviewed deterministic physical race test result.',
      },
      confirmed: true,
    });
  }
  async schedule(id: string, fireAt: string, output: (event: string, value: unknown) => void) {
    const record = await this.arm(id, fireAt);
    const wake = () => {
      const remaining = Date.parse(fireAt) - this.now();
      if (remaining > 0) {
        this.timers.set(id, setTimeout(wake, remaining));
        return;
      }
      this.timers.delete(id);
      const work = this.dispatch(id)
        .then((result) => output('RACE_DISPATCH', result))
        .catch(() =>
          output('RACE_ERROR', {
            raceID: id,
            instruction: 'Inspect race-status; never repeat this race ID',
          }),
        )
        .finally(() => this.pending.delete(work));
      this.pending.add(work);
    };
    const timer = setTimeout(wake, Math.max(0, Date.parse(fireAt) - this.now()));
    this.timers.set(id, timer);
    output('RACE_ARMED', record);
  }
  async watch(id: string, output: (event: string, value: unknown) => void) {
    const record = await this.prepare(id);
    const wake = () => {
      this.timers.delete(id);
      const work = this.pollPrepared(id)
        .then((result) => {
          if (result.phase === 'prepared' && !this.closing)
            this.timers.set(id, setTimeout(wake, 250));
          else output('RACE_DISPATCH', result);
        })
        .catch(() => {
          if (this.read(id).phase === 'prepared') this.cancel(id);
          output('RACE_ERROR', {
            raceID: id,
            instruction: 'Inspect race-status; never repeat this race ID',
          });
        })
        .finally(() => this.pending.delete(work));
      this.pending.add(work);
    };
    this.timers.set(id, setTimeout(wake, 250));
    output('RACE_PREPARED', record);
  }
  async command(
    line: string,
    output = (event: string, value: unknown) => console.log(event, JSON.stringify(value)),
  ) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'prepare') {
      assert.equal(words.length, 2);
      await this.watch(words[1], output);
    } else if (words[0] === 'arm') {
      assert.equal(words.length, 3);
      await this.schedule(words[1], words[2], output);
    } else if (words[0] === 'race-status') {
      assert.equal(words.length, 1);
      output('RACE_STATUS', await this.status());
    } else if (words[0] === 'race-cancel') {
      assert.equal(words.length, 2);
      this.cancel(words[1]);
      output('RACE_STATUS', await this.status());
    } else if (words[0] === 'race-accept') {
      assert.equal(words.length, 2);
      await this.accept(words[1]);
      output('RACE_STATUS', await this.status());
    } else return false;
    return true;
  }
  async close() {
    this.closing = true;
    for (const id of [...this.timers.keys()]) this.cancel(id);
    for (const record of this.records())
      if (record.phase === 'prepared') this.cancel(record.raceID);
    await Promise.allSettled([...this.pending]);
  }
}
