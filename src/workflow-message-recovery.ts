import type { Workflow } from '../shared/workflows.ts';

/** Sending a new message is the continuation action. Only preparation errors need a retry. */
export function workflowMessageRecovery(value: Pick<Workflow, 'state' | 'queuePaused' | 'queueError'>) {
  if (value.state === 'stopping') return { kind: 'stopping' as const };
  return value.queueError ? { kind: 'retry' as const } : null;
}
