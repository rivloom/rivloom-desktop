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
import type { RemoteTaskInvite, TaskState } from '../shared/types.ts';

export type RemoteTaskOfferMessage = {
  type: 'remote-task-offer';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  title: string;
  description: string;
  criteria: string;
  executionProtocol: 1;
  createdAt: string;
  expiresAt: string;
};

export type RemoteTaskResponseMessage = {
  type: 'remote-task-response';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  decision: 'accepted' | 'declined';
  decidedAt: string;
};

export type RemoteTaskCancelMessage = {
  type: 'remote-task-cancel';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  cancelledAt: string;
};

export type RemoteTaskPreparationMessage = {
  type: 'remote-task-preparation';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  state: 'ready' | 'revoked' | 'expired';
  leaseID: string;
  leaseExpiresAt: string;
  statusAt: string;
};

export type RemoteTaskExecutionMessage = {
  type: 'remote-task-execution';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  sequence: number;
  state: TaskState;
  summary: string;
  statusAt: string;
};

export type RemoteTaskMessage =
  | RemoteTaskOfferMessage
  | RemoteTaskResponseMessage
  | RemoteTaskCancelMessage
  | RemoteTaskPreparationMessage
  | RemoteTaskExecutionMessage;

type StoredRemoteTask = RemoteTaskInvite & { idempotencyKey: string };
type StoredRemoteTasks = { version: 3; tasks: StoredRemoteTask[] };

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumLifetimeMilliseconds = 24 * 60 * 60_000;
const executionLeaseMilliseconds = 30 * 60_000;
const taskStates = [
  'open',
  'ready',
  'running',
  'waiting_approval',
  'waiting_input',
  'stopping',
  'stopped',
  'interrupted',
  'failed',
  'review',
  'accepted',
] as const satisfies readonly TaskState[];

function validDate(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validBase(value: Record<string, unknown>) {
  return (
    value.version === 1 &&
    typeof value.taskID === 'string' &&
    uuidPattern.test(value.taskID) &&
    typeof value.idempotencyKey === 'string' &&
    uuidPattern.test(value.idempotencyKey) &&
    typeof value.ownerNodeID === 'string' &&
    nodePattern.test(value.ownerNodeID) &&
    typeof value.ownerBrainID === 'string' &&
    uuidPattern.test(value.ownerBrainID) &&
    typeof value.targetNodeID === 'string' &&
    nodePattern.test(value.targetNodeID) &&
    typeof value.targetBrainID === 'string' &&
    uuidPattern.test(value.targetBrainID)
  );
}

export function validRemoteTaskOffer(value: unknown): value is RemoteTaskOfferMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (
    item.type !== 'remote-task-offer' ||
    !validBase(item) ||
    typeof item.title !== 'string' ||
    item.title.trim().length < 1 ||
    item.title.length > 120 ||
    typeof item.description !== 'string' ||
    item.description.trim().length < 1 ||
    item.description.length > 4000 ||
    typeof item.criteria !== 'string' ||
    item.criteria.trim().length < 1 ||
    item.criteria.length > 2000 ||
    item.executionProtocol !== 1 ||
    !validDate(item.createdAt) ||
    !validDate(item.expiresAt)
  )
    return false;
  const lifetime = Date.parse(String(item.expiresAt)) - Date.parse(String(item.createdAt));
  return (
    lifetime > 0 &&
    lifetime <= maximumLifetimeMilliseconds &&
    Date.parse(String(item.createdAt)) <= Date.now() + 60_000 &&
    Date.parse(String(item.expiresAt)) <= Date.now() + maximumLifetimeMilliseconds + 60_000
  );
}

export function validRemoteTaskResponse(value: unknown): value is RemoteTaskResponseMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'remote-task-response' &&
    validBase(item) &&
    (item.decision === 'accepted' || item.decision === 'declined') &&
    validDate(item.decidedAt) &&
    Date.parse(String(item.decidedAt)) <= Date.now() + 60_000
  );
}

export function validRemoteTaskCancel(value: unknown): value is RemoteTaskCancelMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'remote-task-cancel' &&
    validBase(item) &&
    validDate(item.cancelledAt) &&
    Date.parse(String(item.cancelledAt)) <= Date.now() + 60_000
  );
}

