import type { Bootstrap, BrainTask, RemoteTaskInvite, Task } from './types.ts';
import type { Workflow } from './workflows.ts';

export type Conversation = {
  key: string;
  title: string;
  pinned?: boolean;
  description: string;
  updatedAt: string;
  createdAt: string;
  sourceNodeID: string | null;
  incoming: boolean;
  localTask?: Task;
  workflow?: Workflow;
  workflowAttention?: boolean;
  brainTask?: BrainTask;
  remote?: RemoteTaskInvite;
  attempts: RemoteTaskInvite[];
};

/** One UI conversation per stable Task; Execution retries remain inside that conversation. */
export function conversations(data: Pick<Bootstrap, 'tasks' | 'network' | 'workflows' | 'conversationPreferences'>): Conversation[] {
  const result = new Map<string, Conversation>();
  const localID = data.network.local?.id;
  const remotes = data.network.remoteTasks;
  const bound = new Set(remotes.map((r) => r.localTaskID).filter(Boolean));
  const workflowExecutions = new Set<string>();
  for (const workflow of data.workflows || []) {
    const attempts = [workflow.planner, ...workflow.steps].flatMap((step) => step.attempts);
    for (const attempt of attempts) workflowExecutions.add(attempt.executionID);
    const active = new Set([workflow.planner, ...workflow.steps].filter((step) => step.state === 'running').map((step) => step.attempts.at(-1)?.executionID));
    result.set(`workflow:${workflow.id}`, { key: `workflow:${workflow.id}`, title: workflow.title, description: workflow.description,
      createdAt: workflow.createdAt, updatedAt: workflow.updatedAt, sourceNodeID: localID || null, incoming: false, workflow,
      workflowAttention: !!workflow.pendingConfirmation || attempts.some((attempt) => active.has(attempt.executionID) &&
        (attempt.phase === 'unknown' || data.tasks.some((task) => task.id === attempt.executionID && ['waiting_approval', 'waiting_input'].includes(task.state)) ||
          remotes.some((remote) => remote.id === attempt.executionID && ['waiting_approval', 'waiting_input'].includes(remote.executionState)))),
      attempts: remotes.filter((remote) => attempts.some((a) => a.executionID === remote.id)) });
  }
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
    if (remote.direction === 'outgoing' && workflowExecutions.has(remote.id)) continue;
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
    if (bound.has(localTask.id) || workflowExecutions.has(localTask.id) && !localTask.remoteOrigin) continue;
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
  return [...result.values()].map((item) => {
    const preference = data.conversationPreferences?.[item.key];
    return preference ? { ...item, title: preference.title || item.title, pinned: preference.pinned === true } : item;
  }).sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
}
