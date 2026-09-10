import { activeStates, type Task, type RemoteTaskInvite } from '../shared/types.ts';
import type { NodeQueueEntry } from '../shared/node-queue.ts';

type OccupancyTask = Pick<Task, 'id' | 'state' | 'remoteOrigin'>;
type OccupancyRemote = Pick<RemoteTaskInvite, 'id' | 'direction' | 'brainTaskID' | 'status' | 'localTaskID' | 'executionSequence'>;

export function occupiesWorkerSlot(task: Pick<Task, 'state' | 'remoteOrigin'>) {
  return (
    activeStates.includes(task.state) ||
    task.state === 'review' ||
    task.state === 'interrupted' ||
    (!!task.remoteOrigin && task.state === 'ready')
  );
}

export function isRemoteExecution(task: OccupancyTask, queue: readonly NodeQueueEntry[], remotes: readonly OccupancyRemote[]) {
  return !!task.remoteOrigin || queue.some((entry) => entry.localTaskID === task.id && entry.source.kind === 'remote') ||
    remotes.some((remote) => remote.direction === 'incoming' && remote.localTaskID === task.id);
}

/** Count durable executions, including unbound reservations, once and by original source. */
export function executionOccupancy(input: {
  tasks: readonly OccupancyTask[];
  queue: readonly NodeQueueEntry[];
  remotes: readonly OccupancyRemote[];
  taskState: (id: string) => Task['state'] | undefined;
  excludeTaskID?: string;
  excludeQueueID?: string;
}) {
  const incomingTasks = new Set(input.remotes.filter((remote) => remote.direction === 'incoming' && remote.localTaskID)
    .map((remote) => remote.localTaskID!));
  const queuedRemotes = new Set<string>();
  for (const entry of input.queue) if (entry.source.kind === 'remote') {
    queuedRemotes.add(entry.source.remoteTaskID);
    if (entry.localTaskID) incomingTasks.add(entry.localTaskID);
  }
  const occupied = new Map<string, 'local' | 'remote'>();
  for (const task of input.tasks) if (task.id !== input.excludeTaskID && occupiesWorkerSlot(task))
    occupied.set(task.id, task.remoteOrigin || incomingTasks.has(task.id) ? 'remote' : 'local');
  for (const entry of input.queue) {
    if (entry.id === input.excludeQueueID || entry.state !== 'admitted' ||
      (input.excludeTaskID && entry.localTaskID === input.excludeTaskID)) continue;
    const state = entry.localTaskID ? input.taskState(entry.localTaskID) : undefined;
    if (!state || state === 'ready') {
      const key = entry.localTaskID || entry.id;
      occupied.set(key, incomingTasks.has(key) || entry.source.kind === 'remote' ? 'remote' : 'local');
    }
  }
  for (const remote of input.remotes) if (remote.direction === 'incoming' && remote.brainTaskID && remote.status === 'accepted' &&
    !queuedRemotes.has(remote.id) && !remote.localTaskID && remote.executionSequence === 0)
    occupied.set(`remote:${remote.id}`, 'remote');
  const counts = { localOccupied: 0, remoteOccupied: 0, localExecuting: 0, remoteExecuting: 0 };
  for (const source of occupied.values()) counts[source === 'local' ? 'localOccupied' : 'remoteOccupied']++;
  for (const task of input.tasks) if (task.state === 'running' && occupied.has(task.id))
    counts[occupied.get(task.id) === 'remote' ? 'remoteExecuting' : 'localExecuting']++;
  return counts;
}

export class WorkerAdmissionGate {
  private pending: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.pending.catch(() => undefined).then(operation);
    this.pending = current;
    return current;
  }
}
