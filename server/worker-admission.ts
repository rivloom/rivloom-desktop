import { activeStates, type Task } from '../shared/types.ts';

export function occupiesWorkerSlot(task: Task) {
  return (
    activeStates.includes(task.state) ||
    task.state === 'review' ||
    task.state === 'interrupted' ||
    (!!task.remoteOrigin && task.state === 'ready')
  );
}

export class WorkerAdmissionGate {
  private pending: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.pending.catch(() => undefined).then(operation);
    this.pending = current;
    return current;
  }
}
