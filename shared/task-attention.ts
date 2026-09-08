import { t } from './i18n.ts';
import type { Bootstrap, RemoteTaskInvite, Task, TaskState, User } from './types.ts';

export type AttentionKind =
  'approval' | 'input' | 'review' | 'interrupted' | 'failed' | 'completed';
export type AttentionItem = {
  key: string;
  conversationKey: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  updatedAt: string;
  fingerprint: string;
};
export type AttentionObservation = { conversationKey: string; fingerprint: string };
export type NotificationPreferences = { enabled: boolean; quietUntil: number | null };
export type AttentionSnapshot = {
  items: AttentionItem[];
  notifications: AttentionItem[];
  preferences: NotificationPreferences;
  checkedAt: string;
};

export const attentionLabels: Record<AttentionKind, string> = {
  get approval() {
    return t('待审批');
  },
  get input() {
    return t('待回答');
  },
  get review() {
    return t('待验收');
  },
  get interrupted() {
    return t('执行中断');
  },
  get failed() {
    return t('需要检查');
  },
  get completed() {
    return t('已完成');
  },
};
const priority: Record<AttentionKind, number> = {
  approval: 0,
  input: 1,
  interrupted: 2,
  review: 3,
  failed: 4,
  completed: 5,
};
const details: Record<AttentionKind, string> = {
  get approval() {
    return t('AI 正在等待操作批准，打开会话查看具体请求。');
  },
  get input() {
    return t('AI 有问题需要回答，补充信息后可继续。');
  },
  get review() {
    return t('执行已结束，核对文件和验证结果后确认完成。');
  },
  get interrupted() {
    return t('执行状态需要确认。先检查已有修改，再决定是否继续。');
  },
  get failed() {
    return t('打开会话检查原因，原任务和执行记录已保留。');
  },
  get completed() {
    return t('任务已确认完成，可以查看结果。');
  },
};

function kindForState(state: TaskState | 'not_started'): AttentionKind | null {
  return (
    (
      {
        waiting_approval: 'approval',
        waiting_input: 'input',
        review: 'review',
        interrupted: 'interrupted',
        failed: 'failed',
        accepted: 'completed',
      } as const
    )[
      state as
        'waiting_approval' | 'waiting_input' | 'review' | 'interrupted' | 'failed' | 'accepted'
    ] || null
  );
}

function canHandle(task: Task, user: User, kind: AttentionKind) {
  if (kind === 'approval') return task.approverID === user.id;
  if (kind === 'input' || kind === 'interrupted' || kind === 'failed')
    return task.assigneeID === user.id;
  if (kind === 'review') return task.reviewerID === user.id;
  return [task.creatorID, task.assigneeID, task.approverID, task.reviewerID].includes(user.id);
}

/** Derive from the same stable Task routes as the conversation list, never from queue statistics. */
export function collectAttention(data: Bootstrap): {
  items: AttentionItem[];
  observations: AttentionObservation[];
  events: AttentionItem[];
} {
  const candidates = new Map<
    string,
    {
      title: string;
      updatedAt: string;
      task?: Task;
      remote?: RemoteTaskInvite;
      brainState?: string;
      executionID?: string | null;
    }
  >();
  const remotes = data.network.remoteTasks;
  const linked = new Set(remotes.map((r) => r.localTaskID).filter(Boolean));
  for (const brain of data.network.brainTasks) {
    const remote = remotes.find((r) => r.id === brain.executionID && r.brainTaskID === brain.id);
    candidates.set(`brain:${brain.id}`, {
      title: brain.title,
      updatedAt: brain.updatedAt,
      brainState: brain.status,
      executionID: brain.executionID,
      remote,
      task: data.tasks.find((t) => t.id === remote?.localTaskID),
    });
  }
  for (const remote of [...remotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = remote.brainTaskID ? `brain:${remote.brainTaskID}` : `remote:${remote.id}`;
    if (remote.brainTaskID && data.network.brainTasks.some((b) => b.id === remote.brainTaskID))
      continue;
    candidates.set(key, {
      title: remote.title,
      updatedAt: remote.updatedAt,
      remote,
      task: data.tasks.find((t) => t.id === remote.localTaskID),
    });
  }
  for (const task of data.tasks)
    if (!linked.has(task.id))
      candidates.set(`local:${task.id}`, { title: task.title, updatedAt: task.updatedAt, task });

  const observations: AttentionObservation[] = [];
  const events: AttentionItem[] = [];
  for (const [conversationKey, value] of candidates) {
    const { task, remote } = value;
    const state = task?.state || remote?.executionState;
    let kind = state ? kindForState(state) : null;
    const remoteOwner = !!remote && remote.direction === 'outgoing' && data.user.owner;
    if (task && kind && !canHandle(task, data.user, kind)) kind = null;
    if (!task && !remoteOwner) kind = null;
    if (!task && data.user.owner && value.brainState === 'completed') kind = 'completed';
    if (!task && data.user.owner && value.brainState === 'failed') kind = 'failed';
    // A declined old Execution must not become a fault on a Brain Task that is already retrying.
    if (
      !task &&
      remoteOwner &&
      !value.brainState &&
      ['declined', 'expired', 'cancelled'].includes(remote!.status)
    )
      kind = 'failed';
    if (!task && remoteOwner && !value.brainState && remote?.queueReceipt?.state === 'rejected')
      kind = 'failed';
    const requests =
      kind === 'approval'
        ? (task?.approvals || remote?.remoteApprovals || []).map((r) => r.id).sort()
        : kind === 'input'
          ? (task?.questions || remote?.remoteQuestions || []).map((r) => r.id).sort()
          : [];
    if ((kind === 'approval' || kind === 'input') && !requests.length) kind = null;
    const fingerprint = JSON.stringify([
      task?.id || remote?.id || value.executionID || '',
      kind || state || value.brainState || 'idle',
      ...(kind === 'approval' || kind === 'input' ? requests : [task?.runAfter || 0]),
    ]);
    observations.push({ conversationKey, fingerprint });
    if (!kind) continue;
    events.push({
      key: `${conversationKey}:${kind}`,
      conversationKey,
      kind,
      title: value.title,
      detail: details[kind],
      updatedAt: task?.updatedAt || value.updatedAt,
      fingerprint,
    });
  }
  events.sort(
    (a, b) =>
      priority[a.kind] - priority[b.kind] ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.key.localeCompare(b.key),
  );
  return { items: events.filter((e) => e.kind !== 'completed'), events, observations };
}
