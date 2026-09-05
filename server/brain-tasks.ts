import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BrainTask,
  BrainTaskExecution,
  RemoteTaskInvite,
  TaskHardwareRequirements,
} from '../shared/types.ts';

export type BrainTaskSubmissionMessage = {
  type: 'brain-task-submission';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  submitterNodeID: string;
  brainID: string;
  masterNodeID: string;
  title: string;
  description: string;
  criteria: string;
  requestedProjectID: string | null;
  requirements: TaskHardwareRequirements;
  createdAt: string;
};

export type BrainTaskUpdateMessage = {
  type: 'brain-task-update';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  submitterNodeID: string;
  brainID: string;
  masterNodeID: string;
  status: Exclude<BrainTask['status'], 'submitting'>;
  selectedWorkerID: string | null;
  executionID: string | null;
  executionSequence: number;
  executionSummary: string;
  executionAttempt: number;
  executions: BrainTaskExecution[];
  retryNotBefore: string | null;
  updatedAt: string;
};

export type BrainTaskMessage = BrainTaskSubmissionMessage | BrainTaskUpdateMessage;

type StoredBrainTask = BrainTask & { idempotencyKey: string };
type StoredBrainTasks = { version: 2; tasks: StoredBrainTask[] };

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = [
  'submitting',
  'queued',
  'assigned',
  'running',
  'waiting',
  'review',
  'completed',
  'failed',
] as const;

function validDate(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validRequirements(value: unknown): value is TaskHardwareRequirements {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'platform',
    'architecture',
    'minimumLogicalCores',
    'minimumMemoryBytes',
    'gpu',
    'minimumGpuMemoryBytes',
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) return false;
  return (
    (item.platform === undefined ||
      (typeof item.platform === 'string' &&
        item.platform.length >= 1 &&
        item.platform.length <= 40)) &&
    (item.architecture === undefined ||
      (typeof item.architecture === 'string' &&
        item.architecture.length >= 1 &&
        item.architecture.length <= 40)) &&
    (item.minimumLogicalCores === undefined ||
      (Number.isSafeInteger(item.minimumLogicalCores) && Number(item.minimumLogicalCores) >= 1)) &&
    (item.minimumMemoryBytes === undefined ||
      (Number.isSafeInteger(item.minimumMemoryBytes) && Number(item.minimumMemoryBytes) >= 1)) &&
    (item.gpu === undefined || typeof item.gpu === 'boolean') &&
    (item.minimumGpuMemoryBytes === undefined ||
      (Number.isSafeInteger(item.minimumGpuMemoryBytes) && Number(item.minimumGpuMemoryBytes) >= 1))
  );
}

function validExecution(value: unknown): value is BrainTaskExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(item.attempt) &&
    Number(item.attempt) >= 1 &&
    Number(item.attempt) <= 20 &&
    typeof item.executionID === 'string' &&
    uuidPattern.test(item.executionID) &&
    typeof item.workerNodeID === 'string' &&
    nodePattern.test(item.workerNodeID) &&
    ['assigned', 'running', 'waiting', 'review', 'completed', 'failed'].includes(
      String(item.status),
    ) &&
    Number.isSafeInteger(item.sequence) &&
    Number(item.sequence) >= 0 &&
    typeof item.summary === 'string' &&
    item.summary.length <= 12_000 &&
    validDate(item.createdAt) &&
    validDate(item.updatedAt)
  );
}

function validExecutionState(item: Record<string, unknown>) {
  if (!Array.isArray(item.executions) || !item.executions.every(validExecution)) return false;
  const executions = item.executions as BrainTaskExecution[];
  if (
    executions.some((execution, index) => execution.attempt !== index + 1) ||
    new Set(executions.map((execution) => execution.executionID)).size !== executions.length
  )
    return false;
  if (executions.length === 0)
    return (
      item.executionAttempt === 0 &&
      item.executionID === null &&
      item.selectedWorkerID === null &&
      item.executionSequence === 0
    );
  const current = executions.at(-1)!;
  if (item.executionID === null)
    return (
      item.status === 'queued' && item.selectedWorkerID === null && item.executionSequence === 0
    );
  return (
    item.executionID === current.executionID &&
    item.selectedWorkerID === current.workerNodeID &&
    item.executionSequence === current.sequence &&
    item.executionSummary === current.summary
  );
}

