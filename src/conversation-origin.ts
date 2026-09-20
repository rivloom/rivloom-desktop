import type { Conversation } from '../shared/conversations.ts';

export type ConversationOrigin = {
  kind: 'own' | 'delegated' | 'unknown';
  actorID?: string;
  nodeID?: string;
};
export type ConversationOriginContext = {
  userID: string;
  owner: boolean;
  localNodeID?: string | null;
};

const knownID = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Display provenance, separate from the existing device-level incoming flag.
 * Local execution proxies use the worker owner's creatorID; it cannot identify
 * the person who delegated the work. Logical Brain/Workflow provenance wins.
 */
export function conversationOrigin(item: Conversation, context: ConversationOriginContext): ConversationOrigin {
  const localID = knownID(context.localNodeID) ? context.localNodeID : undefined;
  const creator = (actorID: unknown): ConversationOrigin => knownID(actorID)
    ? { kind: actorID === context.userID ? 'own' : 'delegated', actorID }
    : { kind: 'unknown' };
  const device = (nodeID: unknown): ConversationOrigin => knownID(nodeID)
    ? { kind: localID && nodeID === localID ? 'unknown' : 'delegated', nodeID }
    : { kind: 'unknown' };

  if (item.workflow) return creator(item.workflow.creatorID);

  if (item.brainTask) {
    const submitter = item.brainTask.submitterNodeID;
    if (!knownID(submitter)) return { kind: 'unknown' };
    if (!localID) return { kind: 'unknown', nodeID: submitter };
    if (submitter !== localID) return { kind: 'delegated', nodeID: submitter };
    // The scheduled-task creation API is owner-only. "owned" means this node
    // coordinates the task; it does not mean this node submitted it.
    return context.owner && knownID(context.userID)
      ? { kind: 'own', actorID: context.userID, nodeID: submitter }
      : { kind: 'unknown', nodeID: submitter };
  }

  if (item.localTask?.remoteOrigin) return device(item.localTask.remoteOrigin.ownerNodeID);
  if (item.remote) {
    if (item.remote.direction === 'incoming') return device(item.remote.ownerNodeID);
    if (item.remote.direction === 'outgoing') {
      const nodeID = knownID(item.remote.ownerNodeID) ? item.remote.ownerNodeID : undefined;
      // Without the Brain record, an outgoing assignment may relay another
      // device's request. Do not turn the coordinator into the original author.
      if (!item.remote.brainTaskID && localID && nodeID === localID && context.owner && knownID(context.userID))
        return { kind: 'own', actorID: context.userID, nodeID };
      return { kind: 'unknown', ...(nodeID ? { nodeID } : {}) };
    }
    return { kind: 'unknown' };
  }

  if (item.localTask) return creator(item.localTask.creatorID);
  if (item.incoming && knownID(item.sourceNodeID) && localID && item.sourceNodeID !== localID)
    return { kind: 'delegated', nodeID: item.sourceNodeID };
  return { kind: 'unknown' };
}
