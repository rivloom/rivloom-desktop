import type { Conversation } from '../shared/conversations.ts';
export { conversations, type Conversation } from '../shared/conversations.ts';
import { t } from '../shared/i18n.ts';
import {
  activeStates,
  stateLabels,
  type Bootstrap,
  type BrainTask,
  type Task,
  type RivloomNode,
} from '../shared/types.ts';
import type { NodeQueueItem } from '../shared/node-queue.ts';

/** Queue history stays durable; the execution rail follows confirmed Task state. */
export function executionQueueEntries(entries: NodeQueueItem[], tasks: Task[]): NodeQueueItem[] {
  const byID = new Map(tasks.map((task) => [task.id, task]));
  return entries.filter((entry) => {
    const task = entry.localTaskID ? byID.get(entry.localTaskID) : undefined;
    if (entry.state !== 'ended') return entry.state !== 'admitted' || task?.state !== 'stopped';
    // Explicit continuation reuses the Task/session, without reopening automatic admission.
    return entry.endReason?.code === 'stopped' && !!task &&
      [...activeStates, 'review', 'interrupted'].includes(task.state);
  });
}

const brainLabels: Record<BrainTask['status'], string> = {
  get submitting() {
    return t('正在发送');
  },
  get queued() {
    return t('排队中');
  },
  get assigned() {
    return t('已分配');
  },
  get running() {
    return t('执行中');
  },
  get waiting() {
    return t('等待处理');
  },
  get review() {
    return t('已完成');
  },
  get completed() {
    return t('已完成');
  },
  get failed() {
    return t('执行失败');
  },
};

/** Presentation only: match the current label's observation precedence, not the broader active group. */
export function conversationIsRunning(item: Conversation): boolean {
  if (item.workflow) return [item.workflow.planner, ...item.workflow.steps].some((step) => step.attempts.at(-1)?.phase === 'running');
  if (item.localTask && !['open', 'ready'].includes(item.localTask.state))
    return item.localTask.state === 'running';
  if (item.brainTask && ['completed', 'failed'].includes(item.brainTask.status)) return false;
  if (item.remote && !['pending', 'accepted'].includes(item.remote.status)) return false;
  if (item.remote && !['not_started', 'open', 'ready'].includes(item.remote.executionState))
    return item.remote.executionState === 'running';
  return item.brainTask?.status === 'running';
}

export function conversationState(item: Conversation): string {
  if (item.workflow) {
    if (item.workflowAttention) return t('等待处理');
    return { planning: t('分析与规划'), running: t('执行中'), paused: t('已暂停'), stopping: t('正在停止'),
      stopped: t('已停止'), completed: t('已完成'), failed: t('执行失败') }[item.workflow.state];
  }
  if (item.localTask && !['open', 'ready'].includes(item.localTask.state))
    return stateLabels[item.localTask.state];
  if (item.brainTask && ['completed', 'failed'].includes(item.brainTask.status))
    return brainLabels[item.brainTask.status];
  if (item.remote && !['pending', 'accepted'].includes(item.remote.status))
    return { declined: t('未获准执行'), cancelled: t('已取消'), expired: t('已过期') }[
      item.remote.status as 'declined' | 'cancelled' | 'expired'
    ];
  if (item.remote && !['not_started', 'open', 'ready'].includes(item.remote.executionState))
    return stateLabels[item.remote.executionState as Exclude<Task['state'], 'open' | 'ready'>];
  if (item.brainTask && ['running', 'waiting', 'review'].includes(item.brainTask.status))
    return brainLabels[item.brainTask.status];
  const receipt = item.brainTask?.queueReceipt || item.remote?.queueReceipt;
  if (receipt?.state === 'rejected') return t('已拒绝执行');
  if (receipt?.state === 'held') return t('已暂缓');
  if (receipt?.state === 'queued') return t('已入队');
  if (receipt?.state === 'admitted') return t('已获执行槽');
  if (item.localTask) return stateLabels[item.localTask.state];
  if (item.brainTask) return brainLabels[item.brainTask.status];
  const remote = item.remote;
  if (!remote) return t('等待执行');
  if (remote.executionState !== 'not_started') return stateLabels[remote.executionState];
  return {
    pending: t('等待接收'),
    accepted: t('等待执行'),
    declined: t('未获准执行'),
    cancelled: t('已取消'),
    expired: t('已过期'),
  }[remote.status];
}

export function localQueue(items: Conversation[], localNodeID?: string): Conversation[] {
  return items
    .filter((item) => {
      if (item.workflow) return [item.workflow.planner, ...item.workflow.steps].some((step) => {
        const attempt = step.attempts.at(-1);
        return !!attempt && attempt.nodeID === localNodeID && ['intent', 'queued', 'running', 'waiting', 'unknown'].includes(attempt.phase);
      });
      if (item.localTask)
        return ['open', 'ready', ...activeStates, 'review', 'interrupted'].includes(
          item.localTask.state,
        );
      const remote = item.remote;
      return (
        !!remote &&
        remote.targetNodeID === localNodeID &&
        ['pending', 'accepted'].includes(remote.status) &&
        ['not_started', 'open', 'ready', ...activeStates, 'review', 'interrupted'].includes(
          remote.executionState,
        )
      );
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function pairedNodes(data: Bootstrap): RivloomNode[] {
  return (data.network.paired || data.network.nearby.filter((n) => n.trusted))
    .filter((n) => n.trusted && !n.local)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export function showNetworkRail(nodes: RivloomNode[]): boolean {
  return nodes.some((node) => node.trusted && node.online && node.channelReady);
}