function validBase(item: Record<string, unknown>) {
  return (
    item.version === 1 &&
    typeof item.taskID === 'string' &&
    uuidPattern.test(item.taskID) &&
    typeof item.idempotencyKey === 'string' &&
    uuidPattern.test(item.idempotencyKey) &&
    typeof item.submitterNodeID === 'string' &&
    nodePattern.test(item.submitterNodeID) &&
    typeof item.brainID === 'string' &&
    uuidPattern.test(item.brainID) &&
    typeof item.masterNodeID === 'string' &&
    nodePattern.test(item.masterNodeID)
  );
}

export function validBrainTaskSubmission(value: unknown): value is BrainTaskSubmissionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'brain-task-submission' &&
    validBase(item) &&
    typeof item.title === 'string' &&
    item.title.trim().length >= 1 &&
    item.title.length <= 120 &&
    typeof item.description === 'string' &&
    item.description.trim().length >= 1 &&
    item.description.length <= 4000 &&
    typeof item.criteria === 'string' &&
    item.criteria.trim().length >= 1 &&
    item.criteria.length <= 2000 &&
    (item.requestedProjectID === null ||
      (typeof item.requestedProjectID === 'string' && uuidPattern.test(item.requestedProjectID))) &&
    validRequirements(item.requirements) &&
    validDate(item.createdAt) &&
    Date.parse(String(item.createdAt)) <= Date.now() + 60_000
  );
}

export function validBrainTaskUpdate(value: unknown): value is BrainTaskUpdateMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'brain-task-update' &&
    validBase(item) &&
    statuses.includes(item.status as (typeof statuses)[number]) &&
    item.status !== 'submitting' &&
    (item.selectedWorkerID === null ||
      (typeof item.selectedWorkerID === 'string' && nodePattern.test(item.selectedWorkerID))) &&
    (item.executionID === null ||
      (typeof item.executionID === 'string' && uuidPattern.test(item.executionID))) &&
    Number.isSafeInteger(item.executionSequence) &&
    Number(item.executionSequence) >= 0 &&
    typeof item.executionSummary === 'string' &&
    item.executionSummary.length <= 12_000 &&
    Number.isSafeInteger(item.executionAttempt) &&
    Number(item.executionAttempt) >= 0 &&
    Number(item.executionAttempt) <= 20 &&
    Array.isArray(item.executions) &&
    item.executions.length === item.executionAttempt &&
    item.executions.every(validExecution) &&
    (item.retryNotBefore === null || validDate(item.retryNotBefore)) &&
    validExecutionState(item) &&
    validDate(item.updatedAt) &&
    Date.parse(String(item.updatedAt)) <= Date.now() + 60_000
  );
}

function validStored(value: unknown): value is StoredBrainTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    uuidPattern.test(item.id) &&
    typeof item.idempotencyKey === 'string' &&
    uuidPattern.test(item.idempotencyKey) &&
    (item.direction === 'submitted' || item.direction === 'owned') &&
    typeof item.submitterNodeID === 'string' &&
    nodePattern.test(item.submitterNodeID) &&
    typeof item.brainID === 'string' &&
    uuidPattern.test(item.brainID) &&
    typeof item.masterNodeID === 'string' &&
    nodePattern.test(item.masterNodeID) &&
    typeof item.title === 'string' &&
    item.title.trim().length >= 1 &&
    item.title.length <= 120 &&
    typeof item.description === 'string' &&
    item.description.trim().length >= 1 &&
    item.description.length <= 4000 &&
    typeof item.criteria === 'string' &&
    item.criteria.trim().length >= 1 &&
    item.criteria.length <= 2000 &&
    (item.requestedProjectID === null ||
      (typeof item.requestedProjectID === 'string' && uuidPattern.test(item.requestedProjectID))) &&
    validRequirements(item.requirements) &&
    statuses.includes(item.status as (typeof statuses)[number]) &&
    (item.selectedWorkerID === null ||
      (typeof item.selectedWorkerID === 'string' && nodePattern.test(item.selectedWorkerID))) &&
    (item.executionID === null ||
      (typeof item.executionID === 'string' && uuidPattern.test(item.executionID))) &&
    Number.isSafeInteger(item.executionSequence) &&
    Number(item.executionSequence) >= 0 &&
    typeof item.executionSummary === 'string' &&
    item.executionSummary.length <= 12_000 &&
    Number.isSafeInteger(item.executionAttempt) &&
    Number(item.executionAttempt) >= 0 &&
    Number(item.executionAttempt) <= 20 &&
    Array.isArray(item.executions) &&
    item.executions.length === item.executionAttempt &&
    item.executions.every(validExecution) &&
    (item.retryNotBefore === null || validDate(item.retryNotBefore)) &&
    validExecutionState(item) &&
    typeof item.deliveryPending === 'boolean' &&
    (item.deliveryError === null ||
      (typeof item.deliveryError === 'string' && item.deliveryError.length <= 200)) &&
    validDate(item.createdAt) &&
    validDate(item.updatedAt)
  );
}