export function validRemoteTaskPreparation(value: unknown): value is RemoteTaskPreparationMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (
    item.type !== 'remote-task-preparation' ||
    !validBase(item) ||
    !['ready', 'revoked', 'expired'].includes(String(item.state)) ||
    typeof item.leaseID !== 'string' ||
    !uuidPattern.test(item.leaseID) ||
    !validDate(item.leaseExpiresAt) ||
    !validDate(item.statusAt)
  )
    return false;
  const statusAt = Date.parse(String(item.statusAt));
  const leaseExpiresAt = Date.parse(String(item.leaseExpiresAt));
  return (
    statusAt <= Date.now() + 60_000 &&
    (item.state === 'ready'
      ? leaseExpiresAt > statusAt &&
        leaseExpiresAt - statusAt <= executionLeaseMilliseconds + 60_000
      : item.state === 'expired'
        ? leaseExpiresAt <= statusAt
        : Math.abs(leaseExpiresAt - statusAt) <= executionLeaseMilliseconds + 60_000)
  );
}

export function validRemoteTaskExecution(value: unknown): value is RemoteTaskExecutionMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'remote-task-execution' &&
    validBase(item) &&
    Number.isSafeInteger(item.sequence) &&
    Number(item.sequence) > 0 &&
    taskStates.includes(item.state as TaskState) &&
    typeof item.summary === 'string' &&
    item.summary.length <= 12_000 &&
    validDate(item.statusAt) &&
    Date.parse(String(item.statusAt)) <= Date.now() + 60_000
  );
}

function validStored(value: unknown): value is StoredRemoteTask {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    uuidPattern.test(item.id) &&
    typeof item.idempotencyKey === 'string' &&
    uuidPattern.test(item.idempotencyKey) &&
    (item.direction === 'incoming' || item.direction === 'outgoing') &&
    typeof item.ownerNodeID === 'string' &&
    nodePattern.test(item.ownerNodeID) &&
    typeof item.ownerBrainID === 'string' &&
    uuidPattern.test(item.ownerBrainID) &&
    typeof item.targetNodeID === 'string' &&
    nodePattern.test(item.targetNodeID) &&
    typeof item.targetBrainID === 'string' &&
    uuidPattern.test(item.targetBrainID) &&
    typeof item.title === 'string' &&
    item.title.trim().length >= 1 &&
    item.title.length <= 120 &&
    typeof item.description === 'string' &&
    item.description.trim().length >= 1 &&
    item.description.length <= 4000 &&
    typeof item.criteria === 'string' &&
    item.criteria.trim().length >= 1 &&
    item.criteria.length <= 2000 &&
    ['pending', 'accepted', 'declined', 'cancelled', 'expired'].includes(String(item.status)) &&
    typeof item.automaticEligible === 'boolean' &&
    ['unprepared', 'ready', 'revoked', 'expired'].includes(String(item.executionStatus)) &&
    (item.executionLeaseID === null ||
      (typeof item.executionLeaseID === 'string' && uuidPattern.test(item.executionLeaseID))) &&
    (item.executionLeaseExpiresAt === null || validDate(item.executionLeaseExpiresAt)) &&
    (item.executionUpdatedAt === null || validDate(item.executionUpdatedAt)) &&
    (item.localProjectID === null ||
      (typeof item.localProjectID === 'string' && uuidPattern.test(item.localProjectID))) &&
    (item.localModel === null ||
      (typeof item.localModel === 'string' &&
        item.localModel.length >= 3 &&
        item.localModel.length <= 200)) &&
    (item.localTaskID === null ||
      (typeof item.localTaskID === 'string' && uuidPattern.test(item.localTaskID))) &&
    (item.executionState === 'not_started' ||
      taskStates.includes(item.executionState as TaskState)) &&
    Number.isSafeInteger(item.executionSequence) &&
    Number(item.executionSequence) >= 0 &&
    typeof item.executionSummary === 'string' &&
    item.executionSummary.length <= 12_000 &&
    ((item.executionSequence === 0 &&
      item.executionState === 'not_started' &&
      item.executionSummary === '' &&
      item.localTaskID === null) ||
      (Number(item.executionSequence) > 0 &&
        item.status === 'accepted' &&
        item.executionState !== 'not_started' &&
        (item.direction === 'outgoing' || item.localTaskID !== null))) &&
    ((item.executionStatus === 'unprepared' &&
      item.executionLeaseID === null &&
      item.executionLeaseExpiresAt === null &&
      item.executionUpdatedAt === null &&
      item.localProjectID === null &&
      item.localModel === null) ||
      (item.executionStatus !== 'unprepared' &&
        item.executionLeaseID !== null &&
        item.executionLeaseExpiresAt !== null &&
        item.executionUpdatedAt !== null &&
        (item.executionStatus !== 'ready' ||
          item.direction === 'outgoing' ||
          (item.localProjectID !== null && item.localModel !== null)) &&
        (item.executionStatus === 'ready' ||
          (item.localProjectID === null && item.localModel === null)))) &&
    typeof item.deliveryPending === 'boolean' &&
    (item.deliveryError === null ||
      (typeof item.deliveryError === 'string' && item.deliveryError.length <= 200)) &&
    validDate(item.createdAt) &&
    validDate(item.updatedAt) &&
    validDate(item.expiresAt) &&
    Date.parse(String(item.expiresAt)) - Date.parse(String(item.createdAt)) > 0 &&
    Date.parse(String(item.expiresAt)) - Date.parse(String(item.createdAt)) <=
      maximumLifetimeMilliseconds
  );
}

