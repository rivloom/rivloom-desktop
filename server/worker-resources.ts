import { execFile, spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
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
  const requirements = task.requirements;
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
  if (requirements.gpu === false && worker.hardware.gpus.length > 0) return false;
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

export function rankBrainPlacements(
  brains: BrainTopology[],
  task: TaskPlacementRequirements,
  at = Date.now(),
) {
  const placements = brains
    .filter((brain) => brain.state === 'established' && brain.online)
    .flatMap((brain) => {
      const worker = rankWorkers(brain.workers, task, at)[0];
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

function windowsInventory(): WindowsInventory {
  if (process.platform !== 'win32') return {};
  const script = `
$ErrorActionPreference = 'Stop'
$cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; physicalCores = [int]$_.NumberOfCores; logicalCores = [int]$_.NumberOfLogicalProcessors } })
$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; memoryBytes = $null } })
[Console]::Out.Write((@{ cpu = $cpu; gpu = $gpu } | ConvertTo-Json -Depth 5 -Compress))
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout.trim()) return {};
  try {
    return JSON.parse(result.stdout) as WindowsInventory;
  } catch {
    return {};
  }
}

function diskSpace(root: string) {
  try {
    const value = statfsSync(root);
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

function nvidiaMemory() {
  // Win32_VideoController.AdapterRAM is UInt32 and cannot represent modern VRAM sizes.
  const result = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 },
  );
  return result.status === 0 ? parseNvidiaMemory(result.stdout) : new Map<string, number>();
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

async function windowsGpuLoad(totalGpuMemory: number | null) {
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
  const result = await new Promise<{ status: number; stdout: string }>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 3_000, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve({ status: error ? 1 : 0, stdout }),
    );
  });
  if (result.status !== 0 || !result.stdout.trim()) return { percent: null, memoryAvailable: null };
  try {
    const value = JSON.parse(result.stdout) as { utilization?: unknown; dedicated?: unknown };
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

export function collectWorkerHardware(root: string): WorkerHardware {
  const osCpus = cpus();
  const inventory = windowsInventory();
  const reliableGpuMemory = nvidiaMemory();
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
    diskBytes: diskSpace(root).total,
    collectedAt: new Date().toISOString(),
  };
}

export class WorkerResourceSampler {
  readonly hardware: WorkerHardware;
  private previousCpu = cpuTimes();
  private gpuSample = {
    at: 0,
    percent: null as number | null,
    memoryAvailable: null as number | null,
  };
  private readonly root: string;
  private gpuSampling = false;

  constructor(root: string) {
    this.root = root;
    this.hardware = collectWorkerHardware(root);
  }

  sample(input: {
    accepting: boolean;
    projects: WorkerProject[];
    runningTasks: number;
    maxConcurrent: number;
    nodeID: string;
  }): WorkerRegistration {
    const currentCpu = cpuTimes();
    const totalDelta = currentCpu.total - this.previousCpu.total;
    const idleDelta = currentCpu.idle - this.previousCpu.idle;
    this.previousCpu = currentCpu;
    const memoryTotal = Math.max(1, totalmem());
    const memoryAvailable = Math.max(0, freemem());
    const disk = diskSpace(this.root);
    if (!this.gpuSampling && Date.now() - this.gpuSample.at >= 5_000) {
      const knownGpuMemory = this.hardware.gpus.every((gpu) => gpu.memoryBytes !== null)
        ? this.hardware.gpus.reduce((total, gpu) => total + (gpu.memoryBytes || 0), 0)
        : null;
      // CIM queries can take seconds. Never block task admission or encrypted heartbeats.
      this.gpuSampling = true;
      void windowsGpuLoad(knownGpuMemory)
        .then((sample) => {
          this.gpuSample = { at: Date.now(), ...sample };
        })
        .finally(() => {
          this.gpuSampling = false;
        });
    }
    return {
      nodeID: input.nodeID,
      accepting: input.accepting,
      projects: input.projects.map((project) => ({ ...project })),
      hardware: {
        ...this.hardware,
        gpus: this.hardware.gpus.map((gpu) => ({ ...gpu })),
      },
      load: {
        cpuPercent:
          totalDelta > 0
            ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100))
            : null,
        memoryAvailableBytes: memoryAvailable,
        memoryUsedPercent: Math.max(
          0,
          Math.min(100, ((memoryTotal - memoryAvailable) / memoryTotal) * 100),
        ),
        gpuPercent: this.gpuSample.percent,
        gpuMemoryAvailableBytes: this.gpuSample.memoryAvailable,
        diskAvailableBytes: disk.available,
        runningTasks: Math.max(0, Math.trunc(input.runningTasks)),
        availableSlots: input.accepting
          ? Math.max(0, Math.trunc(input.maxConcurrent) - Math.max(0, input.runningTasks))
          : 0,
        sampledAt: new Date().toISOString(),
      },
    };
  }
}
