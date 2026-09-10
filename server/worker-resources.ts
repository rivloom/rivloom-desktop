import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import type {
  BrainTopology,
  TaskPlacementRequirements,
  WorkerHardware,
  WorkerLoad,
  WorkerProject,
  WorkerRegistration,
} from '../shared/types.ts';

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const workerReportFreshMilliseconds = 30_000;

function finiteInteger(value: unknown, minimum = 0) {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function percentage(value: unknown, nullable = false) {
  return (
    (nullable && value === null) ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
  );
}

function validDate(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validWorkerHardware(value: unknown): value is WorkerHardware {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, [
      'architecture',
      'collectedAt',
      'cpuModel',
      'diskBytes',
      'gpus',
      'logicalCores',
      'memoryBytes',
      'physicalCores',
      'platform',
      'release',
    ]) ||
    typeof item.platform !== 'string' ||
    item.platform.length < 1 ||
    item.platform.length > 40 ||
    typeof item.release !== 'string' ||
    item.release.length > 80 ||
    typeof item.architecture !== 'string' ||
    item.architecture.length < 1 ||
    item.architecture.length > 40 ||
    typeof item.cpuModel !== 'string' ||
    item.cpuModel.length < 1 ||
    item.cpuModel.length > 160 ||
    !(item.physicalCores === null || finiteInteger(item.physicalCores, 1)) ||
    !finiteInteger(item.logicalCores, 1) ||
    !finiteInteger(item.memoryBytes, 1) ||
    !(item.diskBytes === null || finiteInteger(item.diskBytes, 0)) ||
    !validDate(item.collectedAt) ||
    !Array.isArray(item.gpus) ||
    item.gpus.length > 16
  )
    return false;
  return item.gpus.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const gpu = value as Record<string, unknown>;
    return (
      exactKeys(gpu, ['memoryBytes', 'name']) &&
      typeof gpu.name === 'string' &&
      gpu.name.length >= 1 &&
      gpu.name.length <= 160 &&
      (gpu.memoryBytes === null || finiteInteger(gpu.memoryBytes, 0))
    );
  });
}

export function validWorkerLoad(value: unknown): value is WorkerLoad {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, [
      'availableSlots',
      'cpuPercent',
      'diskAvailableBytes',
      'gpuMemoryAvailableBytes',
      'gpuPercent',
      'memoryAvailableBytes',
      'memoryUsedPercent',
      'runningTasks',
      'sampledAt',
    ]) &&
    percentage(item.cpuPercent, true) &&
    finiteInteger(item.memoryAvailableBytes, 0) &&
    percentage(item.memoryUsedPercent) &&
    percentage(item.gpuPercent, true) &&
    (item.gpuMemoryAvailableBytes === null || finiteInteger(item.gpuMemoryAvailableBytes, 0)) &&
    (item.diskAvailableBytes === null || finiteInteger(item.diskAvailableBytes, 0)) &&
    finiteInteger(item.runningTasks, 0) &&
    finiteInteger(item.availableSlots, 0) &&
    validDate(item.sampledAt)
  );
}

export function validWorkerRegistration(value: unknown): value is WorkerRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, ['accepting', 'hardware', 'load', 'nodeID', 'projects']) &&
    typeof item.nodeID === 'string' &&
    nodePattern.test(item.nodeID) &&
    typeof item.accepting === 'boolean' &&
    Array.isArray(item.projects) &&
    item.projects.length <= 32 &&
    item.projects.every((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const project = value as Record<string, unknown>;
      return (
        exactKeys(project, ['id', 'name']) &&
        typeof project.id === 'string' &&
        uuidPattern.test(project.id) &&
        typeof project.name === 'string' &&
        project.name.length >= 1 &&
        project.name.length <= 120
      );
    }) &&
    validWorkerHardware(item.hardware) &&
    validWorkerLoad(item.load)
  );
}

export function workerReportFresh(worker: WorkerRegistration, at = Date.now()) {
  const sampledAt = Date.parse(worker.load.sampledAt);
  return Number.isFinite(sampledAt) && Math.abs(at - sampledAt) <= workerReportFreshMilliseconds;
}

export function workerMatchesTask(
  worker: WorkerRegistration,
  task: TaskPlacementRequirements,
  at = Date.now(),
) {
  if (!validWorkerRegistration(worker) || !worker.accepting || !workerReportFresh(worker, at))
    return false;
  if (worker.load.availableSlots < 1) return false;
  if (task.projectID && !worker.projects.some((project) => project.id === task.projectID))
    return false;
  return workerHardwareMatches(worker.hardware, task.requirements);
}

