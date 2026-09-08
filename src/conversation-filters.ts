import type { BrainTask, TaskState } from '../shared/types.ts';
import type { Conversation } from './conversations.ts';

export const conversationStatusFilters = [
  'all',
  'active',
  'attention',
  'completed',
  'ended',
] as const;
export type ConversationStatusFilter = (typeof conversationStatusFilters)[number];
export type ConversationStatusGroup = Exclude<ConversationStatusFilter, 'all'>;

export const conversationSourceFilters = ['all', 'own', 'incoming'] as const;
export type ConversationSourceFilter = (typeof conversationSourceFilters)[number];

export type ConversationFilters = {
  status?: ConversationStatusFilter;
  source?: ConversationSourceFilter;
  query?: string;
};

const taskStatusGroups: Record<TaskState, ConversationStatusGroup> = {
  open: 'active',
  ready: 'active',
  running: 'active',
  waiting_approval: 'attention',
  waiting_input: 'attention',
  stopping: 'active',
  stopped: 'ended',
  interrupted: 'attention',
  failed: 'ended',
  review: 'attention',
  accepted: 'completed',
};

const brainStatusGroups: Record<BrainTask['status'], ConversationStatusGroup> = {
  submitting: 'active',
  queued: 'active',
  assigned: 'active',
  running: 'active',
  waiting: 'attention',
  review: 'attention',
  completed: 'completed',
  failed: 'ended',
};

/** Classify raw state codes, independently of the displayed language. */
export function conversationStatusGroup(item: Conversation): ConversationStatusGroup {
  const localState = item.localTask?.state;
  const localGroup = localState ? taskStatusGroups[localState] : undefined;
  // A local execution is the most direct observation; an initial task can still be queued.
  if (localGroup && localState !== 'open' && localState !== 'ready') return localGroup;

  const brain = item.brainTask;
  const brainGroup = brain ? brainStatusGroups[brain.status] : undefined;
  if (brainGroup === 'completed' || brainGroup === 'ended') return brainGroup;

  // Delivery can be cancelled after the last execution snapshot was received.
  // That stale snapshot must not turn a cancelled delivery into a completed task.
  const remote = item.remote;
  if (remote && ['declined', 'cancelled', 'expired'].includes(remote.status)) return 'ended';
  const remoteState = remote?.executionState;
  const remoteGroup =
    remoteState && remoteState !== 'not_started' ? taskStatusGroups[remoteState] : undefined;
  if (remoteGroup && remoteState !== 'open' && remoteState !== 'ready') return remoteGroup;
  if (brain && ['running', 'waiting', 'review'].includes(brain.status)) return brainGroup!;

  const receipt = brain?.queueReceipt || remote?.queueReceipt;
  if (receipt?.state === 'rejected') return 'ended';
  if (receipt?.state === 'held') return 'attention';

  // Historical attempts stay inside the conversation and do not determine its current group.
  return localGroup || brainGroup || remoteGroup || 'active';
}

export function filterConversations(
  items: readonly Conversation[],
  { status = 'all', source = 'all', query = '' }: ConversationFilters,
  nodeName: (id: string | null) => string,
): Conversation[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (status === 'all' || conversationStatusGroup(item) === status) &&
      (source === 'all' || (source === 'incoming' ? item.incoming : !item.incoming)) &&
      (!normalizedQuery ||
        `${item.title} ${nodeName(item.sourceNodeID)}`.toLowerCase().includes(normalizedQuery) ||
        // The saved user requirement excludes the internal envelope in engine messages.
        item.description.toLowerCase().includes(normalizedQuery)),
  );
}
