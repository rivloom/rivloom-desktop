import {
  validTaskFileManifest,
  sameTaskFileManifest,
  inputFileFields,
  type TaskFileDescriptor,
} from '../shared/task-files.ts';
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
import { creationFingerprint } from './creation-requests.ts';
import type {
  Approval,
  Artifact,
  Question,
  RemoteTaskControlAction,
  RemoteTaskInvite,
  TaskHardwareRequirements,
  TaskState,
} from '../shared/types.ts';

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
  requestedProjectID: string | null;
  requirements: TaskHardwareRequirements;
  inputFiles?: TaskFileDescriptor[];
  executionProtocol: 1;
  brainTaskID?: string | null;
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
  approvals?: Approval[];
  questions?: Question[];
  artifacts?: Artifact[];
  diffSource?: string;
  statusAt: string;
};

export type RemoteTaskControlMessage = {
  type: 'remote-task-control';
  version: 1;
  taskID: string;
  idempotencyKey: string;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  controlID: string;
  expectedExecutionSequence: number;
  action: RemoteTaskControlAction;
  issuedAt: string;
};

export type RemoteTaskMessage =
  | RemoteTaskOfferMessage
  | RemoteTaskResponseMessage
  | RemoteTaskCancelMessage
  | RemoteTaskPreparationMessage
  | RemoteTaskExecutionMessage
  | RemoteTaskControlMessage;

type StoredRemoteTask = Omit<RemoteTaskInvite, 'controlPending'> & {
  creationFingerprint?: string;
  idempotencyKey: string;
  pendingControl: RemoteTaskControlMessage | null;
  incomingControls: RemoteTaskControlMessage[];
  appliedControlIDs: string[];
};
type StoredRemoteTasks = { version: 8; tasks: StoredRemoteTask[] };

const nodePattern = /^[A-Za-z0-9_-]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumLifetimeMilliseconds = 24 * 60 * 60_000;
const executionLeaseMilliseconds = 30 * 60_000;
const maximumClockSkewMilliseconds = 60_000;
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

function validApproval(value: unknown): value is Approval {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length >= 1 &&
    item.id.length <= 200 &&
    typeof item.permission === 'string' &&
    item.permission.length >= 1 &&
    item.permission.length <= 100 &&
    Array.isArray(item.patterns) &&
    item.patterns.length <= 30 &&
    item.patterns.every((pattern) => typeof pattern === 'string' && pattern.length <= 2000) &&
    !!item.metadata &&
    typeof item.metadata === 'object' &&
    !Array.isArray(item.metadata) &&
    Object.keys(item.metadata).length === 0
  );
}

function validQuestion(value: unknown): value is Question {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length >= 1 &&
    item.id.length <= 200 &&
    Array.isArray(item.questions) &&
    item.questions.length >= 1 &&
    item.questions.length <= 10 &&
    item.questions.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const question = entry as Record<string, unknown>;
      return (
        typeof question.header === 'string' &&
        question.header.length <= 120 &&
        typeof question.question === 'string' &&
        question.question.length >= 1 &&
        question.question.length <= 4000 &&
        (question.multiple === undefined || typeof question.multiple === 'boolean') &&
        Array.isArray(question.options) &&
        question.options.length <= 20 &&
        question.options.every((option) => {
          if (!option || typeof option !== 'object') return false;
          const candidate = option as Record<string, unknown>;
          return (
            typeof candidate.label === 'string' &&
            candidate.label.length <= 200 &&
            typeof candidate.description === 'string' &&
            candidate.description.length <= 1000
          );
        })
      );
    })
  );
}

function validArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.file === 'string' &&
    item.file.length >= 1 &&
    item.file.length <= 2000 &&
    typeof item.patch === 'string' &&
    item.patch.length <= 24_000 &&
    Number.isSafeInteger(item.additions) &&
    Number(item.additions) >= 0 &&
    Number.isSafeInteger(item.deletions) &&
    Number(item.deletions) >= 0 &&
    typeof item.status === 'string' &&
    item.status.length >= 1 &&
    item.status.length <= 100
  );
}

