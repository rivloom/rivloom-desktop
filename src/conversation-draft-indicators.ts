import type { ConversationDraft } from './conversation-drafts.ts';

/** Attachments count even after interrupted uploads, so their recovery errors remain discoverable. */
export function hasConversationDraft(draft: ConversationDraft | null | undefined): boolean {
  return !!draft && (!!draft.text.trim() || !!draft.files?.length);
}

/** Caller supplies its visible, ordered conversations. Hidden/deleted keys never leak back into navigation. */
export function conversationDraftKeys(
  drafts: Readonly<Record<string, ConversationDraft | undefined>>,
  visibleKeys: Iterable<string>,
): string[] {
  return [...new Set(['new', ...visibleKeys])].filter((key) => hasConversationDraft(drafts[key]));
}
