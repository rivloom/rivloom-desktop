import type { Bootstrap } from './types.ts';
import type { Conversation } from './conversations.ts';
import { workflowAllSteps, workflowPendingMessages } from './workflows.ts';
import type { NodeQueueEntry } from './node-queue.ts';
import { t } from './i18n.ts';
import { directoryDisplayName, type DirectoryAliases } from './directory-aliases.ts';

export type HistoryMembers = { local: string[]; remote: string[]; brain: string[]; workflow: string[]; requests: string[] };
export type TrashEntry = { key: string; title: string; directory: string; deletedAt: string; expiresAt: string; purging: boolean };
export function historyExpiry(at: string): string {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 3);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
export function historyMembers(item: Conversation, data: Pick<Bootstrap, 'tasks' | 'network'>): HistoryMembers {
  const local = new Set<string>(), remote = new Set(item.attempts.map((r) => r.id));
  if (item.localTask) local.add(item.localTask.id);
  if (item.remote) remote.add(item.remote.id);
  for (const attempt of item.brainTask?.executions || []) remote.add(attempt.executionID);
  for (const attempt of item.workflow ? workflowAllSteps(item.workflow).flatMap((s) => s.attempts) : [])
    (attempt.kind === 'local' ? local : remote).add(attempt.executionID);
  for (const record of data.network.remoteTasks) if (remote.has(record.id) && record.localTaskID) local.add(record.localTaskID);
  for (const record of data.tasks) if (record.remoteOrigin && remote.has(record.remoteOrigin.remoteTaskID) ||
    item.workflow && record.collaboration?.workflowID === item.workflow.id) local.add(record.id);
  const brain = item.brainTask ? [item.brainTask.id] : item.key.startsWith('brain:') ? [item.key.slice(6)] : [];
  return { local: [...local], remote: [...remote], brain, workflow: item.workflow ? [item.workflow.id] : [],
    requests: item.workflow ? [...new Set([item.workflow.requestID, ...(item.workflow.messages || []).map((m) => m.requestID)])].map((id) => `${item.workflow!.creatorID}:${id}`) : [] };
}
export function historyCanTrash(item: Conversation, data: Pick<Bootstrap, 'tasks' | 'network'>, queue: NodeQueueEntry[] = []): boolean {
  const members = historyMembers(item, data);
  if (item.workflow && workflowPendingMessages(item.workflow).length) return false;
  if (item.workflow && (!['completed', 'failed', 'stopped'].includes(item.workflow.state) ||
    workflowAllSteps(item.workflow).some((s) => s.attempts.some((a) => !['completed', 'failed', 'stopped'].includes(a.phase))))) return false;
  if (item.brainTask && (item.brainTask.deliveryPending || !['completed', 'failed'].includes(item.brainTask.status))) return false;
  if (data.tasks.some((task) => members.local.includes(task.id) && !['open', 'ready', 'accepted', 'failed', 'stopped'].includes(task.state))) return false;
  if (data.network.remoteTasks.some((r) => members.remote.includes(r.id) && (r.controlPending || r.deliveryPending ||
    r.status === 'pending' || r.status === 'accepted' && !['accepted', 'failed', 'stopped'].includes(r.executionState)))) return false;
  return !queue.some((q) => q.state !== 'ended' && (q.localTaskID && members.local.includes(q.localTaskID) ||
    q.source.kind === 'local' && members.local.includes(q.source.taskID) || q.source.kind === 'remote' && members.remote.includes(q.source.remoteTaskID)));
}
export function conversationDirectory(item: Conversation, data: Pick<Bootstrap, 'projects' | 'network'>): { key: string; label: string } {
  const localID = item.workflow?.projectID || item.localTask?.projectID || (item.remote?.direction === 'incoming' ? item.remote.localProjectID : null) ||
    item.workflow && [item.workflow.planner, ...item.workflow.steps].flatMap((s) => s.attempts).find((a) => a.localConfig?.projectID)?.localConfig?.projectID;
  if (localID) {
    const project = data.projects.find((p) => p.id === localID);
    const directory = project?.directory;
    return { key: directory ? `local:${directory.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()}` : `local-project:${localID}`,
      label: directory || t('工作目录已不可用') };
  }
  const remote = item.remote || item.attempts.at(-1);
  const projectID = remote?.requestedProjectID || remote?.localProjectID || item.brainTask?.requestedProjectID;
  if (remote?.direction === 'outgoing' && projectID) {
    const node = [data.network.local, ...(data.network.paired || []), ...data.network.nearby].find((n) => n?.id === remote.targetNodeID);
    const project = node?.worker?.projects.find((p) => p.id === projectID);
    return { key: `remote:${remote.targetNodeID}:${projectID}`, label: `${node?.name || t('远端设备')} / ${project?.name || t('工作目录已不可用')}` };
  }
  return { key: 'unspecified', label: t('未指定工作目录') };
}
export function groupConversationHistory(items: Conversation[], data: Pick<Bootstrap, 'projects' | 'network'>, aliases: DirectoryAliases = {}) {
  const groups = new Map<string, { key: string; label: string; name: string; items: Conversation[] }>();
  for (const item of items) {
    const directory = conversationDirectory(item, data);
    const group = groups.get(directory.key) || { ...directory, name: directoryDisplayName(directory, aliases), items: [] };
    group.items.push(item); groups.set(directory.key, group);
  }
  return [...groups.values()].map((group) => ({ ...group,
    items: group.items.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
  }));
}
