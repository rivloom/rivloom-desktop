import type { Conversation } from '../shared/conversations.ts';
import { activeStates, type User } from '../shared/types.ts';

export type ConversationStopTarget = {
  key: string;
  path: string;
  body: Record<string, unknown>;
  confirming: boolean;
  blocked?: boolean;
  unconfirmed?: boolean;
};
export type ConversationStopRequest = { key: string; phase: 'sending' | 'confirming' | 'retry' };

/** Stop the conversation's whole workflow, never only its latest local/remote attempt. */
export function conversationStopTarget(
  conversation: Pick<Conversation, 'workflow' | 'localTask' | 'remote'> | undefined,
  user: Pick<User, 'id' | 'owner'>,
): ConversationStopTarget | null {
  if (!conversation) return null;
  const { workflow, localTask: task, remote } = conversation;
  if (workflow) {
    if (workflow.creatorID !== user.id || ['completed', 'failed', 'stopped'].includes(workflow.state)) return null;
    return { key: `workflow:${workflow.id}:${workflow.roundRequestID || workflow.requestID}`,
      path: `/workflows/${workflow.id}/control`, body: { action: 'stop' }, confirming: workflow.state === 'stopping' };
  }
  if (task) {
    if (!task.sessionID || (!user.owner && ![task.creatorID, task.assigneeID].includes(user.id)) ||
      ![...activeStates, 'interrupted'].includes(task.state)) return null;
    return { key: `task:${task.id}:${task.sessionID}:${task.runAfter}`,
      path: `/tasks/${task.id}/stop`, body: {}, confirming: task.state === 'stopping', unconfirmed: task.state === 'interrupted' };
  }
  if (!remote || !user.owner || remote.direction !== 'outgoing' || remote.executionSequence <= 0 ||
    !['pending', 'accepted'].includes(remote.status) ||
    remote.executionState === 'not_started' ||
    ![...activeStates, 'interrupted'].includes(remote.executionState)) return null;
  return { key: `remote:${remote.id}:${remote.executionSequence}`, path: `/network/tasks/${remote.id}/control`,
    body: { expectedExecutionSequence: remote.executionSequence, action: { kind: 'stop' }, confirmed: true },
    confirming: remote.executionState === 'stopping', blocked: remote.controlPending, unconfirmed: remote.executionState === 'interrupted' };
}

/** A pending HTTP response or a server acknowledgement is not a confirmed stop. */
export function conversationStopState(target: ConversationStopTarget | null, request?: ConversationStopRequest | null) {
  if (!target) return null;
  if (request?.key === target.key && request.phase === 'sending') return 'confirming';
  if (target.unconfirmed && !target.confirming && !target.blocked) return 'retry';
  if (target.confirming || (request?.key === target.key && request.phase === 'confirming')) return 'confirming';
  if (target.blocked) return 'waiting';
  return request?.key === target.key && request.phase === 'retry' ? 'retry' : 'ready';
}
