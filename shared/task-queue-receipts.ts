import { validRemoteConcurrency } from './execution-concurrency.ts';

export const queueReceiptCapability = 'node-queue-v1';
export const nodeWorkloadCapability = 'node-workload-v1';
export const nodeConcurrencyCapability = 'node-concurrency-v1';
export type NodeConcurrency = {
  localOccupied: number;
  remoteOccupied: number;
  localExecuting: number;
  remoteExecuting: number;
  remoteLimit: number;
};
export type NodeWorkload = {
  occupiedSlots: number;
  totalSlots: number;
  executingCount: number;
};
export type NodeQueuePublicStats = {
  waitingCount: number;
  paused: boolean;
  updatedAt: string;
  sampledAt: string;
  health: 'normal' | 'unknown' | 'congested' | 'resource_anomaly' | 'stalled';
  workload?: NodeWorkload;
  concurrency?: NodeConcurrency;
};

/** Only routing and this task's queue facts cross the encrypted connection. */
export type TaskQueueReceipt = {
  remoteTaskID: string;
  brainTaskID: string | null;
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  queueSequence: number;
  state: 'queued' | 'held' | 'admitted' | 'rejected';
  position: number | null;
  reason: string | null;
  updatedAt: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const node = /^[A-Za-z0-9_-]{32}$/;
const date = (value: unknown) =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function validNodeWorkload(value: unknown): value is NodeWorkload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    exactKeys(v, ['occupiedSlots', 'totalSlots', 'executingCount']) &&
    Object.values(v).every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 100_000,
    ) &&
    Number(v.executingCount) <= Number(v.occupiedSlots)
  );
}

export function validNodeConcurrency(value: unknown): value is NodeConcurrency {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return exactKeys(v, ['localOccupied', 'remoteOccupied', 'localExecuting', 'remoteExecuting', 'remoteLimit']) &&
    Object.values(v).every((count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 100_000) &&
    validRemoteConcurrency(v.remoteLimit) && Number(v.localExecuting) <= Number(v.localOccupied) &&
    Number(v.remoteExecuting) <= Number(v.remoteOccupied);
}

/** Older node-queue-v1 decoders enforce exact keys. Never send them workload. */
export function nodeQueueForCapabilities(
  value: NodeQueuePublicStats | null,
  capabilities: readonly string[],
): NodeQueuePublicStats | null {
  if (!value || !capabilities.includes(queueReceiptCapability)) return null;
  const { workload, concurrency, ...legacy } = value;
  return {
    ...legacy,
    ...(capabilities.includes(nodeWorkloadCapability) && workload ? { workload } : {}),
    ...(capabilities.includes(nodeConcurrencyCapability) && concurrency ? { concurrency } : {}),
  };
}

export function validNodeQueuePublicStats(value: unknown): value is NodeQueuePublicStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    exactKeys(v, [
      'waitingCount',
      'paused',
      'updatedAt',
      'sampledAt',
      'health',
      ...(Object.hasOwn(v, 'workload') ? ['workload'] : []),
      ...(Object.hasOwn(v, 'concurrency') ? ['concurrency'] : []),
    ]) &&
    (!Object.hasOwn(v, 'workload') || validNodeWorkload(v.workload)) &&
    (!Object.hasOwn(v, 'concurrency') || validNodeConcurrency(v.concurrency)) &&
    Number.isSafeInteger(v.waitingCount) &&
    Number(v.waitingCount) >= 0 &&
    Number(v.waitingCount) <= 100_000 &&
    typeof v.paused === 'boolean' &&
    date(v.updatedAt) &&
    date(v.sampledAt) &&
    ['normal', 'unknown', 'congested', 'resource_anomaly', 'stalled'].includes(String(v.health))
  );
}

export function validTaskQueueReceipt(value: unknown): value is TaskQueueReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    exactKeys(v, [
      'remoteTaskID',
      'brainTaskID',
      'ownerNodeID',
      'ownerBrainID',
      'targetNodeID',
      'targetBrainID',
      'queueSequence',
      'state',
      'position',
      'reason',
      'updatedAt',
    ]) &&
    uuid.test(String(v.remoteTaskID)) &&
    (v.brainTaskID === null || uuid.test(String(v.brainTaskID))) &&
    node.test(String(v.ownerNodeID)) &&
    node.test(String(v.targetNodeID)) &&
    uuid.test(String(v.ownerBrainID)) &&
    uuid.test(String(v.targetBrainID)) &&
    v.ownerBrainID === v.targetBrainID &&
    Number.isSafeInteger(v.queueSequence) &&
    Number(v.queueSequence) > 0 &&
    ['queued', 'held', 'admitted', 'rejected'].includes(String(v.state)) &&
    (v.position === null ||
      (v.state === 'queued' &&
        Number.isSafeInteger(v.position) &&
        Number(v.position) > 0 &&
        Number(v.position) <= 100_000)) &&
    (v.reason === null || (typeof v.reason === 'string' && v.reason.length <= 300)) &&
    date(v.updatedAt)
  );
}
