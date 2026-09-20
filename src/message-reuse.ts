import { conversationInputUsage, type ConversationDraft } from './conversation-drafts.ts';

export type MessageReuseMode = 'reuse' | 'quote';
export type MessageReusePlacement = 'append' | 'replace';
export type MessageReuseIntent = {
  text: string;
  mode: MessageReuseMode;
  placement: MessageReusePlacement;
  expectedDraft: { text: string; requestID: string };
  replaceConfirmed?: boolean;
};
export type MessageReuseResult = { ok: true; draft: ConversationDraft; length: number; limit: number }
  | { ok: false; reason: 'empty-message' | 'draft-changed' | 'confirmation-required' | 'too-long'; length?: number; limit?: number };

export function reuseMessageText(text: string, mode: MessageReuseMode): string {
  return mode === 'quote' ? text.split(/\r\n|\r|\n/).map(line => `> ${line}`).join('\n') + '\n\n' : text;
}

/** Apply against the latest draft, not an earlier render. No history, routing or files are changed.
 * The caller must still explicitly submit the resulting draft through the normal send path.
 */
export function applyMessageReuse(draft: ConversationDraft, intent: MessageReuseIntent, existingConversation: boolean,
  newRequestID: () => string = () => crypto.randomUUID()): MessageReuseResult {
  if (draft.text !== intent.expectedDraft.text || draft.requestID !== intent.expectedDraft.requestID) return { ok: false, reason: 'draft-changed' };
  if (!intent.text.trim()) return { ok: false, reason: 'empty-message' };
  const value = reuseMessageText(intent.text, intent.mode);
  if (intent.placement === 'replace' && draft.text.length && !intent.replaceConfirmed) return { ok: false, reason: 'confirmation-required' };
  const text = intent.placement === 'append' && draft.text.length ? `${draft.text}\n\n${value}` : value;
  const usage = conversationInputUsage({ ...draft, text }, existingConversation);
  if (usage.overLimit) return { ok: false, reason: 'too-long', length: usage.length, limit: usage.limit };
  // An explicit reuse is new work even if the text happens to equal an already issued request.
  return { ok: true, draft: { ...draft, text, requestID: newRequestID(), requestSignature: undefined }, length: usage.length, limit: usage.limit };
}