/** Queue placement checks compatibility without pretending a busy worker has a free execution slot. */
export function workerCanQueueTask(worker: WorkerRegistration, task: TaskPlacementRequirements, at = Date.now()) {
  return validWorkerRegistration(worker) && worker.accepting && workerReportFresh(worker, at) &&
    (!task.projectID || worker.projects.some((project) => project.id === task.projectID)) &&
    workerHardwareMatches(worker.hardware, task.requirements);
}
export function workerHardwareMatches(hardware: WorkerHardware, requirements: TaskPlacementRequirements['requirements']) {
  const worker = { hardware };
  if (requirements.platform && requirements.platform !== worker.hardware.platform) return false;
  if (requirements.architecture && requirements.architecture !== worker.hardware.architecture)
    return false;
  if (
    requirements.minimumLogicalCores !== undefined &&
    worker.hardware.logicalCores < requirements.minimumLogicalCores
  )
    return false;
  if (
    requirements.minimumMemoryBytes !== undefined &&
    worker.hardware.memoryBytes < requirements.minimumMemoryBytes
  )
    return false;
  if (requirements.gpu === true && worker.hardware.gpus.length === 0) return false;
  if (requirements.minimumGpuMemoryBytes !== undefined) {
    const maximum = Math.max(-1, ...worker.hardware.gpus.map((gpu) => gpu.memoryBytes ?? -1));
    if (maximum < requirements.minimumGpuMemoryBytes) return false;
  }
  return true;
}

function loadScore(worker: WorkerRegistration) {
  const cpu = worker.load.cpuPercent ?? 50;
  const gpu = worker.load.gpuPercent ?? 50;
  return (
    -worker.load.availableSlots * 10_000 +
    worker.load.runningTasks * 1000 +
    cpu * 5 +
    worker.load.memoryUsedPercent * 3 +
    gpu
  );
}

export function rankWorkers(
  workers: WorkerRegistration[],
  task: TaskPlacementRequirements,
  at = Date.now(),
) {
  return workers
    .filter((worker) => workerMatchesTask(worker, task, at))
    .sort(
      (left, right) =>
        loadScore(left) - loadScore(right) || left.nodeID.localeCompare(right.nodeID),
    );
}

export function rankBrainWorkers(
  brain: Pick<BrainTopology, 'masterNodeID' | 'workers'>,
  task: TaskPlacementRequirements,
  at = Date.now(),
) {
  // Dispatch currently requires a different Node, even when the caller is a remote submitter.
  // This Node remains eligible as a Worker for any other Brain's Master.
  return rankWorkers(
    brain.workers.filter((worker) => worker.nodeID !== brain.masterNodeID),
    task,
    at,
  );
}

export function rankBrainPlacements(
  brains: BrainTopology[],
  task: TaskPlacementRequirements,
  at = Date.now(),
) {
  const placements = brains
    .filter((brain) => brain.state === 'established' && brain.online)
    .flatMap((brain) => {
      const worker = rankBrainWorkers(brain, task, at)[0];
      return worker ? [{ brain, worker }] : [];
    });
  return placements.sort((left, right) => {
    const ranked = rankWorkers([left.worker, right.worker], task, at);
    if (ranked[0]?.nodeID === left.worker.nodeID && left.worker.nodeID !== right.worker.nodeID)
      return -1;
    if (ranked[0]?.nodeID === right.worker.nodeID && left.worker.nodeID !== right.worker.nodeID)
      return 1;
    return (
      left.brain.queueDepth - right.brain.queueDepth ||
      left.brain.id.localeCompare(right.brain.id) ||
      left.worker.nodeID.localeCompare(right.worker.nodeID)
    );
  });
}

type WindowsInventory = {
  cpu?: { name?: unknown; physicalCores?: unknown; logicalCores?: unknown }[];
  gpu?: { name?: unknown; memoryBytes?: unknown }[];
};