function validControlAction(value: unknown): value is RemoteTaskControlAction {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(',');
  if (item.kind === 'stop') return keys === 'kind';
  if (
    keys === 'kind,text' &&
    item.kind === 'supplement' &&
    typeof item.text === 'string' &&
    item.text.trim().length >= 1 &&
    item.text.length <= 12_000
  )
    return true;
  if (
    keys === 'kind,note' &&
    item.kind === 'accept' &&
    typeof item.note === 'string' &&
    item.note.trim().length >= 1 &&
    item.note.length <= 4000
  )
    return true;
  if (
    keys === 'kind,reply,requestID' &&
    item.kind === 'permission' &&
    typeof item.requestID === 'string' &&
    item.requestID.length >= 1 &&
    item.requestID.length <= 200 &&
    (item.reply === 'once' || item.reply === 'reject')
  )
    return true;
  return (
    keys === 'answers,kind,requestID' &&
    item.kind === 'question' &&
    typeof item.requestID === 'string' &&
    item.requestID.length >= 1 &&
    item.requestID.length <= 200 &&
    Array.isArray(item.answers) &&
    item.answers.length >= 1 &&
    item.answers.length <= 10 &&
    item.answers.every(
      (answers) =>
        Array.isArray(answers) &&
        answers.length >= 1 &&
        answers.length <= 20 &&
        answers.every((answer) => typeof answer === 'string' && answer.length <= 4000),
    )
  );
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
    !(
      item.requestedProjectID === null ||
      (typeof item.requestedProjectID === 'string' && uuidPattern.test(item.requestedProjectID))
    ) ||
    !validRequirements(item.requirements) ||
    (item.inputFiles !== undefined && !validTaskFileManifest(item.inputFiles)) ||
    !(
      item.brainTaskID == null ||
      (typeof item.brainTaskID === 'string' && uuidPattern.test(item.brainTaskID))
    ) ||
    item.executionProtocol !== 1 ||
    !validDate(item.createdAt) ||
    !validDate(item.expiresAt)
  )
    return false;
  const lifetime = Date.parse(String(item.expiresAt)) - Date.parse(String(item.createdAt));
  return (
    lifetime > 0 &&
    lifetime <= maximumLifetimeMilliseconds &&
    Date.parse(String(item.createdAt)) <= Date.now() + maximumClockSkewMilliseconds &&
    Date.parse(String(item.expiresAt)) <=
      Date.now() + maximumLifetimeMilliseconds + maximumClockSkewMilliseconds
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
    Date.parse(String(item.decidedAt)) <= Date.now() + maximumClockSkewMilliseconds
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
    (item.approvals === undefined ||
      (Array.isArray(item.approvals) &&
        item.approvals.length <= 30 &&
        item.approvals.every(validApproval))) &&
    (item.questions === undefined ||
      (Array.isArray(item.questions) &&
        item.questions.length <= 10 &&
        item.questions.every(validQuestion))) &&
    (item.artifacts === undefined ||
      (Array.isArray(item.artifacts) &&
        item.artifacts.length <= 50 &&
        item.artifacts.every(validArtifact) &&
        JSON.stringify(item.artifacts).length <= 28_000)) &&
    (item.diffSource === undefined ||
      (typeof item.diffSource === 'string' && item.diffSource.length <= 200)) &&
    JSON.stringify(item).length <= 60_000 &&
    validDate(item.statusAt) &&
    Date.parse(String(item.statusAt)) <= Date.now() + 60_000
  );
}

function validRemoteTaskControlRecord(value: unknown): value is RemoteTaskControlMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'remote-task-control' &&
    validBase(item) &&
    typeof item.controlID === 'string' &&
    uuidPattern.test(item.controlID) &&
    Number.isSafeInteger(item.expectedExecutionSequence) &&
    Number(item.expectedExecutionSequence) > 0 &&
    validControlAction(item.action) &&
    validDate(item.issuedAt) &&
    Date.parse(String(item.issuedAt)) <= Date.now() + 60_000
  );
}

export function validRemoteTaskControl(value: unknown): value is RemoteTaskControlMessage {
  return (
    validRemoteTaskControlRecord(value) &&
    Date.parse(value.issuedAt) >= Date.now() - maximumLifetimeMilliseconds
  );
}