function normalizeStored(value: unknown): StoredBrainTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as StoredBrainTask;
  if (
    item.executionAttempt !== undefined ||
    item.executions !== undefined ||
    item.retryNotBefore !== undefined
  )
    return validStored(item) ? item : null;
  const executions: BrainTaskExecution[] =
    item.executionID && item.selectedWorkerID
      ? [
          {
            attempt: 1,
            executionID: item.executionID,
            workerNodeID: item.selectedWorkerID,
            status:
              item.status === 'running' ||
              item.status === 'waiting' ||
              item.status === 'review' ||
              item.status === 'completed' ||
              item.status === 'failed'
                ? item.status
                : 'assigned',
            sequence: item.executionSequence,
            summary: item.executionSummary,
            createdAt: item.updatedAt,
            updatedAt: item.updatedAt,
          },
        ]
      : [];
  const normalized: StoredBrainTask = {
    ...item,
    executionAttempt: executions.length,
    executions,
    retryNotBefore: null,
  };
  return validStored(normalized) ? normalized : null;
}

function publicTask(task: StoredBrainTask): BrainTask {
  const { idempotencyKey: _idempotencyKey, ...value } = task;
  return structuredClone(value);
}

export class BrainTaskStore {
  private readonly path: string;
  private readonly tasks = new Map<string, StoredBrainTask>();

  constructor(root: string) {
    this.path = join(root, 'brain-tasks.json');
  }

