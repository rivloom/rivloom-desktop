import type { RivloomNode } from './types.ts';
import { validNodeConcurrency } from './task-queue-receipts.ts';
export const queueReminderThreshold = 10;
export type QueueConfirmation = { nodeID: string; name: string; count: number; threshold: number };
export function validQueueConfirmation(value: unknown): value is QueueConfirmation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nodeID === 'string' &&
    v.nodeID.length > 0 &&
    v.nodeID.length <= 80 &&
    typeof v.name === 'string' &&
    v.name.length <= 200 &&
    Number.isSafeInteger(v.count) &&
    Number(v.count) >= queueReminderThreshold &&
    v.threshold === queueReminderThreshold
  );
}

/** Backlog includes queued/held tasks and occupied execution, not concurrent capacity. */
export function nodeQueueBacklog(
  node: Pick<RivloomNode, 'online' | 'channelReady' | 'nodeQueue' | 'worker'>,
  now = Date.now(),
): number | null {
  const fresh = (at: string | undefined) => {
    const sampled = at ? Date.parse(at) : NaN;
    return Number.isFinite(sampled) && sampled <= now + 1000 && now - sampled < 30_000;
  };
  if (!node.online || !node.channelReady || !fresh(node.nodeQueue?.sampledAt)) return null;
  const concurrency = node.nodeQueue?.concurrency;
  const occupied = validNodeConcurrency(concurrency)
    ? concurrency.localOccupied + concurrency.remoteOccupied
    : node.nodeQueue?.workload?.occupiedSlots ??
    (fresh(node.worker?.load.sampledAt) ? node.worker!.load.runningTasks : null);
  return occupied === null ? null : node.nodeQueue!.waitingCount + occupied;
}
