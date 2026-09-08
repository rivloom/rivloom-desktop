import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import {
  WorkerResourceSampler,
  validWorkerRegistration,
  workerMatchesTask,
  type WorkerResourceDependencies,
} from '../server/worker-resources.ts';
import type { WorkerHardware } from '../shared/types.ts';

const initialTime = Date.parse('2026-09-08T00:00:00.000Z');
const hardware: WorkerHardware = {
  platform: 'win32',
  release: 'test',
  architecture: 'x64',
  cpuModel: 'Isolated fixture CPU',
  physicalCores: 4,
  logicalCores: 8,
  memoryBytes: 16 * 1024 ** 3,
  gpus: [{ name: 'Isolated fixture GPU', memoryBytes: 8 * 1024 ** 3 }],
  diskBytes: null,
  collectedAt: new Date(initialTime).toISOString(),
};
const input = {
  nodeID: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  accepting: true,
  projects: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Fixture project' }],
  runningTasks: 0,
  maxConcurrent: 1,
};
const disk = { total: 1000 * 1024 ** 3, available: 700 * 1024 ** 3 };
const gpu = { percent: 40, memoryAvailable: 6 * 1024 ** 3 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

// Every OS, process and filesystem boundary is injected. These tests never enumerate
// the host's hardware, launch PowerShell/nvidia-smi, open a socket or touch a real task.
function fixture(overrides: Partial<WorkerResourceDependencies> = {}) {
  let at = initialTime;
  const calls = { hardware: 0, cpu: 0, memory: 0, gpu: 0, disk: 0 };
  const readers: WorkerResourceDependencies = {
    clock: () => at,
    hardware: async () => structuredClone(hardware),
    cpuTimes: () => ({ total: (at - initialTime) * 10, idle: (at - initialTime) * 7 }),
    memory: () => ({ total: hardware.memoryBytes, available: hardware.memoryBytes / 2 }),
    disk: async () => ({ ...disk }),
    gpu: async () => ({ ...gpu }),
    ...overrides,
  };
  const sampler = new WorkerResourceSampler('fixture-root-never-accessed', {
    clock: () => at,
    hardware: (...args) => {
      calls.hardware++;
      return readers.hardware(...args);
    },
    cpuTimes: () => {
      calls.cpu++;
      return readers.cpuTimes();
    },
    memory: () => {
      calls.memory++;
      return readers.memory();
    },
    disk: (...args) => {
      calls.disk++;
      return readers.disk(...args);
    },
    gpu: (...args) => {
      calls.gpu++;
      return readers.gpu(...args);
    },
  });
  return {
    sampler,
    calls,
    readers,
    advance: (milliseconds: number) => (at += milliseconds),
    async ready() {
      assert.equal(sampler.sample(input), null);
      await settle();
      assert(sampler.sample(input));
      await settle();
      return sampler.sample(input)!;
    },
  };
}

test('worker inventory is asynchronous and unknown GPU hardware cannot admit tasks', async () => {
  const inventory = deferred<WorkerHardware | null>();
  const pendingDisk = deferred<typeof disk>();
  const f = fixture({ hardware: () => inventory.promise, disk: () => pendingDisk.promise });
  assert.deepEqual(f.calls, { hardware: 0, cpu: 0, memory: 0, gpu: 0, disk: 0 });
  for (let i = 0; i < 1000; i++) assert.equal(f.sampler.sample(input), null);
  assert.equal(f.calls.hardware, 0, 'sampling returns before calling an external reader');
  await settle();
  assert.equal(f.calls.hardware, 1);
  assert.equal(f.calls.disk, 1);
  assert.equal(f.calls.gpu, 0);
  inventory.resolve(null);
  await settle();
  f.advance(29_999);
  assert.equal(f.sampler.sample(input), null);
  await settle();
  assert.equal(f.calls.hardware, 1, 'failed inventory must back off');
  f.readers.hardware = async () => ({ ...hardware, gpus: [] });
  f.advance(1);
  assert.equal(f.sampler.sample(input), null);
  await settle();
  const report = f.sampler.sample(input)!;
  assert(validWorkerRegistration(report));
  assert.equal(report.load.diskAvailableBytes, null, 'a pending disk does not block inventory');
  assert(
    workerMatchesTask(
      report,
      { projectID: null, requirements: { gpu: false } },
      initialTime + 30_000,
    ),
  );
  for (let i = 0; i < 60; i++) {
    f.advance(1000);
    f.sampler.sample(input);
    await settle();
  }
  assert.equal(f.calls.gpu, 0, 'confirmed GPU-free machines never start a GPU process');
  assert.equal(f.calls.disk, 1, 'a stalled filesystem reader is not accumulated');
  f.sampler.dispose();
  pendingDisk.resolve(disk);
  await settle();
});

test('cached OS measurements preserve sample time while admission inputs remain live', async () => {
  const f = fixture();
  const first = await f.ready();
  for (let i = 0; i < 1000; i++) f.sampler.sample(input);
  await settle();
  assert.deepEqual(f.calls, { hardware: 1, cpu: 1, memory: 1, gpu: 1, disk: 1 });
  const paused = f.sampler.sample({ ...input, accepting: false, runningTasks: 1 })!;
  assert.equal(paused.accepting, false);
  assert.equal(paused.load.runningTasks, 1);
  assert.equal(paused.load.availableSlots, 0);
  f.advance(500);
  const changed = f.sampler.sample({
    ...input,
    maxConcurrent: 3,
    runningTasks: 2,
    projects: [{ ...input.projects[0], name: 'Changed immediately' }],
  })!;
  assert.equal(changed.load.availableSlots, 1);
  assert.equal(changed.load.runningTasks, 2);
  assert.equal(changed.projects[0].name, 'Changed immediately');
  assert.equal(changed.load.sampledAt, first.load.sampledAt);
  first.hardware.gpus[0].name = 'Caller mutation';
  first.projects[0].name = 'Caller mutation';
  const isolated = f.sampler.sample(input)!;
  assert.equal(isolated.hardware.gpus[0].name, hardware.gpus[0].name);
  assert.equal(isolated.projects[0].name, input.projects[0].name);
  f.advance(500);
  const refreshed = f.sampler.sample(input)!;
  assert.equal(refreshed.load.cpuPercent, 30);
  assert.equal(refreshed.load.sampledAt, new Date(initialTime + 1000).toISOString());
  assert.equal(f.calls.cpu, 2);
  assert(validWorkerRegistration(refreshed));
  f.sampler.dispose();
});

test('slow GPU and disk refreshes stay single flight and expire old measurements', async () => {
  const f = fixture();
  const first = await f.ready();
  assert.equal(first.load.gpuPercent, gpu.percent);
  assert.equal(first.load.diskAvailableBytes, disk.available);
  const nextGpu = deferred<typeof gpu>();
  const nextDisk = deferred<typeof disk>();
  f.readers.gpu = () => nextGpu.promise;
  f.readers.disk = () => nextDisk.promise;
  f.advance(5000);
  assert.equal(f.sampler.sample(input)!.load.gpuPercent, gpu.percent);
  await settle();
  for (let i = 0; i < 1000; i++) f.sampler.sample(input);
  f.advance(15_000);
  const stale = f.sampler.sample(input)!;
  assert.equal(stale.load.gpuPercent, null);
  assert.equal(stale.load.gpuMemoryAvailableBytes, null);
  assert.equal(stale.load.diskAvailableBytes, null);
  assert.equal(stale.load.sampledAt, new Date(initialTime + 20_000).toISOString());
  await settle();
  assert.equal(f.calls.gpu, 2);
  assert.equal(f.calls.disk, 2);
  nextGpu.resolve({ ...gpu, percent: 10 });
  nextDisk.resolve({ ...disk, available: 600 * 1024 ** 3 });
  await settle();
  const resumed = f.sampler.sample(input)!;
  assert.equal(resumed.load.gpuPercent, 10);
  assert.equal(resumed.load.diskAvailableBytes, 600 * 1024 ** 3);
  f.sampler.dispose();
});

test('failed GPU and disk readers return unknown and retry without process bursts', async () => {
  const f = fixture();
  await f.ready();
  f.readers.gpu = () => {
    throw new Error('fixture GPU timeout');
  };
  f.readers.disk = async () => {
    throw new Error('fixture unavailable filesystem');
  };
  f.advance(5000);
  f.sampler.sample(input);
  await settle();
  const failed = f.sampler.sample(input)!;
  assert.equal(failed.load.gpuPercent, null);
  assert.equal(failed.load.gpuMemoryAvailableBytes, null);
  assert.equal(failed.load.diskAvailableBytes, null);
  for (let i = 0; i < 29; i++) {
    f.advance(1000);
    f.sampler.sample(input);
    await settle();
  }
  assert.equal(f.calls.gpu, 2);
  assert.equal(f.calls.disk, 2);
  f.readers.gpu = async () => ({ ...gpu });
  f.readers.disk = async () => ({ ...disk });
  f.advance(1000);
  f.sampler.sample(input);
  await settle();
  const recovered = f.sampler.sample(input)!;
  assert.equal(recovered.load.gpuPercent, gpu.percent);
  assert.equal(recovered.load.diskAvailableBytes, disk.available);
  assert.equal(f.calls.gpu, 3);
  assert.equal(f.calls.disk, 3);
  f.sampler.dispose();
});

test('CPU reader failures reset the baseline and memory failure does not fabricate capacity', async () => {
  const f = fixture();
  assert.equal((await f.ready()).load.cpuPercent, null);
  f.advance(1000);
  assert.equal(f.sampler.sample(input)!.load.cpuPercent, 30);
  const readCpu = f.readers.cpuTimes;
  f.readers.cpuTimes = () => {
    throw new Error('fixture CPU unavailable');
  };
  f.advance(1000);
  assert.equal(f.sampler.sample(input)!.load.cpuPercent, null);
  f.readers.cpuTimes = readCpu;
  f.advance(1000);
  assert.equal(f.sampler.sample(input)!.load.cpuPercent, null, 'recovery needs a new baseline');
  f.advance(1000);
  assert.equal(f.sampler.sample(input)!.load.cpuPercent, 30);
  f.readers.memory = () => {
    throw new Error('fixture memory unavailable');
  };
  f.advance(1000);
  assert.equal(f.sampler.sample(input), null);
  f.sampler.dispose();
  await settle();
});

test('sampler disposal cancels process probes and ignores late hardware or disk completions', async () => {
  const inventory = deferred<WorkerHardware | null>();
  const pendingDisk = deferred<typeof disk>();
  let hardwareSignal: AbortSignal | undefined;
  const f = fixture({
    hardware: (_root, signal) => {
      hardwareSignal = signal;
      return inventory.promise;
    },
    disk: () => pendingDisk.promise,
  });
  f.sampler.sample(input);
  await settle();
  assert.equal(hardwareSignal?.aborted, false);
  f.sampler.dispose();
  assert.equal(hardwareSignal?.aborted, true);
  inventory.resolve(hardware);
  pendingDisk.resolve(disk);
  await settle();
  assert.equal(f.sampler.hardware, null);
  assert.equal(f.sampler.sample(input), null);
  assert.deepEqual(f.calls, { hardware: 1, cpu: 0, memory: 0, gpu: 0, disk: 1 });
});

test('sampler disposal prevents queued probes from launching and aborts an active GPU read', async () => {
  const queued = fixture();
  queued.sampler.sample(input);
  queued.sampler.dispose();
  await settle();
  assert.deepEqual(queued.calls, { hardware: 0, cpu: 0, memory: 0, gpu: 0, disk: 0 });

  const pendingGpu = deferred<typeof gpu>();
  let gpuSignal: AbortSignal | undefined;
  const active = fixture({
    gpu: (_memory, signal) => {
      gpuSignal = signal;
      return pendingGpu.promise;
    },
  });
  await active.ready();
  assert.equal(gpuSignal?.aborted, false);
  active.sampler.dispose();
  assert.equal(gpuSignal?.aborted, true);
  pendingGpu.resolve(gpu);
  await settle();
  assert.equal(active.sampler.sample(input), null);
  assert.equal(active.calls.gpu, 1);
});