function validStored(value: unknown): value is StoredRemoteTask {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.creationFingerprint === undefined ||
      (typeof item.creationFingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(item.creationFingerprint))) &&
    (item.deliveredAt === undefined || item.deliveredAt === null || validDate(item.deliveredAt)) &&
    (item.transmissionState === undefined ||
      ['saved', 'sending', 'delivered', 'transmission_unknown'].includes(
        String(item.transmissionState),
      )) &&
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
    item.description.length <= 64_000 &&
    typeof item.criteria === 'string' &&
    item.criteria.trim().length >= 1 &&
    item.criteria.length <= 2000 &&
    (item.requestedProjectID === null ||
      (typeof item.requestedProjectID === 'string' && uuidPattern.test(item.requestedProjectID))) &&
    validRequirements(item.requirements) &&
    (item.inputFiles === undefined || validTaskFileManifest(item.inputFiles)) &&
    (item.brainTaskID === null ||
      (typeof item.brainTaskID === 'string' && uuidPattern.test(item.brainTaskID))) &&
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
    Array.isArray(item.remoteApprovals) &&
    item.remoteApprovals.length <= 30 &&
    item.remoteApprovals.every(validApproval) &&
    Array.isArray(item.remoteQuestions) &&
    item.remoteQuestions.length <= 10 &&
    item.remoteQuestions.every(validQuestion) &&
    Array.isArray(item.remoteArtifacts) &&
    item.remoteArtifacts.length <= 50 &&
    item.remoteArtifacts.every(validArtifact) &&
    JSON.stringify(item.remoteArtifacts).length <= 28_000 &&
    typeof item.remoteDiffSource === 'string' &&
    item.remoteDiffSource.length <= 200 &&
    (item.pendingControl === null || validRemoteTaskControlRecord(item.pendingControl)) &&
    Array.isArray(item.incomingControls) &&
    item.incomingControls.length <= 20 &&
    item.incomingControls.every(validRemoteTaskControlRecord) &&
    Array.isArray(item.appliedControlIDs) &&
    item.appliedControlIDs.length <= 100 &&
    item.appliedControlIDs.every(
      (controlID) => typeof controlID === 'string' && uuidPattern.test(controlID),
    ) &&
    (item.direction === 'outgoing'
      ? item.incomingControls.length === 0
      : item.pendingControl === null) &&
    ((item.executionSequence === 0 &&
      item.executionState === 'not_started' &&
      item.executionSummary === '' &&
      item.localTaskID === null &&
      item.remoteApprovals.length === 0 &&
      item.remoteQuestions.length === 0 &&
      item.remoteArtifacts.length === 0 &&
      item.remoteDiffSource === '') ||
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
  const pendingControl = item.pendingControl ?? null;
  const incomingControls = item.incomingControls ?? [];
  const cutoff = Date.now() - maximumLifetimeMilliseconds;
  const stalePendingControl =
    validRemoteTaskControlRecord(pendingControl) && Date.parse(pendingControl.issuedAt) < cutoff;
  const retainedIncomingControls =
    Array.isArray(incomingControls) && incomingControls.every(validRemoteTaskControlRecord)
      ? incomingControls.filter((control) => Date.parse(control.issuedAt) >= cutoff)
      : incomingControls;
  const normalized = {
    ...item,
    ...(item.transmissionState === 'sending' ? { transmissionState: 'transmission_unknown' } : {}),
    automaticEligible: item.automaticEligible ?? false,
    brainTaskID: item.brainTaskID ?? null,
    requestedProjectID: item.requestedProjectID ?? null,
    requirements: item.requirements ?? {},
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
    remoteApprovals: item.remoteApprovals ?? [],
    remoteQuestions: item.remoteQuestions ?? [],
    remoteArtifacts: item.remoteArtifacts ?? [],
    remoteDiffSource: item.remoteDiffSource ?? '',
    pendingControl: stalePendingControl ? null : pendingControl,
    incomingControls: retainedIncomingControls,
    appliedControlIDs: item.appliedControlIDs ?? [],
    deliveryPending:
      item.automaticEligible === undefined || stalePendingControl ? false : item.deliveryPending,
    deliveryError: stalePendingControl
      ? '远程人工操作已过期，请根据最新状态重试。'
      : (item.deliveryError ?? null),
  };
  return validStored(normalized) ? normalized : null;
}

function publicTask(task: StoredRemoteTask): RemoteTaskInvite {
  const {
    idempotencyKey: _idempotencyKey,
    creationFingerprint: _creationFingerprint,
    pendingControl,
    incomingControls: _incomingControls,
    appliedControlIDs: _appliedControlIDs,
    ...value
  } = task;
  return { ...value, controlPending: pendingControl !== null };
}