function commandOutput(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer, signal },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function windowsInventory(signal?: AbortSignal): Promise<WindowsInventory | null> {
  if (process.platform !== 'win32') return { cpu: [], gpu: [] };
  const script = `
$ErrorActionPreference = 'Stop'
$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; physicalCores = [int]$_.NumberOfCores; logicalCores = [int]$_.NumberOfLogicalProcessors } })
$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; memoryBytes = $null } })
[Console]::Out.Write((@{ cpu = $cpu; gpu = $gpu } | ConvertTo-Json -Depth 5 -Compress))
`;
  const output = await commandOutput(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    10_000,
    1024 * 1024,
    signal,
  );
  if (!output?.trim()) return null;
  try {
    const inventory = JSON.parse(output) as WindowsInventory | null;
    // A failed inventory must not turn an unknown GPU into a confirmed GPU-free worker.
    return inventory && Array.isArray(inventory.cpu) && Array.isArray(inventory.gpu)
      ? inventory
      : null;
  } catch {
    return null;
  }
}

async function diskSpace(root: string) {
  try {
    const value = await statfs(root);
    return {
      total: Math.max(0, Math.trunc(value.bsize * value.blocks)),
      available: Math.max(0, Math.trunc(value.bsize * value.bavail)),
    };
  } catch {
    return { total: null, available: null };
  }
}

export function parseNvidiaMemory(output: string) {
  const result = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+),\s*(\d+)$/);
    if (!match) continue;
    const bytes = Number(match[2]) * 1024 ** 2;
    if (Number.isSafeInteger(bytes) && bytes > 0) result.set(match[1].trim(), bytes);
  }
  return result;
}

async function nvidiaMemory(signal?: AbortSignal) {
  // Win32_VideoController.AdapterRAM is UInt32 and cannot represent modern VRAM sizes.
  const output = await commandOutput(
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    3000,
    64 * 1024,
    signal,
  );
  return output === null ? new Map<string, number>() : parseNvidiaMemory(output);
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus())
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === 'idle') idle += value;
    }
  return { idle, total };
}

async function windowsGpuLoad(totalGpuMemory: number | null, signal?: AbortSignal) {
  if (process.platform !== 'win32')
    return { percent: null as number | null, memoryAvailable: null as number | null };
  const script = `
$ErrorActionPreference = 'Stop'
$engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match 'engtype_(3D|Compute)' })
$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUMemory)
$utilization = ($engines | Measure-Object -Property UtilizationPercentage -Sum).Sum
$dedicated = ($memory | Measure-Object -Property DedicatedUsage -Sum).Sum
[Console]::Out.Write((@{ utilization = if ($null -eq $utilization) { $null } else { [double]$utilization }; dedicated = if ($null -eq $dedicated) { $null } else { [int64]$dedicated } } | ConvertTo-Json -Compress))
`;
  const output = await commandOutput(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    3000,
    256 * 1024,
    signal,
  );
  if (!output?.trim()) return { percent: null, memoryAvailable: null };
  try {
    const value = JSON.parse(output) as { utilization?: unknown; dedicated?: unknown };
    const percent =
      typeof value.utilization === 'number' && Number.isFinite(value.utilization)
        ? Math.max(0, Math.min(100, value.utilization))
        : null;
    const dedicated =
      typeof value.dedicated === 'number' &&
      Number.isSafeInteger(value.dedicated) &&
      value.dedicated >= 0
        ? value.dedicated
        : null;
    return {
      percent,
      memoryAvailable:
        totalGpuMemory !== null && dedicated !== null
          ? Math.max(0, totalGpuMemory - dedicated)
          : null,
    };
  } catch {
    return { percent: null, memoryAvailable: null };
  }
}

export async function collectWorkerHardware(
  _root: string,
  signal?: AbortSignal,
): Promise<WorkerHardware | null> {
  const osCpus = cpus();
  const inventory = await windowsInventory(signal);
  if (!inventory) return null;
  const reliableGpuMemory = inventory.gpu?.some(
    (gpu) => typeof gpu.name === 'string' && /nvidia/i.test(gpu.name),
  )
    ? await nvidiaMemory(signal)
    : new Map<string, number>();
  const processors = Array.isArray(inventory.cpu) ? inventory.cpu : [];
  const gpus = (Array.isArray(inventory.gpu) ? inventory.gpu : [])
    .map((gpu) => ({
      name: typeof gpu.name === 'string' && gpu.name.trim() ? gpu.name.trim().slice(0, 160) : '',
      memoryBytes:
        typeof gpu.name === 'string' ? (reliableGpuMemory.get(gpu.name.trim()) ?? null) : null,
    }))
    .filter((gpu) => gpu.name);
  const physicalCores = processors
    .map((cpu) => Number(cpu.physicalCores))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((total, value) => total + value, 0);
  const logicalFromInventory = processors
    .map((cpu) => Number(cpu.logicalCores))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((total, value) => total + value, 0);
  return {
    platform: platform(),
    release: release().slice(0, 80),
    architecture: arch(),
    cpuModel:
      (processors.find((cpu) => typeof cpu.name === 'string')?.name as string | undefined)
        ?.trim()
        .slice(0, 160) ||
      osCpus[0]?.model.trim().slice(0, 160) ||
      'Unknown CPU',
    physicalCores: physicalCores || null,
    logicalCores: logicalFromInventory || Math.max(1, osCpus.length),
    memoryBytes: Math.max(1, totalmem()),
    gpus,
    // Disk sampling is independent: an unavailable filesystem must not hold up inventory.
    diskBytes: null,
    collectedAt: new Date().toISOString(),
  };
}

