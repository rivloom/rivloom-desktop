import { t } from '../shared/i18n.ts';
export type ConversationRouting =
  { kind: 'local' } | { kind: 'automatic' } | { kind: 'node'; nodeID: string; name: string };

export type ConversationDraft = {
  files?: import('./task-file-upload.ts').DraftTaskFile[];
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

/** Match textarea maxLength, including its UTF-16 length convention. Never modify the draft. */
export function conversationInputUsage(draft: ConversationDraft, existingConversation: boolean) {
  const limit = !existingConversation && draft.routing.kind !== 'local' ? 4000 : 12000;
  const length = draft.text.length;
  const remaining = limit - length;
  return {
    length,
    limit,
    remaining,
    nearLimit: length >= limit * 0.9,
    overLimit: remaining < 0,
  };
}

function routingIdentity(routing: ConversationRouting) {
  return routing.kind === 'node' ? `node:${routing.nodeID}` : routing.kind;
}

export function updateConversationDraft(
  draft: ConversationDraft,
  change: Partial<Pick<ConversationDraft, 'text' | 'routing' | 'files'>>,
  newRequestID: () => string = () => crypto.randomUUID(),
): ConversationDraft {
  const next = { ...draft, ...change };
  if (
    next.text.trim() === draft.text.trim() &&
    JSON.stringify((next.files || []).map((f) => f.id)) ===
      JSON.stringify((draft.files || []).map((f) => f.id)) &&
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
  if (!taskID?.trim()) throw new Error(t('服务端没有返回已创建会话的标识，请保留草稿并重试确认。'));
  const prefix =
    routing.kind === 'node' ? 'remote' : routing.kind === 'automatic' ? 'brain' : 'local';
  return `${prefix}:${taskID}`;
}

/** Retrying an already issued request can confirm its saved Task even if the model directory changed. */
export function conversationCreationNeedsModel(draft: ConversationDraft) {
  return draft.routing.kind === 'local' && !draft.requestSignature;
}
