import type { ReasoningEffort } from '../shared/model-reasoning.ts';
import { t } from '../shared/i18n.ts';
import type { WorkflowTarget } from '../shared/workflows.ts';
import type { Task } from '../shared/types.ts';
export type ConversationRouting =
  { kind: 'local' } | { kind: 'automatic' } | { kind: 'node'; nodeID: string; name: string } |
  { kind: 'workflow'; target: WorkflowTarget; name?: string };

export type ConversationDraft = {
  files?: import('./task-file-upload.ts').DraftTaskFile[];
  text: string;
  routing: ConversationRouting;
  requestID: string;
  /** Undefined marks an older draft; null follows the conversation's default model policy. */
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  /** Normalized creation options captured when this logical request is first sent. */
  requestSignature?: string;
};

export function createConversationDraft(
  requestID: string = crypto.randomUUID(),
): ConversationDraft {
  return { text: '', routing: { kind: 'local' }, requestID };
}
export function createWorkflowDraft(requestID: string = crypto.randomUUID()): ConversationDraft {
  return { text: '', routing: { kind: 'workflow', target: { mode: 'automatic' } }, requestID };
}

/** Seed once. Live task updates must never replace an unsent choice or rotate its retry ID. */
export function initializeConversationDraftModel(
  draft: ConversationDraft,
  model: string | null,
  reasoningEffort?: ReasoningEffort,
): ConversationDraft {
  const next = draft.model === undefined ? { ...draft, model } : draft;
  return next.reasoningEffort === undefined ? { ...next, reasoningEffort: next.model === model ? reasoningEffort ?? null : null } : next;
}

/** Collaboration and remote-origin tasks are controlled by their existing execution protocol. */
export function localTaskCanContinue(
  task: Pick<Task, 'assigneeID' | 'state' | 'collaboration' | 'remoteOrigin'> | undefined,
  userID: string,
): boolean {
  return !!task && task.assigneeID === userID && !task.collaboration && !task.remoteOrigin &&
    ['ready', 'stopped', 'failed', 'review', 'accepted'].includes(task.state);
}

/** A lost response may arrive after live bootstrap already reports the task as running. */
export function isPendingLocalTaskMessage(draft: ConversationDraft): boolean {
  try {
    return JSON.parse(draft.requestSignature || 'null')?.options?.messageKind === 'local-task';
  } catch {
    return false;
  }
}

/** Keep pre-upgrade HTTP retries byte-for-byte compatible; editing rotates the request ID. */
export function conversationReasoningFields(draft: ConversationDraft, reasoningEffort: ReasoningEffort) {
  if (reasoningEffort === null && draft.requestSignature) {
    try {
      const options = JSON.parse(draft.requestSignature)?.options;
      if (options && !Object.hasOwn(options, 'reasoningEffort')) return {};
    } catch { /* A malformed signature is rebuilt by prepareConversationRequest. */ }
  }
  return { reasoningEffort };
}

/** Match textarea maxLength, including its UTF-16 length convention. Never modify the draft. */
export function conversationInputUsage(draft: ConversationDraft, existingConversation: boolean) {
  const limit = !existingConversation && draft.routing.kind !== 'local' && draft.routing.kind !== 'workflow' ? 4000 : 12000;
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
  if (routing.kind === 'workflow') return routing.target.mode === 'automatic' ? 'workflow:automatic' :
    `workflow:${routing.target.mode}:${routing.target.nodeID}`;
  return routing.kind === 'node' ? `node:${routing.nodeID}` : routing.kind;
}

export function updateConversationDraft(
  draft: ConversationDraft,
  change: Partial<Pick<ConversationDraft, 'text' | 'routing' | 'files' | 'model' | 'reasoningEffort'>>,
  newRequestID: () => string = () => crypto.randomUUID(),
): ConversationDraft {
  const next = { ...draft, ...change, ...(change.model !== undefined && change.model !== draft.model && change.reasoningEffort === undefined ? { reasoningEffort: null } : {}) };
  if (
    next.text.trim() === draft.text.trim() &&
    next.model === draft.model && next.reasoningEffort === draft.reasoningEffort &&
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
  factory: () => ConversationDraft = createConversationDraft,
): Record<string, ConversationDraft> {
  if (drafts[key]?.requestID !== requestID) return drafts;
  const model = drafts[key].model;
  return { ...drafts, [key]: { ...factory(), ...(model !== undefined ? { model } : {}),
    ...(drafts[key].reasoningEffort !== undefined ? { reasoningEffort: drafts[key].reasoningEffort } : {}) } };
}

export function createdConversationKey(routing: ConversationRouting, taskID: string): string {
  if (!taskID?.trim()) throw new Error(t('服务端没有返回已创建会话的标识，请保留草稿并重试确认。'));
  const prefix =
    routing.kind === 'workflow' ? 'workflow' : routing.kind === 'node' ? 'remote' : routing.kind === 'automatic' ? 'brain' : 'local';
  return `${prefix}:${taskID}`;
}

/** Retrying an already issued request can confirm its saved Task even if the model directory changed. */
export function conversationCreationNeedsModel(draft: ConversationDraft) {
  return draft.routing.kind === 'local' && !draft.requestSignature;
}