type CpuTimes = { idle: number; total: number };
type DiskSpace = { total: number | null; available: number | null };
type GpuLoad = { percent: number | null; memoryAvailable: number | null };
type MemorySample = { total: number; available: number };
export type WorkerResourceDependencies = {
  clock: () => number;
  cpuTimes: () => CpuTimes;
  memory: () => MemorySample;
  hardware: (root: string, signal: AbortSignal) => Promise<WorkerHardware | null>;
  disk: (root: string) => Promise<DiskSpace>;
  gpu: (totalGpuMemory: number | null, signal: AbortSignal) => Promise<GpuLoad>;
};
const osSampleMilliseconds = 1000;
const externalSampleMilliseconds = 5000;
const externalSampleFreshMilliseconds = 20_000;
const failedSampleRetryMilliseconds = 30_000;

function due(at: number | null, now: number, interval: number) {
  return at === null || now < at || now - at >= interval;
}

/** Demand-driven sampling shares resource measurements, never task-admission decisions. */
export class WorkerResourceSampler {
  private hardwareValue: WorkerHardware | null = null;
  private readonly dependencies: WorkerResourceDependencies;
  private readonly root: string;
  private readonly controller = new AbortController();
  private disposed = false;
  private hardwareSampling = false;
  private hardwareAttemptAt: number | null = null;
  private previousCpu: CpuTimes | null = null;
  private osSample: {
    at: number;
    cpuPercent: number | null;
    memory: MemorySample | null;
  } | null = null;
  private gpuSampling = false;
  private gpuAttemptAt: number | null = null;
  private gpuRetryMilliseconds = externalSampleMilliseconds;
  private gpuSample: (GpuLoad & { at: number }) | null = null;
  private diskSampling = false;
  private diskAttemptAt: number | null = null;
  private diskRetryMilliseconds = externalSampleMilliseconds;
  private diskSample: (DiskSpace & { at: number }) | null = null;

  constructor(root: string, dependencies: Partial<WorkerResourceDependencies> = {}) {
    this.root = root;
    this.dependencies = {
      clock: Date.now,
      cpuTimes,
      memory: () => ({ total: Math.max(1, totalmem()), available: Math.max(0, freemem()) }),
      hardware: collectWorkerHardware,
      disk: diskSpace,
      gpu: windowsGpuLoad,
      ...dependencies,
    };
  }

  get hardware(): WorkerHardware | null {
    return this.hardwareValue;
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
  }

  private refreshHardware(at: number) {
    if (
      this.hardwareValue ||
      this.hardwareSampling ||
      !due(this.hardwareAttemptAt, at, failedSampleRetryMilliseconds)
    )
      return;
    this.hardwareSampling = true;
    this.hardwareAttemptAt = at;
    void Promise.resolve()
      .then(() =>
        this.disposed ? null : this.dependencies.hardware(this.root, this.controller.signal),
      )
      .then((hardware) => {
        if (!this.disposed && validWorkerHardware(hardware)) this.hardwareValue = hardware;
      })
      .catch(() => undefined)
      .finally(() => {
        this.hardwareAttemptAt = this.dependencies.clock();
        this.hardwareSampling = false;
      });
  }

  private refreshDisk(at: number) {
    if (this.diskSampling || !due(this.diskAttemptAt, at, this.diskRetryMilliseconds)) return;
    this.diskSampling = true;
    this.diskAttemptAt = at;
    void Promise.resolve()
      .then(() =>
        this.disposed ? { total: null, available: null } : this.dependencies.disk(this.root),
      )
      .catch(() => ({ total: null, available: null }))
      .then((disk) => {
        if (this.disposed) return;
        this.diskSample = { ...disk, at: this.dependencies.clock() };
        this.diskRetryMilliseconds =
          disk.available === null ? failedSampleRetryMilliseconds : externalSampleMilliseconds;
      })
      .finally(() => {
        this.diskAttemptAt = this.dependencies.clock();
        this.diskSampling = false;
      });
  }

