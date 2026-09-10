import { t } from '../shared/i18n.ts';
import type { RivloomNode } from '../shared/types.ts';
import { validNodeWorkload, validNodeConcurrency } from '../shared/task-queue-receipts.ts';
import { nodeCapabilitySummary } from './node-mentions.ts';
import { conversationStatusGroup } from './conversation-filters.ts';
import { nodeQueueBacklog, queueReminderThreshold } from '../shared/queue-backlog.ts';
import type { Conversation } from './conversations.ts';

export function groupMachines(nodes: readonly RivloomNode[]) {
  return {
    connected: nodes.filter((node) => node.online && node.channelReady),
    offline: nodes.filter((node) => !node.online || !node.channelReady),
  };
}

const percent = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

export function machineStatus(node: RivloomNode, now = Date.now(), connected = true) {
  const capability = nodeCapabilitySummary(node, now, connected);
  const load = capability.loadFresh ? node.worker!.load : null;
  const concurrency = capability.queueFresh && validNodeConcurrency(node.nodeQueue?.concurrency)
    ? node.nodeQueue!.concurrency! : null;
  const report =
    capability.queueFresh && validNodeWorkload(node.nodeQueue?.workload)
      ? node.nodeQueue!.workload!
      : null;
  const occupied = concurrency ? concurrency.localOccupied + concurrency.remoteOccupied : report?.occupiedSlots ?? load?.runningTasks ?? null;
  // Legacy availableSlots becomes zero when accepting is disabled, so it cannot
  // reveal configured capacity in that state. Never turn that zero into a total.
  const total =
    concurrency ? null : report?.totalSlots ??
    (load && node.worker!.accepting ? load.runningTasks + load.availableSlots : null);
  const executing = concurrency ? concurrency.localExecuting + concurrency.remoteExecuting : report?.executingCount ?? null;
  const paused =
    (capability.queueFresh && node.nodeQueue!.paused) ||
    (capability.loadFresh && !node.worker!.accepting);
  const fill =
    total !== null && total > 0 && occupied !== null
      ? Math.min(100, (occupied / total) * 100)
      : null;
  const cpu = percent(load?.cpuPercent),
    memory = percent(load?.memoryUsedPercent),
    gpu = percent(load?.gpuPercent);
  const values = [cpu, memory, gpu].filter((value): value is number => value !== null);
  const hardware = values.length ? Math.max(...values) : null;
  const label =
    executing !== null && executing > 0
      ? t('执行中 {{value1}}', { value1: executing })
      : paused
        ? t('执行已暂停')
        : executing === 0 && occupied !== null && occupied > 0
          ? t('等待继续')
          : occupied === 0 && (concurrency !== null || (total !== null && total > 0))
            ? t('空闲')
            : occupied !== null
              ? t('已占用 {{value1}}', { value1: occupied })
              : capability.status;
  const queueCount = connected ? nodeQueueBacklog(node, now) : null;
  return {
    concurrency,
    queueCount,
    queueThreshold: queueReminderThreshold,
    queueFill:
      queueCount === null ? null : Math.min(100, (queueCount / queueReminderThreshold) * 100),
    ...capability,
    occupied,
    total,
    executing,
    paused,
    fill,
    cpu,
    memory,
    gpu,
    hardware,
    partial: values.length < 3,
    label,
  };
}

/** Titles already visible here, only for the current target; never source-node attribution. */
export function machineConversations(nodeID: string, items: readonly Conversation[]) {
  return items.filter((item) => {
    const target = item.remote?.targetNodeID ?? item.brainTask?.selectedWorkerID;
    const group = conversationStatusGroup(item);
    return target === nodeID && group !== 'completed' && group !== 'ended';
  });
}

export function machineBytes(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return t('未知');
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(value / 1024 ** 2)} MiB`;
}
