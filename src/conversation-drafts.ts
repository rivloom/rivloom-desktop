export type ConversationRouting =
  { kind: 'local' } | { kind: 'automatic' } | { kind: 'node'; nodeID: string; name: string };

export type ConversationDraft = {
  text: string;
  routing: ConversationRouting;
  requestID: string;
  /** Normalized creation options captured when this logical request is first sent. */
  requestSignature?: string;
};

export function createConversationDraft(
  requestID: string = crypto.randomUUID(),
): ConversationDraft {
  return { text: '', routing: { kind: 'local' }, requestID };
}

function routingIdentity(routing: ConversationRouting) {
  return routing.kind === 'node' ? `node:${routing.nodeID}` : routing.kind;
}

export function updateConversationDraft(
  draft: ConversationDraft,
  change: Partial<Pick<ConversationDraft, 'text' | 'routing'>>,
  newRequestID: () => string = () => crypto.randomUUID(),
): ConversationDraft {
  const next = { ...draft, ...change };
  if (
    next.text.trim() === draft.text.trim() &&
    routingIdentity(next.routing) === routingIdentity(draft.routing)
  )
    return next;
  return { ...next, requestID: newRequestID(), requestSignature: undefined };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** A failed HTTP response keeps this request ID; changed work or options starts a new request. */
export function prepareConversationRequest(
  draft: ConversationDraft,
  options: Record<string, unknown>,
): ConversationDraft {
  const requestSignature = JSON.stringify(
    canonical({
      text: draft.text.trim(),
      routing: routingIdentity(draft.routing),
      options,
    }),
  );
  return {
    ...draft,
    requestID:
      draft.requestSignature && draft.requestSignature !== requestSignature
        ? crypto.randomUUID()
        : draft.requestID,
    requestSignature,
  };
}

export function clearSubmittedDraft(
  drafts: Record<string, ConversationDraft>,
  key: string,
  requestID: string,
): Record<string, ConversationDraft> {
  if (drafts[key]?.requestID !== requestID) return drafts;
  return { ...drafts, [key]: createConversationDraft() };
}

export function createdConversationKey(routing: ConversationRouting, taskID: string): string {
  if (!taskID?.trim()) throw new Error('服务端没有返回已创建会话的标识，请保留草稿并重试确认。');
  const prefix =
    routing.kind === 'node' ? 'remote' : routing.kind === 'automatic' ? 'brain' : 'local';
  return `${prefix}:${taskID}`;
}

/** Retrying an already issued request can confirm its saved Task even if the model directory changed. */
export function conversationCreationNeedsModel(draft: ConversationDraft) {
  return draft.routing.kind === 'local' && !draft.requestSignature;
}