  private refreshGpu(at: number) {
    const hardware = this.hardwareValue;
    if (
      !hardware?.gpus.length ||
      this.gpuSampling ||
      !due(this.gpuAttemptAt, at, this.gpuRetryMilliseconds)
    )
      return;
    const knownGpuMemory = hardware.gpus.every((gpu) => gpu.memoryBytes !== null)
      ? hardware.gpus.reduce((total, gpu) => total + (gpu.memoryBytes || 0), 0)
      : null;
    this.gpuSampling = true;
    this.gpuAttemptAt = at;
    void Promise.resolve()
      .then(() =>
        this.disposed
          ? { percent: null, memoryAvailable: null }
          : this.dependencies.gpu(knownGpuMemory, this.controller.signal),
      )
      .catch(() => ({ percent: null, memoryAvailable: null }))
      .then((sample) => {
        if (this.disposed) return;
        this.gpuSample = { ...sample, at: this.dependencies.clock() };
        this.gpuRetryMilliseconds =
          sample.percent === null && sample.memoryAvailable === null
            ? failedSampleRetryMilliseconds
            : externalSampleMilliseconds;
      })
      .finally(() => {
        this.gpuAttemptAt = this.dependencies.clock();
        this.gpuSampling = false;
      });
  }

  private sampleOs(at: number) {
    if (this.osSample && !due(this.osSample.at, at, osSampleMilliseconds)) return this.osSample;
    let cpuPercent: number | null = null;
    try {
      const currentCpu = this.dependencies.cpuTimes();
      if (this.previousCpu) {
        const totalDelta = currentCpu.total - this.previousCpu.total;
        const idleDelta = currentCpu.idle - this.previousCpu.idle;
        if (
          Number.isFinite(totalDelta) &&
          Number.isFinite(idleDelta) &&
          totalDelta > 0 &&
          idleDelta >= 0
        )
          cpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
      }
      this.previousCpu = currentCpu;
    } catch {
      this.previousCpu = null;
    }
    let memory: MemorySample | null = null;
    try {
      const value = this.dependencies.memory();
      if (finiteInteger(value.total, 1) && finiteInteger(value.available)) memory = value;
    } catch {
      // Memory is mandatory in the wire format; suppress a report rather than fabricate it.
    }
    this.osSample = { at, cpuPercent, memory };
    return this.osSample;
  }

  sample(input: {
    accepting: boolean;
    projects: WorkerProject[];
    runningTasks: number;
    maxConcurrent: number;
    nodeID: string;
  }): WorkerRegistration | null {
    if (this.disposed) return null;
    const at = this.dependencies.clock();
    this.refreshHardware(at);
    this.refreshDisk(at);
    const hardware = this.hardwareValue;
    if (!hardware) return null;
    this.refreshGpu(at);
    const os = this.sampleOs(at);
    if (!os.memory) return null;
    const { total: memoryTotal, available: memoryAvailable } = os.memory;
    const disk =
      this.diskSample && !due(this.diskSample.at, at, externalSampleFreshMilliseconds)
        ? this.diskSample
        : null;
    const gpu =
      this.gpuSample && !due(this.gpuSample.at, at, externalSampleFreshMilliseconds)
        ? this.gpuSample
        : null;
    return {
      nodeID: input.nodeID,
      accepting: input.accepting,
      projects: input.projects.map((project) => ({ ...project })),
      hardware: {
        ...hardware,
        diskBytes: disk?.total ?? hardware.diskBytes,
        gpus: hardware.gpus.map((gpu) => ({ ...gpu })),
      },
      load: {
        cpuPercent: os.cpuPercent,
        memoryAvailableBytes: memoryAvailable,
        memoryUsedPercent: Math.max(
          0,
          Math.min(100, ((memoryTotal - memoryAvailable) / memoryTotal) * 100),
        ),
        gpuPercent: gpu?.percent ?? null,
        gpuMemoryAvailableBytes: gpu?.memoryAvailable ?? null,
        diskAvailableBytes: disk?.available ?? null,
        runningTasks: Math.max(0, Math.trunc(input.runningTasks)),
        availableSlots: input.accepting
          ? Math.max(0, Math.trunc(input.maxConcurrent) - Math.max(0, input.runningTasks))
          : 0,
        sampledAt: new Date(os.at).toISOString(),
      },
    };
  }
}