function normalizeStored(value: unknown): StoredRemoteTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const normalized = {
    ...item,
    automaticEligible: item.automaticEligible ?? false,
    executionStatus: item.executionStatus ?? 'unprepared',
    executionLeaseID: item.executionLeaseID ?? null,
    executionLeaseExpiresAt: item.executionLeaseExpiresAt ?? null,
    executionUpdatedAt: item.executionUpdatedAt ?? null,
    localProjectID: item.localProjectID ?? null,
    localModel: item.localModel ?? null,
    localTaskID: item.localTaskID ?? null,
    executionState: item.executionState ?? 'not_started',
    executionSequence: item.executionSequence ?? 0,
    executionSummary: item.executionSummary ?? '',
    deliveryPending: item.automaticEligible === undefined ? false : item.deliveryPending,
    deliveryError: item.deliveryError ?? null,
  };
  return validStored(normalized) ? normalized : null;
}

function publicTask(task: StoredRemoteTask): RemoteTaskInvite {
  const { idempotencyKey: _idempotencyKey, ...value } = task;
  return { ...value };
}

function sameOffer(task: StoredRemoteTask, message: RemoteTaskOfferMessage) {
  return (
    task.id === message.taskID &&
    task.idempotencyKey === message.idempotencyKey &&
    task.ownerNodeID === message.ownerNodeID &&
    task.ownerBrainID === message.ownerBrainID &&
    task.targetNodeID === message.targetNodeID &&
    task.targetBrainID === message.targetBrainID &&
    task.title === message.title &&
    task.description === message.description &&
    task.criteria === message.criteria &&
    task.automaticEligible === (message.executionProtocol === 1) &&
    task.createdAt === message.createdAt &&
    task.expiresAt === message.expiresAt
  );
}

function sameRoute(
  task: StoredRemoteTask,
  message:
    | RemoteTaskResponseMessage
    | RemoteTaskCancelMessage
    | RemoteTaskPreparationMessage
    | RemoteTaskExecutionMessage,
) {
  return (
    task.id === message.taskID &&
    task.idempotencyKey === message.idempotencyKey &&
    task.ownerNodeID === message.ownerNodeID &&
    task.ownerBrainID === message.ownerBrainID &&
    task.targetNodeID === message.targetNodeID &&
    task.targetBrainID === message.targetBrainID
  );
}

export class RemoteTaskStore {
  private readonly path: string;
  private readonly values = new Map<string, StoredRemoteTask>();

  constructor(root: string) {
    this.path = join(root, 'remote-task-invites.json');
  }