function sameOffer(task: StoredRemoteTask, message: RemoteTaskOfferMessage) {
  return (
    task.id === message.taskID &&
    task.idempotencyKey === message.idempotencyKey &&
    task.ownerNodeID === message.ownerNodeID &&
    task.ownerBrainID === message.ownerBrainID &&
    task.targetNodeID === message.targetNodeID &&
    task.targetBrainID === message.targetBrainID &&
    sameTaskFileManifest(task.inputFiles, message.inputFiles) &&
    task.title === message.title &&
    task.description === message.description &&
    task.criteria === message.criteria &&
    task.brainTaskID === (message.brainTaskID ?? null) &&
    task.requestedProjectID === message.requestedProjectID &&
    JSON.stringify(task.requirements) === JSON.stringify(message.requirements) &&
    task.automaticEligible === (message.executionProtocol === 1) &&
    task.createdAt === message.createdAt &&
    task.expiresAt === message.expiresAt
  );
}

function creationContent(input: {
  title: string;
  description: string;
  criteria: string;
  requestedProjectID?: string | null;
  requirements?: TaskHardwareRequirements;
  inputFiles?: TaskFileDescriptor[];
}) {
  return creationFingerprint({
    title: input.title.trim(),
    description: input.description.trim(),
    criteria: input.criteria.trim(),
    requestedProjectID: input.requestedProjectID ?? null,
    requirements: input.requirements ?? {},
    ...inputFileFields(input.inputFiles),
  });
}

