import type { SearchMatch } from './conversation-search.ts';
import type { WorkspaceKeyEvent } from './workspace-commands.ts';

export function nextConversationFindMatch(
  matches: readonly SearchMatch[], activeID: string | null, direction: -1 | 1,
): SearchMatch | null {
  if (!matches.length) return null;
  const index = matches.findIndex((match) => match.id === activeID);
  return matches[index < 0 ? direction === 1 ? 0 : matches.length - 1 : (index + direction + matches.length) % matches.length];
}

export type ConversationFindShortcut = 'open' | 'next' | 'previous';
export function currentConversationFindShortcut(
  event: WorkspaceKeyEvent, context: { active: boolean; blocked?: boolean; composing?: boolean },
): ConversationFindShortcut | null {
  if (context.blocked || context.composing || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey) return null;
  if (event.key.toLowerCase() === 'f' && !!event.ctrlKey !== !!event.metaKey && !event.shiftKey) return 'open';
  if (event.key === 'F3' && context.active && !event.ctrlKey && !event.metaKey) return event.shiftKey ? 'previous' : 'next';
  return null;
}