  load() {
    this.values.clear();
    if (!existsSync(this.path)) return;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      throw new Error('远端任务邀请记录损坏；节点网络保持关闭。');
    }
    if (!value || typeof value !== 'object')
      throw new Error('远端任务邀请记录无效；节点网络保持关闭。');
    const stored = value as Record<string, unknown>;
    if (
      (stored.version !== 1 && stored.version !== 2 && stored.version !== 3) ||
      !Array.isArray(stored.tasks) ||
      stored.tasks.length > 500
    )
      throw new Error('远端任务邀请记录无效；节点网络保持关闭。');
    const tasks = stored.tasks.map(normalizeStored);
    if (tasks.some((task) => !task)) throw new Error('远端任务邀请记录无效；节点网络保持关闭。');
    const normalizedTasks = tasks as StoredRemoteTask[];
    if (new Set(normalizedTasks.map((task) => task.id)).size !== normalizedTasks.length)
      throw new Error('远端任务邀请记录存在冲突；节点网络保持关闭。');
    for (const task of normalizedTasks) this.values.set(task.id, { ...task });
    if (stored.version !== 3) this.save();
  }

  list() {
    return [...this.values.values()]
      .map(publicTask)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  record(taskID: string) {
    return this.values.get(taskID) || null;
  }

  create(
    ownerNodeID: string,
    ownerBrainID: string,
    targetNodeID: string,
    targetBrainID: string,
    input: { title: string; description: string; criteria: string },
  ) {
    if (this.values.size >= 500) throw new Error('远端任务邀请数量已达上限。');
    const createdAt = new Date().toISOString();
    const task: StoredRemoteTask = {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      direction: 'outgoing',
      ownerNodeID,
      ownerBrainID,
      targetNodeID,
      targetBrainID,
      title: input.title.trim(),
      description: input.description.trim(),
      criteria: input.criteria.trim(),
      status: 'pending',
      automaticEligible: true,
      executionStatus: 'unprepared',
      executionLeaseID: null,
      executionLeaseExpiresAt: null,
      executionUpdatedAt: null,
      localProjectID: null,
      localModel: null,
      localTaskID: null,
      executionState: 'not_started',
      executionSequence: 0,
      executionSummary: '',
      deliveryPending: true,
      deliveryError: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + maximumLifetimeMilliseconds).toISOString(),
    };
    this.values.set(task.id, task);
    this.save();
    return publicTask(task);
  }

  receiveOffer(message: RemoteTaskOfferMessage) {
    const existing = this.values.get(message.taskID);
    if (existing) {
      if (!sameOffer(existing, message)) throw new Error('远端任务 ID 或幂等内容冲突。');
      return false;
    }
    if (this.values.size >= 500) throw new Error('远端任务邀请数量已达上限。');
    if (Date.parse(message.expiresAt) <= Date.now()) throw new Error('远端任务邀请已经过期。');
    const task: StoredRemoteTask = {
      id: message.taskID,
      idempotencyKey: message.idempotencyKey,
      direction: 'incoming',
      ownerNodeID: message.ownerNodeID,
      ownerBrainID: message.ownerBrainID,
      targetNodeID: message.targetNodeID,
      targetBrainID: message.targetBrainID,
      title: message.title,
      description: message.description,
      criteria: message.criteria,
      status: 'pending',
      automaticEligible: true,
      executionStatus: 'unprepared',
      executionLeaseID: null,
      executionLeaseExpiresAt: null,
      executionUpdatedAt: null,
      localProjectID: null,
      localModel: null,
      localTaskID: null,
      executionState: 'not_started',
      executionSequence: 0,
      executionSummary: '',
      deliveryPending: false,
      deliveryError: null,
      createdAt: message.createdAt,
      updatedAt: new Date().toISOString(),
      expiresAt: message.expiresAt,
    };
    this.values.set(task.id, task);
    this.save();
    return true;
  }

  decide(taskID: string, decision: 'accepted' | 'declined') {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'incoming') throw new Error('待处理的远端任务邀请不存在。');
    if (task.status !== 'pending') throw new Error('远端任务邀请已经处理。');
    if (Date.parse(task.expiresAt) <= Date.now()) {
      task.status = 'expired';
      task.updatedAt = new Date().toISOString();
      this.save();
      throw new Error('远端任务邀请已经过期。');
    }
    task.status = decision;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return publicTask(task);
  }

  receiveResponse(message: RemoteTaskResponseMessage) {
    const task = this.values.get(message.taskID);
    if (!task || task.direction !== 'outgoing' || !sameRoute(task, message))
      throw new Error('远端任务回复与原邀请不匹配。');
    if (
      Date.parse(message.decidedAt) < Date.parse(task.createdAt) ||
      Date.parse(message.decidedAt) > Date.parse(task.expiresAt) + 60_000
    )
      throw new Error('远端任务回复时间无效。');
    if (task.status === message.decision) return false;
    if (task.status !== 'pending') return false;
    task.status = message.decision;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.decidedAt;
    this.save();
    return true;
  }

  prepare(taskID: string, localProjectID: string, localModel: string) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'incoming') throw new Error('可准备执行的远端任务不存在。');
    if (task.status !== 'accepted' || task.deliveryPending)
      throw new Error('请先完成任务接受状态同步。');
    if (!uuidPattern.test(localProjectID) || localModel.length < 3 || localModel.length > 200)
      throw new Error('本机项目或模型选择无效。');
    const statusAt = new Date().toISOString();
    task.executionStatus = 'ready';
    task.executionLeaseID = randomUUID();
    task.executionLeaseExpiresAt = new Date(Date.now() + executionLeaseMilliseconds).toISOString();
    task.executionUpdatedAt = statusAt;
    task.localProjectID = localProjectID;
    task.localModel = localModel;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = statusAt;
    this.save();
    return publicTask(task);
  }

  revokePreparation(taskID: string) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'incoming') throw new Error('可撤销的执行准备不存在。');
    if (task.status !== 'accepted' || task.executionStatus !== 'ready' || task.deliveryPending)
      throw new Error('执行准备当前不能撤销。');
    const statusAt = new Date().toISOString();
    task.executionStatus = 'revoked';
    task.executionUpdatedAt = statusAt;
    task.localProjectID = null;
    task.localModel = null;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = statusAt;
    this.save();
    return publicTask(task);
  }

  receivePreparation(message: RemoteTaskPreparationMessage) {
    const task = this.values.get(message.taskID);
    if (!task || task.direction !== 'outgoing' || !sameRoute(task, message))
      throw new Error('远端执行准备与原邀请不匹配。');
    if (task.status !== 'accepted') throw new Error('远端任务尚未接受。');
    if (Date.parse(message.statusAt) < Date.parse(task.createdAt))
      throw new Error('远端执行准备时间无效。');
    if (Date.parse(message.leaseExpiresAt) < Date.parse(task.createdAt))
      throw new Error('远端执行准备期限无效。');
    if (
      task.executionUpdatedAt &&
      Date.parse(message.statusAt) < Date.parse(task.executionUpdatedAt)
    )
      return false;
    if (task.executionUpdatedAt === message.statusAt) {
      if (
        task.executionStatus === message.state &&
        task.executionLeaseID === message.leaseID &&
        task.executionLeaseExpiresAt === message.leaseExpiresAt
      )
        return false;
      throw new Error('远端执行准备状态冲突。');
    }
    if (message.state !== 'ready' && task.executionLeaseID !== message.leaseID)
      throw new Error('远端执行准备租约不匹配。');
    task.executionStatus = message.state;
    task.executionLeaseID = message.leaseID;
    task.executionLeaseExpiresAt = message.leaseExpiresAt;
    task.executionUpdatedAt = message.statusAt;
    task.localProjectID = null;
    task.localModel = null;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.statusAt;
    this.save();
    return true;
  }

  bindLocalTask(taskID: string, localTaskID: string) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'incoming' || !task.automaticEligible)
      throw new Error('可执行的远端任务不存在。');
    if (task.status !== 'accepted' || task.deliveryPending)
      throw new Error('远端任务接受状态尚未完成同步。');
    if (!uuidPattern.test(localTaskID)) throw new Error('本机任务标识无效。');
    if (task.localTaskID) {
      if (task.localTaskID === localTaskID) return publicTask(task);
      throw new Error('远端任务已经绑定其他本机任务。');
    }
    const statusAt = new Date().toISOString();
    task.localTaskID = localTaskID;
    task.executionState = 'ready';
    task.executionSequence = 1;
    task.executionSummary = '执行节点已创建本机任务，等待启动 OpenCode。';
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = statusAt;
    this.save();
    return publicTask(task);
  }

  updateLocalExecution(localTaskID: string, state: TaskState, summary: string) {
    const task = [...this.values.values()].find(
      (candidate) => candidate.direction === 'incoming' && candidate.localTaskID === localTaskID,
    );
    if (!task || task.status !== 'accepted') return null;
    const normalizedSummary = summary.slice(0, 12_000);
    if (task.executionState === state && task.executionSummary === normalizedSummary)
      return publicTask(task);
    task.executionState = state;
    task.executionSequence += 1;
    task.executionSummary = normalizedSummary;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return publicTask(task);
  }

  receiveExecution(message: RemoteTaskExecutionMessage) {
    const task = this.values.get(message.taskID);
    if (!task || task.direction !== 'outgoing' || !sameRoute(task, message))
      throw new Error('远端执行状态与原任务不匹配。');
    if (!task.automaticEligible || task.status !== 'accepted')
      throw new Error('远端任务尚未进入执行阶段。');
    if (Date.parse(message.statusAt) < Date.parse(task.createdAt))
      throw new Error('远端执行状态时间无效。');
    if (message.sequence < task.executionSequence) return false;
    if (message.sequence === task.executionSequence) {
      if (task.executionState === message.state && task.executionSummary === message.summary)
        return false;
      throw new Error('远端执行状态序号冲突。');
    }
    task.executionState = message.state;
    task.executionSequence = message.sequence;
    task.executionSummary = message.summary;
    task.localTaskID = null;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.statusAt;
    this.save();
    return true;
  }

  taskForLocalTask(localTaskID: string) {
    const task = [...this.values.values()].find(
      (candidate) => candidate.direction === 'incoming' && candidate.localTaskID === localTaskID,
    );
    return task ? publicTask(task) : null;
  }

  cancel(taskID: string) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'outgoing') throw new Error('可取消的远端任务邀请不存在。');
    if (task.status !== 'pending' && task.status !== 'accepted')
      throw new Error('远端任务邀请当前不能取消。');
    if (task.executionSequence > 0) throw new Error('远端任务已经开始执行；请使用停止操作。');
    task.status = 'cancelled';
    task.executionStatus = task.executionStatus === 'unprepared' ? 'unprepared' : 'revoked';
    task.localProjectID = null;
    task.localModel = null;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return publicTask(task);
  }

  receiveCancel(message: RemoteTaskCancelMessage) {
    const task = this.values.get(message.taskID);
    if (!task || task.direction !== 'incoming' || !sameRoute(task, message))
      throw new Error('远端任务取消与原邀请不匹配。');
    if (Date.parse(message.cancelledAt) < Date.parse(task.createdAt))
      throw new Error('远端任务取消时间无效。');
    if (task.status === 'cancelled' || task.status === 'declined') return false;
    if (task.executionSequence > 0) throw new Error('远端任务已经开始执行，不能按邀请取消。');
    task.status = 'cancelled';
    task.executionStatus = task.executionStatus === 'unprepared' ? 'unprepared' : 'revoked';
    task.localProjectID = null;
    task.localModel = null;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.cancelledAt;
    this.save();
    return true;
  }

  pendingForPeer(nodeID: string) {
    return [...this.values.values()].filter(
      (task) =>
        task.deliveryPending &&
        (task.direction === 'outgoing'
          ? task.targetNodeID === nodeID
          : task.ownerNodeID === nodeID),
    );
  }

  message(taskID: string): RemoteTaskMessage | null {
    const task = this.values.get(taskID);
    if (!task?.deliveryPending) return null;
    const base = {
      version: 1 as const,
      taskID: task.id,
      idempotencyKey: task.idempotencyKey,
      ownerNodeID: task.ownerNodeID,
      ownerBrainID: task.ownerBrainID,
      targetNodeID: task.targetNodeID,
      targetBrainID: task.targetBrainID,
    };
    if (task.direction === 'outgoing' && task.status === 'pending')
      return {
        ...base,
        type: 'remote-task-offer',
        title: task.title,
        description: task.description,
        criteria: task.criteria,
        executionProtocol: 1,
        createdAt: task.createdAt,
        expiresAt: task.expiresAt,
      };
    if (
      task.direction === 'incoming' &&
      task.status === 'accepted' &&
      task.executionSequence > 0 &&
      task.executionState !== 'not_started'
    )
      return {
        ...base,
        type: 'remote-task-execution',
        sequence: task.executionSequence,
        state: task.executionState,
        summary: task.executionSummary,
        statusAt: task.updatedAt,
      };
    if (
      task.direction === 'incoming' &&
      task.status === 'accepted' &&
      task.executionStatus !== 'unprepared' &&
      task.executionLeaseID &&
      task.executionLeaseExpiresAt &&
      task.executionUpdatedAt
    )
      return {
        ...base,
        type: 'remote-task-preparation',
        state: task.executionStatus,
        leaseID: task.executionLeaseID,
        leaseExpiresAt: task.executionLeaseExpiresAt,
        statusAt: task.executionUpdatedAt,
      };
    if (task.direction === 'incoming' && (task.status === 'accepted' || task.status === 'declined'))
      return {
        ...base,
        type: 'remote-task-response',
        decision: task.status,
        decidedAt: task.updatedAt,
      };
    if (task.direction === 'outgoing' && task.status === 'cancelled')
      return { ...base, type: 'remote-task-cancel', cancelledAt: task.updatedAt };
    return null;
  }

  markDelivered(taskID: string, message: RemoteTaskMessage) {
    const task = this.values.get(taskID);
    const current = this.message(taskID);
    if (!task || !current || JSON.stringify(current) !== JSON.stringify(message)) return false;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  markDeliveryFailed(taskID: string, message: string) {
    const task = this.values.get(taskID);
    if (!task?.deliveryPending) return false;
    task.deliveryPending = false;
    task.deliveryError = message.slice(0, 200);
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  expire() {
    let changed = false;
    const at = Date.now();
    for (const task of this.values.values()) {
      if (task.status === 'pending' && Date.parse(task.expiresAt) <= at) {
        task.status = 'expired';
        task.deliveryPending = false;
        task.deliveryError = null;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (
        task.direction === 'incoming' &&
        task.status === 'accepted' &&
        task.executionStatus === 'ready' &&
        task.executionLeaseExpiresAt &&
        Date.parse(task.executionLeaseExpiresAt) <= at
      ) {
        const statusAt = new Date().toISOString();
        task.executionStatus = 'expired';
        task.executionUpdatedAt = statusAt;
        task.localProjectID = null;
        task.localModel = null;
        task.deliveryPending = true;
        task.deliveryError = null;
        task.updatedAt = statusAt;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  projectLeased(projectID: string) {
    const at = Date.now();
    return [...this.values.values()].some(
      (task) =>
        task.direction === 'incoming' &&
        task.status === 'accepted' &&
        task.executionStatus === 'ready' &&
        task.localProjectID === projectID &&
        !!task.executionLeaseExpiresAt &&
        Date.parse(task.executionLeaseExpiresAt) > at,
    );
  }

  revokePeer(nodeID: string) {
    let changed = false;
    for (const task of this.values.values())
      if (
        (task.ownerNodeID === nodeID || task.targetNodeID === nodeID) &&
        (task.status === 'pending' || (task.status === 'accepted' && task.executionSequence === 0))
      ) {
        task.status = 'cancelled';
        task.executionStatus = task.executionStatus === 'unprepared' ? 'unprepared' : 'revoked';
        task.localProjectID = null;
        task.localModel = null;
        task.deliveryPending = false;
        task.deliveryError = null;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    if (changed) this.save();
    return changed;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const value: StoredRemoteTasks = {
      version: 3,
      tasks: [...this.values.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* Windows access is primarily enforced by the current user profile. */
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