function sameRoute(
  task: StoredRemoteTask,
  message:
    | RemoteTaskResponseMessage
    | RemoteTaskCancelMessage
    | RemoteTaskPreparationMessage
    | RemoteTaskExecutionMessage
    | RemoteTaskControlMessage,
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
      (stored.version !== 1 &&
        stored.version !== 2 &&
        stored.version !== 3 &&
        stored.version !== 4 &&
        stored.version !== 5 &&
        stored.version !== 6 &&
        stored.version !== 7 &&
        stored.version !== 8) ||
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
    if (stored.version !== 8 || JSON.stringify(normalizedTasks) !== JSON.stringify(stored.tasks))
      this.save();
  }

  list() {
    return [...this.values.values()]
      .map(publicTask)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  record(taskID: string) {
    return this.values.get(taskID) || null;
  }

  matchesCreation(taskID: string, input: Parameters<typeof creationContent>[0]) {
    const current = this.values.get(taskID);
    return (
      !!current &&
      (current.creationFingerprint ?? creationContent(current)) === creationContent(input)
    );
  }

  create(
    ownerNodeID: string,
    ownerBrainID: string,
    targetNodeID: string,
    targetBrainID: string,
    input: {
      title: string;
      description: string;
      criteria: string;
      requestedProjectID?: string | null;
      requirements?: TaskHardwareRequirements;
      inputFiles?: TaskFileDescriptor[];
      brainTaskID?: string | null;
    },
    taskID?: string,
  ) {
    if (input.inputFiles !== undefined && !validTaskFileManifest(input.inputFiles))
      throw new Error('附件清单无效。');
    const existing = taskID ? this.values.get(taskID) : null;
    if (existing) {
      if (
        existing.direction !== 'outgoing' ||
        existing.ownerNodeID !== ownerNodeID ||
        existing.ownerBrainID !== ownerBrainID ||
        existing.targetNodeID !== targetNodeID ||
        existing.targetBrainID !== targetBrainID ||
        !this.matchesCreation(existing.id, input) ||
        existing.brainTaskID !== (input.brainTaskID ?? null) ||
        JSON.stringify(existing.requirements) !== JSON.stringify(input.requirements ?? {})
      )
        throw new Error('远端任务创建 ID 或内容冲突。');
      return publicTask(existing);
    }
    if (this.values.size >= 500) throw new Error('远端任务邀请数量已达上限。');
    const createdAt = new Date().toISOString();
    const task: StoredRemoteTask = {
      id: taskID ?? randomUUID(),
      creationFingerprint: creationContent(input),
      deliveredAt: null,
      transmissionState: 'saved',
      brainTaskID: input.brainTaskID ?? null,
      idempotencyKey: randomUUID(),
      direction: 'outgoing',
      ownerNodeID,
      ownerBrainID,
      targetNodeID,
      targetBrainID,
      title: input.title.trim(),
      description: input.description.trim(),
      criteria: input.criteria.trim(),
      requestedProjectID: input.requestedProjectID ?? null,
      requirements: structuredClone(input.requirements ?? {}),
      ...inputFileFields(input.inputFiles),
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
      remoteApprovals: [],
      remoteQuestions: [],
      remoteArtifacts: [],
      remoteDiffSource: '',
      pendingControl: null,
      incomingControls: [],
      appliedControlIDs: [],
      deliveryPending: true,
      deliveryError: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + maximumLifetimeMilliseconds).toISOString(),
    };
    if (!validStored(task)) throw new Error('远端任务邀请内容无效。');
    this.values.set(task.id, task);
    try {
      this.save();
    } catch (error) {
      this.values.delete(task.id);
      throw error;
    }
    return publicTask(task);
  }

  discardUnsent(taskID: string) {
    const task = this.values.get(taskID);
    if (
      !task ||
      task.direction !== 'outgoing' ||
      task.status !== 'pending' ||
      !task.deliveryPending ||
      task.executionSequence !== 0
    )
      return false;
    this.values.delete(taskID);
    this.save();
    return true;
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
      brainTaskID: message.brainTaskID ?? null,
      idempotencyKey: message.idempotencyKey,
      direction: 'incoming',
      ownerNodeID: message.ownerNodeID,
      ownerBrainID: message.ownerBrainID,
      targetNodeID: message.targetNodeID,
      targetBrainID: message.targetBrainID,
      title: message.title,
      description: message.description,
      criteria: message.criteria,
      requestedProjectID: message.requestedProjectID,
      requirements: structuredClone(message.requirements),
      ...inputFileFields(message.inputFiles),
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
      remoteApprovals: [],
      remoteQuestions: [],
      remoteArtifacts: [],
      remoteDiffSource: '',
      pendingControl: null,
      incomingControls: [],
      appliedControlIDs: [],
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
      !validRemoteTaskResponse(message) ||
      // The Worker and Master use different clocks; route/state fence obsolete executions.
      Date.parse(message.decidedAt) < Date.parse(task.createdAt) - maximumClockSkewMilliseconds ||
      Date.parse(message.decidedAt) > Date.parse(task.expiresAt) + maximumClockSkewMilliseconds
    )
      throw new Error('远端任务回复时间无效。');
    if (task.status === message.decision) return false;
    if (task.status !== 'pending') throw new Error('这次 Execution 已失效，不能再接受。');
    // First acceptance uses the Master's own deadline, even between expiry ticks.
    if (Date.now() >= Date.parse(task.expiresAt)) throw new Error('这次 Execution 已过期。');
    task.status = message.decision;
    task.deliveredAt ||= new Date().toISOString();
    task.transmissionState = 'delivered';
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
    if (
      !validRemoteTaskPreparation(message) ||
      Date.parse(message.statusAt) < Date.parse(task.createdAt) - maximumClockSkewMilliseconds
    )
      throw new Error('远端执行准备时间无效。');
    if (
      Date.parse(message.leaseExpiresAt) <
      Date.parse(task.createdAt) - maximumClockSkewMilliseconds
    )
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
    if (task.status !== 'accepted' || task.deliveryPending || task.deliveryError)
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

  updateLocalExecution(
    localTaskID: string,
    state: TaskState,
    summary: string,
    approvals: Approval[] = [],
    questions: Question[] = [],
    artifacts: Artifact[] = [],
    diffSource = '',
  ) {
    const task = [...this.values.values()].find(
      (candidate) => candidate.direction === 'incoming' && candidate.localTaskID === localTaskID,
    );
    if (!task || task.status !== 'accepted') return null;
    const normalizedSummary = summary.slice(0, 12_000);
    if (
      approvals.length > 30 ||
      !approvals.every(validApproval) ||
      questions.length > 10 ||
      !questions.every(validQuestion) ||
      artifacts.length > 50 ||
      !artifacts.every(validArtifact) ||
      JSON.stringify(artifacts).length > 28_000 ||
      diffSource.length > 200 ||
      JSON.stringify({ state, summary, approvals, questions, artifacts, diffSource }).length >
        60_000
    )
      throw new Error('远端人工介入快照无效。');
    if (
      task.executionState === state &&
      task.executionSummary === normalizedSummary &&
      JSON.stringify(task.remoteApprovals) === JSON.stringify(approvals) &&
      JSON.stringify(task.remoteQuestions) === JSON.stringify(questions) &&
      JSON.stringify(task.remoteArtifacts) === JSON.stringify(artifacts) &&
      task.remoteDiffSource === diffSource
    )
      return publicTask(task);
    task.executionState = state;
    task.executionSequence += 1;
    task.executionSummary = normalizedSummary;
    task.remoteApprovals = structuredClone(approvals);
    task.remoteQuestions = structuredClone(questions);
    task.remoteArtifacts = structuredClone(artifacts);
    task.remoteDiffSource = diffSource;
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
    if (
      !validRemoteTaskExecution(message) ||
      Date.parse(message.statusAt) < Date.parse(task.createdAt) - maximumClockSkewMilliseconds
    )
      throw new Error('远端执行状态时间无效。');
    const approvals = message.approvals || [];
    const questions = message.questions || [];
    const artifacts = message.artifacts || [];
    const diffSource = message.diffSource || '';
    if (message.sequence < task.executionSequence) return false;
    if (message.sequence === task.executionSequence) {
      if (
        task.executionState === message.state &&
        task.executionSummary === message.summary &&
        JSON.stringify(task.remoteApprovals) === JSON.stringify(approvals) &&
        JSON.stringify(task.remoteQuestions) === JSON.stringify(questions) &&
        JSON.stringify(task.remoteArtifacts) === JSON.stringify(artifacts) &&
        task.remoteDiffSource === diffSource
      )
        return false;
      throw new Error('远端执行状态序号冲突。');
    }
    task.executionState = message.state;
    task.executionSequence = message.sequence;
    task.executionSummary = message.summary;
    task.remoteApprovals = structuredClone(approvals);
    task.remoteQuestions = structuredClone(questions);
    task.remoteArtifacts = structuredClone(artifacts);
    task.remoteDiffSource = diffSource;
    task.localTaskID = null;
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = message.statusAt;
    this.save();
    return true;
  }

  requestControl(
    taskID: string,
    expectedExecutionSequence: number,
    action: RemoteTaskControlAction,
  ) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'outgoing' || task.status !== 'accepted')
      throw new Error('可控制的远端任务不存在。');
    if (
      task.executionSequence !== expectedExecutionSequence ||
      !Number.isSafeInteger(expectedExecutionSequence) ||
      expectedExecutionSequence <= 0
    )
      throw new Error('远端任务状态已经更新，请刷新后重试。');
    if (task.pendingControl || task.deliveryPending)
      throw new Error('上一项远程操作仍在同步，请稍后重试。');
    this.requireControlMatchesTask(task, action);
    const message: RemoteTaskControlMessage = {
      type: 'remote-task-control',
      version: 1,
      taskID: task.id,
      idempotencyKey: task.idempotencyKey,
      ownerNodeID: task.ownerNodeID,
      ownerBrainID: task.ownerBrainID,
      targetNodeID: task.targetNodeID,
      targetBrainID: task.targetBrainID,
      controlID: randomUUID(),
      expectedExecutionSequence,
      action: structuredClone(action),
      issuedAt: new Date().toISOString(),
    };
    if (!validRemoteTaskControl(message)) throw new Error('远程控制内容无效。');
    task.pendingControl = message;
    task.deliveryPending = true;
    task.deliveryError = null;
    task.updatedAt = message.issuedAt;
    this.save();
    return publicTask(task);
  }

  receiveControl(message: RemoteTaskControlMessage) {
    const task = this.values.get(message.taskID);
    if (!task || task.direction !== 'incoming' || !sameRoute(task, message))
      throw new Error('远程控制与原任务不匹配。');
    if (task.status !== 'accepted' || !task.localTaskID)
      throw new Error('远端任务尚未进入可控制状态。');
    const existing = task.incomingControls.find(
      (control) => control.controlID === message.controlID,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(message))
        throw new Error('远程控制幂等内容冲突。');
      return false;
    }
    if (task.appliedControlIDs.includes(message.controlID)) return false;
    if (task.executionSequence !== message.expectedExecutionSequence)
      throw new Error('远端任务状态已经更新。');
    if (task.incomingControls.length >= 1)
      throw new Error('上一项远程操作仍在执行，请等待状态更新后重试。');
    if (
      task.incomingControls.some(
        (control) => JSON.stringify(control.action) === JSON.stringify(message.action),
      )
    )
      throw new Error('相同的远程控制已经等待处理。');
    this.requireControlMatchesTask(task, message.action);
    task.incomingControls.push(structuredClone(message));
    if (message.action.kind === 'supplement')
      task.description = `${task.description}\n\n补充要求：${message.action.text}`;
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  pendingIncomingControls() {
    return [...this.values.values()].flatMap((task) =>
      task.incomingControls.map((control) => ({
        taskID: task.id,
        localTaskID: task.localTaskID!,
        control: structuredClone(control),
      })),
    );
  }

  finishIncomingControl(taskID: string, controlID: string) {
    const task = this.values.get(taskID);
    if (!task || task.direction !== 'incoming') return false;
    const index = task.incomingControls.findIndex((control) => control.controlID === controlID);
    if (index < 0) return task.appliedControlIDs.includes(controlID);
    task.incomingControls.splice(index, 1);
    task.appliedControlIDs.push(controlID);
    task.appliedControlIDs = task.appliedControlIDs.slice(-100);
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  private requireControlMatchesTask(task: StoredRemoteTask, action: RemoteTaskControlAction) {
    if (action.kind === 'permission') {
      if (!task.remoteApprovals.some((approval) => approval.id === action.requestID))
        throw new Error('审批请求已经失效。');
      return;
    }
    if (action.kind === 'question') {
      const question = task.remoteQuestions.find((item) => item.id === action.requestID);
      if (!question || action.answers.length !== question.questions.length)
        throw new Error('AI 问题已经失效或答案数量不正确。');
      return;
    }
    if (action.kind === 'accept') {
      if (task.executionState !== 'review') throw new Error('远端任务当前不在验收阶段。');
      return;
    }
    if (action.kind === 'supplement') {
      if (
        ![
          'running',
          'waiting_approval',
          'waiting_input',
          'stopped',
          'interrupted',
          'failed',
          'review',
        ].includes(task.executionState)
      )
        throw new Error('远端任务当前不能补充要求。');
      if (task.description.length + action.text.length + 8 > 64_000)
        throw new Error('远端任务的累计补充要求已达上限。');
      return;
    }
    if (
      !['running', 'waiting_approval', 'waiting_input', 'interrupted'].includes(task.executionState)
    )
      throw new Error('远端任务当前没有运行。');
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
    if (task.brainTaskID && task.status === 'accepted')
      throw new Error('Worker 已接受，执行状态可能未知；不能按未启动任务取消或重派。');
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
    if (task.direction === 'outgoing' && task.pendingControl)
      return structuredClone(task.pendingControl);
    if (task.direction === 'outgoing' && task.status === 'pending')
      return {
        ...base,
        type: 'remote-task-offer',
        title: task.title,
        description: task.description,
        criteria: task.criteria,
        requestedProjectID: task.requestedProjectID,
        requirements: structuredClone(task.requirements),
        ...inputFileFields(task.inputFiles),
        executionProtocol: 1,
        brainTaskID: task.brainTaskID,
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
        approvals: structuredClone(task.remoteApprovals),
        questions: structuredClone(task.remoteQuestions),
        artifacts: structuredClone(task.remoteArtifacts),
        diffSource: task.remoteDiffSource,
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

  markDelivered(taskID: string, message: RemoteTaskMessage, authenticated = true) {
    const task = this.values.get(taskID);
    const current = this.message(taskID);
    if (!task || !current || JSON.stringify(current) !== JSON.stringify(message)) return false;
    if (message.type === 'remote-task-offer') {
      if (authenticated) {
        task.deliveredAt ||= new Date().toISOString();
        task.transmissionState = 'delivered';
      } else {
        task.transmissionState = task.deliveredAt ? 'delivered' : 'transmission_unknown';
        // A legacy HTTP response is transport evidence only. Keep the same offer
        // retryable until an authenticated task response confirms receipt.
        task.deliveryError = null;
        this.save();
        return true;
      }
    }
    if (message.type === 'remote-task-control') {
      task.pendingControl = null;
      if (message.action.kind === 'supplement')
        task.description = `${task.description}\n\n补充要求：${message.action.text}`;
    }
    task.deliveryPending = false;
    task.deliveryError = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  markOfferTransmission(taskID: string, state: 'sending' | 'transmission_unknown') {
    const task = this.values.get(taskID);
    if (
      !task ||
      task.direction !== 'outgoing' ||
      task.deliveredAt ||
      task.transmissionState === state ||
      task.status !== 'pending'
    )
      return false;
    task.transmissionState = state;
    this.save();
    return true;
  }

  markDeliveryFailed(taskID: string, message: string) {
    const task = this.values.get(taskID);
    if (!task?.deliveryPending) return false;
    task.pendingControl = null;
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
      version: 8,
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
