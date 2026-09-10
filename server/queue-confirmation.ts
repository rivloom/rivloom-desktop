import { queueReminderThreshold, type QueueConfirmation } from '../shared/queue-backlog.ts';
export class QueueConfirmationRequired extends Error {
  readonly status = 409;
  readonly queueConfirmation: QueueConfirmation;
  constructor(nodeID: string, name: string, count: number) {
    super('队列任务较多，请确认是否继续提交。');
    this.queueConfirmation = { nodeID, name, count, threshold: queueReminderThreshold };
  }
}
export function requireQueueConfirmation(
  nodeID: string,
  name: string,
  count: number | null,
  confirmedFor?: string,
) {
  if (count !== null && count >= queueReminderThreshold && confirmedFor !== nodeID)
    throw new QueueConfirmationRequired(nodeID, name, count);
}
