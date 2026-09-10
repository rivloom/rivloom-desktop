import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validTaskQueueReceipt, type TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { RemoteTaskInvite } from '../shared/types.ts';

export type RemoteQueueReceiptMessage = {
  type: 'remote-task-queue';
  version: 1;
  idempotencyKey: string;
  receipt: TaskQueueReceipt;
};
export type BrainQueueReceiptMessage = {
  type: 'brain-task-queue';
  version: 1;
  idempotencyKey: string;
  taskID: string;
  brainID: string;
  masterNodeID: string;
  submitterNodeID: string;
  receipt: TaskQueueReceipt;
};
export type QueueReceiptMessage = RemoteQueueReceiptMessage | BrainQueueReceiptMessage;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const node = /^[A-Za-z0-9_-]{32}$/;
export function validQueueReceiptMessage(value: unknown): value is QueueReceiptMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !uuid.test(String(v.idempotencyKey)) || !validTaskQueueReceipt(v.receipt))
    return false;
  if (v.type === 'remote-task-queue') return Object.keys(v).length === 4;
  return (
    v.type === 'brain-task-queue' &&
    Object.keys(v).length === 8 &&
    uuid.test(String(v.taskID)) &&
    uuid.test(String(v.brainID)) &&
    node.test(String(v.masterNodeID)) &&
    node.test(String(v.submitterNodeID)) &&
    v.receipt.brainTaskID === v.taskID &&
    v.receipt.ownerBrainID === v.brainID &&
    v.receipt.ownerNodeID === v.masterNodeID
  );
}

export function receiptMatchesRemote(
  receipt: TaskQueueReceipt,
  remote: Pick<
    RemoteTaskInvite,
    'id' | 'brainTaskID' | 'ownerNodeID' | 'ownerBrainID' | 'targetNodeID' | 'targetBrainID'
  >,
) {
  return (
    receipt.remoteTaskID === remote.id &&
    receipt.brainTaskID === remote.brainTaskID &&
    receipt.ownerNodeID === remote.ownerNodeID &&
    receipt.ownerBrainID === remote.ownerBrainID &&
    receipt.targetNodeID === remote.targetNodeID &&
    receipt.targetBrainID === remote.targetBrainID
  );
}

type StoredReceipt = {
  key: string;
  receipt: TaskQueueReceipt;
  pending: boolean;
  peerNodeID: string | null;
};
/** Queue facts are independent of engine progress and are replayed as latest snapshots. */
export class TaskQueueReceiptStore {
  purge(remoteIDs: string[], brainIDs: string[]) {
    for (const [key, value] of this.values) if (remoteIDs.includes(value.receipt.remoteTaskID) ||
      value.receipt.brainTaskID && brainIDs.includes(value.receipt.brainTaskID)) this.values.delete(key);
    this.save();
  }
  private readonly root: string;
  private values = new Map<string, StoredReceipt>();
  constructor(root: string) {
    this.root = root;
  }
  load() {
    const path = join(this.root, 'task-queue-receipts.json');
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (
      data.version !== 1 ||
      !Array.isArray(data.entries) ||
      data.entries.length > 1500 ||
      data.entries.some(
        (entry: StoredReceipt) =>
          !entry ||
          typeof entry.key !== 'string' ||
          !/^(remote|brain):[0-9a-f-]{36}$/i.test(entry.key) ||
          !validTaskQueueReceipt(entry.receipt) ||
          typeof entry.pending !== 'boolean' ||
          (entry.peerNodeID !== null && !node.test(entry.peerNodeID)),
      ) ||
      new Set(data.entries.map((entry: StoredReceipt) => entry.key)).size !== data.entries.length
    )
      throw new Error('队列回执记录无效；节点网络保持关闭。');
    this.values = new Map(data.entries.map((entry: StoredReceipt) => [entry.key, entry]));
  }
  get(key: string) {
    return structuredClone(this.values.get(key)?.receipt ?? null);
  }
  pending(peerNodeID: string) {
    return [...this.values.values()]
      .filter((entry) => entry.pending && entry.peerNodeID === peerNodeID)
      .map((entry) => structuredClone(entry));
  }
  replay(peerNodeID: string) {
    let changed = false;
    for (const entry of this.values.values())
      if (entry.peerNodeID === peerNodeID && !entry.pending) {
        entry.pending = true;
        changed = true;
      }
    if (changed) this.save();
  }
  publish(
    remote: RemoteTaskInvite,
    input: Pick<TaskQueueReceipt, 'state' | 'position' | 'reason'>,
  ) {
    const key = `remote:${remote.id}`;
    const prior = this.get(key);
    if (
      prior &&
      prior.state === input.state &&
      prior.position === input.position &&
      prior.reason === input.reason
    )
      return prior;
    if (prior?.state === 'rejected' || (prior?.state === 'admitted' && input.state !== 'admitted'))
      return prior;
    const receipt: TaskQueueReceipt = {
      remoteTaskID: remote.id,
      brainTaskID: remote.brainTaskID,
      ownerNodeID: remote.ownerNodeID,
      ownerBrainID: remote.ownerBrainID,
      targetNodeID: remote.targetNodeID,
      targetBrainID: remote.targetBrainID,
      ...input,
      queueSequence: (prior?.queueSequence ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!validTaskQueueReceipt(receipt)) throw new Error('队列回执内容无效。');
    this.set({ key, receipt, pending: true, peerNodeID: remote.ownerNodeID });
    return receipt;
  }
  receive(key: string, receipt: TaskQueueReceipt, forwardPeer: string | null = null) {
    if (!validTaskQueueReceipt(receipt)) throw new Error('队列回执内容无效。');
    const prior = this.get(key);
    if (prior && prior.remoteTaskID === receipt.remoteTaskID) {
      if (
        !receiptMatchesRemote(receipt, {
          id: prior.remoteTaskID,
          brainTaskID: prior.brainTaskID,
          ownerNodeID: prior.ownerNodeID,
          ownerBrainID: prior.ownerBrainID,
          targetNodeID: prior.targetNodeID,
          targetBrainID: prior.targetBrainID,
        })
      )
        throw new Error('队列回执路由冲突。');
      if (receipt.queueSequence < prior.queueSequence) return false;
      if (receipt.queueSequence === prior.queueSequence) {
        if (!isDeepStrictEqual(receipt, prior)) throw new Error('队列回执序号内容冲突。');
        return false;
      }
      if (
        prior.state === 'rejected' ||
        (prior.state === 'admitted' && receipt.state !== 'admitted')
      )
        return false;
    }
    this.set({
      key,
      receipt: structuredClone(receipt),
      pending: forwardPeer !== null,
      peerNodeID: forwardPeer,
    });
    return true;
  }
  delivered(key: string, receipt: TaskQueueReceipt) {
    const current = this.values.get(key);
    if (!current || !isDeepStrictEqual(current.receipt, receipt)) return;
    this.set({ ...current, pending: false });
  }
  private set(entry: StoredReceipt) {
    const prior = this.values.get(entry.key);
    this.values.set(entry.key, entry);
    try {
      this.save();
    } catch (error) {
      if (prior) this.values.set(entry.key, prior);
      else this.values.delete(entry.key);
      throw error;
    }
  }
  private save() {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, 'task-queue-receipts.json');
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, entries: [...this.values.values()] }), {
      mode: 0o600,
    });
    renameSync(temp, path);
  }
}
