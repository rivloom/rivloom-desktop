export type ConversationPreference = { title?: string; pinned?: boolean };
export type ConversationPreferences = Record<string, ConversationPreference>;
export const maximumConversationTitleLength = 160;
export function validConversationKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^(local|remote|brain|workflow):[a-zA-Z0-9_-]+$/.test(value);
}
export function validConversationTitle(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maximumConversationTitleLength && !/[\u0000-\u001f\u007f]/.test(value);
}