  load() {
    this.tasks.clear();
    if (!existsSync(this.path)) return;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      throw new Error('Brain Task 记录损坏；节点网络保持关闭。');
    }
    const stored = value as { version?: unknown; tasks?: unknown[] };
    if (
      !value ||
      typeof value !== 'object' ||
      (stored.version !== 1 && stored.version !== 2) ||
      !Array.isArray(stored.tasks) ||
      stored.tasks.length > 500 ||
      new Set(stored.tasks.map((task) => (task as StoredBrainTask).id)).size !== stored.tasks.length
    )
      throw new Error('Brain Task 记录无效；节点网络保持关闭。');
    const normalized = stored.tasks.map(normalizeStored);
    if (normalized.some((task) => !task))
      throw new Error('Brain Task 记录无效；节点网络保持关闭。');
    for (const task of normalized as StoredBrainTask[])
      this.tasks.set(task.id, structuredClone(task));
    if (stored.version !== 2) this.save();
  }

  list() {
    return [...this.tasks.values()]
      .map(publicTask)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  record(taskID: string) {
    return this.tasks.get(taskID) || null;
  }

  create(
    direction: BrainTask['direction'],
    submitterNodeID: string,
    brainID: string,
    masterNodeID: string,
    input: {
      title: string;
      description: string;
      criteria: string;
      requestedProjectID: string | null;
      requirements: TaskHardwareRequirements;
    },
    taskID?: string,
  ) {
    const existing = taskID ? this.tasks.get(taskID) : null;
    if (existing) {
      if (existing.direction !== direction || existing.submitterNodeID !== submitterNodeID ||
          existing.brainID !== brainID || existing.masterNodeID !== masterNodeID ||
          existing.title !== input.title.trim() || existing.description !== input.description.trim() ||
          existing.criteria !== input.criteria.trim() || existing.requestedProjectID !== input.requestedProjectID ||
          JSON.stringify(existing.requirements) !== JSON.stringify(input.requirements))
        throw new Error('Brain Task 创建 ID 或内容冲突。');
      return publicTask(existing);
    }
    const createdAt = new Date().toISOString();
    const task: StoredBrainTask = {
      id: taskID ?? randomUUID(),
      idempotencyKey: randomUUID(),
      direction,
      submitterNodeID,
      brainID,
      masterNodeID,
      title: input.title.trim(),
      description: input.description.trim(),
      criteria: input.criteria.trim(),
      requestedProjectID: input.requestedProjectID,
      requirements: structuredClone(input.requirements),
      status: direction === 'owned' ? 'queued' : 'submitting',
      selectedWorkerID: null,
      executionID: null,
      executionSequence: 0,
      executionSummary: '',
      executionAttempt: 0,
      executions: [],
      retryNotBefore: null,
      deliveryPending: direction === 'submitted',
      deliveryError: null,
      createdAt,
      updatedAt: createdAt,
    };
    if (!validStored(task) || this.tasks.size >= 500)
      throw new Error('Brain Task 内容无效或数量已达上限。');
    this.tasks.set(task.id, task);
    try { this.save(); } catch (error) { this.tasks.delete(task.id); throw error; }
    return publicTask(task);
  }

  receiveSubmission(message: BrainTaskSubmissionMessage) {
    const existing = this.tasks.get(message.taskID);
    if (existing) {
      if (
        existing.idempotencyKey !== message.idempotencyKey ||
        existing.direction !== 'owned' ||
        existing.submitterNodeID !== message.submitterNodeID ||
        existing.brainID !== message.brainID ||
        existing.masterNodeID !== message.masterNodeID ||
        existing.title !== message.title ||
        existing.description !== message.description ||
        existing.criteria !== message.criteria ||
        existing.requestedProjectID !== message.requestedProjectID ||
        JSON.stringify(existing.requirements) !== JSON.stringify(message.requirements)
      )
        throw new Error('Brain Task ID 或幂等内容冲突。');
      return false;
    }
    const task: StoredBrainTask = {
      id: message.taskID,
      idempotencyKey: message.idempotencyKey,
      direction: 'owned',
      submitterNodeID: message.submitterNodeID,
      brainID: message.brainID,
      masterNodeID: message.masterNodeID,
      title: message.title,
      description: message.description,
      criteria: message.criteria,
      requestedProjectID: message.requestedProjectID,
      requirements: structuredClone(message.requirements),
      status: 'queued',
      selectedWorkerID: null,
      executionID: null,
      executionSequence: 0,
      executionSummary: '',
      executionAttempt: 0,
      executions: [],
      retryNotBefore: null,
      deliveryPending: true,
      deliveryError: null,
      createdAt: message.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (!validStored(task) || this.tasks.size >= 500) throw new Error('Brain Task 内容无效。');
    this.tasks.set(task.id, task);
    this.save();
    return true;
  }

  markWaitingForWorker(taskID: string, reason: string) {
    const task = this.tasks.get(taskID);
    const summary = reason.trim().slice(0, 12_000);
    if (!task || task.direction !== 'owned' || task.status !== 'queued' ||
        task.executionID !== null || !summary || task.executionSummary === summary)
      return false;
    task.executionSummary = summary;
    task.deliveryPending = task.submitterNodeID !== task.masterNodeID;
    task.deliveryError = null;
    task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
    this.save();
    return true;
  }

  assign(taskID: string, workerNodeID: string, executionID: string) {
    const task = this.tasks.get(taskID);
    if (
      !task ||
      task.direction !== 'owned' ||
      task.status !== 'queued' ||
      task.executionAttempt >= 8 ||
      !nodePattern.test(workerNodeID) ||
      !uuidPattern.test(executionID)
    )
      throw new Error('可调度的 Brain Task 不存在。');
    task.status = 'assigned';
    task.selectedWorkerID = workerNodeID;
    task.executionID = executionID;
    task.executionSequence = 0;
    task.executionSummary = '';
    task.executionAttempt += 1;
    const assignedAt = new Date().toISOString();
    task.executions.push({
      attempt: task.executionAttempt,
      executionID,
      workerNodeID,
      status: 'assigned',
      sequence: 0,
      summary: '',
      createdAt: assignedAt,
      updatedAt: assignedAt,
    });
    task.retryNotBefore = null;
    task.deliveryPending = task.submitterNodeID !== task.masterNodeID;
    task.deliveryError = null;
    task.updatedAt = assignedAt;
    this.save();
    return publicTask(task);
  }

  syncExecution(taskID: string, execution: RemoteTaskInvite, workerUnavailable = false) {
    const task = this.tasks.get(taskID);
    if (!task || task.direction !== 'owned' || task.executionID !== execution.id) return false;
    let status: BrainTask['status'] = 'assigned';
    if (
      execution.status === 'declined' ||
      execution.status === 'expired' ||
      execution.status === 'cancelled'
    )
      status = 'failed';
    else if (execution.executionState === 'accepted') status = 'completed';
    else if (execution.executionState === 'review') status = 'review';
    else if (execution.executionState === 'failed' || execution.executionState === 'stopped')
      status = 'failed';
    else if (
      execution.executionState === 'waiting_approval' ||
      execution.executionState === 'waiting_input' ||
      execution.executionState === 'interrupted'
    )
      status = 'waiting';
    else if (execution.executionSequence > 0) status = 'running';
    let summary = execution.executionSummary;
    if (
      execution.status === 'accepted' &&
      workerUnavailable &&
      !['completed', 'failed', 'review'].includes(status)
    ) {
      status = 'waiting';
      summary = 'Worker 已接受但目前离线，执行结果未知；等待恢复，不自动重派。';
    }
    if (
      task.status === status &&
      task.executionSequence === execution.executionSequence &&
      task.executionSummary === summary
    )
      return false;
    task.status = status;
    task.executionSequence = execution.executionSequence;
    task.executionSummary = summary;
    const attempt = task.executions.at(-1);
    if (attempt && attempt.executionID === execution.id) {
      attempt.status = status;
      attempt.sequence = execution.executionSequence;
      attempt.summary = summary;
      attempt.updatedAt = new Date().toISOString();
    }
    task.deliveryPending = task.submitterNodeID !== task.masterNodeID;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  requeueExecution(taskID: string, execution: RemoteTaskInvite, reason: string) {
    const task = this.tasks.get(taskID);
    if (
      !task ||
      task.direction !== 'owned' ||
      task.executionID !== execution.id ||
      execution.executionSequence !== 0 ||
      !['declined', 'expired', 'cancelled'].includes(execution.status)
    )
      return false;
    const attempt = task.executions.at(-1);
    if (!attempt || attempt.executionID !== execution.id) return false;
    const updatedAt = new Date().toISOString();
    attempt.status = 'failed';
    attempt.sequence = 0;
    attempt.summary = reason.slice(0, 12_000);
    attempt.updatedAt = updatedAt;
    task.executionSummary = attempt.summary;
    task.deliveryPending = task.submitterNodeID !== task.masterNodeID;
    task.deliveryError = null;
    task.updatedAt = updatedAt;
    if (task.executionAttempt >= 8) {
      task.status = 'failed';
      task.retryNotBefore = null;
    } else {
      task.status = 'queued';
      task.selectedWorkerID = null;
      task.executionID = null;
      task.executionSequence = 0;
      task.retryNotBefore = new Date(
        Date.now() + Math.min(30_000 * 2 ** Math.max(0, task.executionAttempt - 1), 300_000),
      ).toISOString();
    }
    this.save();
    return true;
  }

  receiveUpdate(message: BrainTaskUpdateMessage) {
    const task = this.tasks.get(message.taskID);
    if (
      !task ||
      task.direction !== 'submitted' ||
      task.idempotencyKey !== message.idempotencyKey ||
      task.submitterNodeID !== message.submitterNodeID ||
      task.brainID !== message.brainID ||
      task.masterNodeID !== message.masterNodeID
    )
      throw new Error('Brain Task 更新路由不匹配。');
    if (
      message.executionAttempt < task.executionAttempt ||
      (message.executionAttempt === task.executionAttempt &&
        message.executionSequence < task.executionSequence) ||
      (message.executionAttempt === task.executionAttempt &&
        message.executionSequence === task.executionSequence &&
        Date.parse(message.updatedAt) < Date.parse(task.updatedAt))
    )
      throw new Error('Brain Task 更新序号倒退。');
    for (let index = 0; index < Math.max(0, task.executions.length - 1); index += 1)
      if (JSON.stringify(task.executions[index]) !== JSON.stringify(message.executions[index]))
        throw new Error('Brain Task 历史 Execution 被改写。');
    for (let index = 0; index < task.executions.length; index += 1) {
      const current = task.executions[index];
      const incoming = message.executions[index];
      if (
        !incoming ||
        current.executionID !== incoming.executionID ||
        current.workerNodeID !== incoming.workerNodeID ||
        current.createdAt !== incoming.createdAt
      )
        throw new Error('Brain Task Execution 身份冲突。');
    }
    if (
      message.executionAttempt === task.executionAttempt &&
      message.executionSequence === task.executionSequence &&
      message.updatedAt === task.updatedAt
    ) {
      if (
        task.status === message.status &&
        task.selectedWorkerID === message.selectedWorkerID &&
        task.executionID === message.executionID &&
        task.executionSummary === message.executionSummary &&
        task.retryNotBefore === message.retryNotBefore &&
        JSON.stringify(task.executions) === JSON.stringify(message.executions)
      )
        return publicTask(task);
      throw new Error('Brain Task 同序更新内容冲突。');
    }
    task.status = message.status;
    task.selectedWorkerID = message.selectedWorkerID;
    task.executionID = message.executionID;
    task.executionSequence = message.executionSequence;
    task.executionSummary = message.executionSummary;
    task.executionAttempt = message.executionAttempt;
    task.executions = structuredClone(message.executions);
    task.retryNotBefore = message.retryNotBefore;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.updatedAt;
    this.save();
    return publicTask(task);
  }

  message(taskID: string): BrainTaskMessage | null {
    const task = this.tasks.get(taskID);
    if (!task?.deliveryPending) return null;
    const base = {
      version: 1 as const,
      taskID: task.id,
      idempotencyKey: task.idempotencyKey,
      submitterNodeID: task.submitterNodeID,
      brainID: task.brainID,
      masterNodeID: task.masterNodeID,
    };
    if (task.direction === 'submitted' && task.status === 'submitting')
      return {
        ...base,
        type: 'brain-task-submission',
        title: task.title,
        description: task.description,
        criteria: task.criteria,
        requestedProjectID: task.requestedProjectID,
        requirements: structuredClone(task.requirements),
        createdAt: task.createdAt,
      };
    if (task.direction === 'owned')
      return {
        ...base,
        type: 'brain-task-update',
        status: task.status as Exclude<BrainTask['status'], 'submitting'>,
        selectedWorkerID: task.selectedWorkerID,
        executionID: task.executionID,
        executionSequence: task.executionSequence,
        executionSummary: task.executionSummary,
        executionAttempt: task.executionAttempt,
        executions: structuredClone(task.executions),
        retryNotBefore: task.retryNotBefore,
        updatedAt: task.updatedAt,
      };
    return null;
  }

  pendingForPeer(nodeID: string) {
    return [...this.tasks.values()].filter(
      (task) =>
        task.deliveryPending &&
        (task.direction === 'submitted'
          ? task.masterNodeID === nodeID
          : task.submitterNodeID === nodeID),
    );
  }

  markDelivered(taskID: string, message: BrainTaskMessage) {
    const task = this.tasks.get(taskID);
    const current = this.message(taskID);
    if (!task || !current || JSON.stringify(current) !== JSON.stringify(message)) return false;
    task.deliveryPending = false;
    task.deliveryError = null;
    this.save();
    return true;
  }

  markDeliveryFailed(taskID: string, error: string) {
    const task = this.tasks.get(taskID);
    if (!task?.deliveryPending) return false;
    task.deliveryPending = false;
    task.deliveryError = error.slice(0, 200);
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const stored: StoredBrainTasks = {
      version: 2,
      tasks: [...this.tasks.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* Windows access control is inherited from the application data directory. */
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
