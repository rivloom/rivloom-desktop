import { t } from '../shared/i18n.ts';
import {
  activeStates,
  stateLabels,
  type Bootstrap,
  type BrainTask,
  type RemoteTaskInvite,
  type Task,
  type RivloomNode,
} from '../shared/types.ts';

export type Conversation = {
  key: string;
  title: string;
  description: string;
  updatedAt: string;
  createdAt: string;
  sourceNodeID: string | null;
  incoming: boolean;
  localTask?: Task;
  brainTask?: BrainTask;
  remote?: RemoteTaskInvite;
  attempts: RemoteTaskInvite[];
};

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
    return t('待验收');
  },
  get completed() {
    return t('已完成');
  },
  get failed() {
    return t('执行失败');
  },
};

/** One UI conversation per stable Task; Execution retries remain inside that conversation. */
export function conversations(data: Bootstrap): Conversation[] {
  const result = new Map<string, Conversation>();
  const localID = data.network.local?.id;
  const remotes = data.network.remoteTasks;
  const bound = new Set(remotes.map((r) => r.localTaskID).filter(Boolean));
  for (const brainTask of data.network.brainTasks) {
    const attempts = remotes.filter((r) => r.brainTaskID === brainTask.id);
    const remote = attempts.find((r) => r.id === brainTask.executionID);
    const localTask = data.tasks.find((t) => t.id === remote?.localTaskID);
    result.set(`brain:${brainTask.id}`, {
      key: `brain:${brainTask.id}`,
      title: brainTask.title,
      description: brainTask.description,
      createdAt: brainTask.createdAt,
      updatedAt: localTask?.updatedAt || brainTask.updatedAt,
      sourceNodeID: brainTask.submitterNodeID,
      incoming: brainTask.submitterNodeID !== localID,
      brainTask,
      remote,
      localTask,
      attempts,
    });
  }
  for (const remote of [...remotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = remote.brainTaskID ? `brain:${remote.brainTaskID}` : `remote:${remote.id}`;
    if (result.get(key)?.brainTask) continue;
    const localTask = data.tasks.find((t) => t.id === remote.localTaskID);
    const previous = result.get(key);
    result.set(key, {
      key,
      title: remote.title,
      description: remote.description,
      createdAt: previous?.createdAt || remote.createdAt,
      updatedAt: localTask?.updatedAt || remote.updatedAt,
      sourceNodeID: remote.ownerNodeID,
      incoming: remote.ownerNodeID !== localID,
      remote,
      localTask,
      attempts: [...(previous?.attempts || []), remote],
    });
  }
  for (const localTask of data.tasks) {
    if (bound.has(localTask.id)) continue;
    const origin = localTask.remoteOrigin;
    const key = `local:${localTask.id}`;
    result.set(key, {
      key,
      title: localTask.title,
      description: localTask.description,
      createdAt: localTask.createdAt,
      updatedAt: localTask.updatedAt,
      sourceNodeID: origin?.ownerNodeID || localID || null,
      incoming: !!origin && origin.ownerNodeID !== localID,
      localTask,
      attempts: [],
    });
  }
  return [...result.values()].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
}

export function conversationState(item: Conversation): string {
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
