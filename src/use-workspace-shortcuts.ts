import { useEffect, useRef } from 'react';
import { workspaceShortcutForEvent, type WorkspaceShortcut } from './workspace-commands.ts';

export type WorkspaceShortcutOptions = {
  openPalette: () => void;
  newConversation: () => void;
  searchConversations: () => void;
  focusComposer: () => void;
  enabled?: boolean;
  blocked?: boolean;
};

export function workspaceKeyboardOverlayOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="menu"], .model-picker-panel')]
    .some((element) => !element.hidden && element.getClientRects().length > 0);
}

export function useWorkspaceShortcuts(options: WorkspaceShortcutOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    let composing = false;
    const beginComposition = () => { composing = true; };
    const endComposition = () => { composing = false; };
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (current.enabled === false) return;
      const modal = workspaceKeyboardOverlayOpen();
      const shortcut = workspaceShortcutForEvent(event, { blocked: current.blocked || modal, composing });
      if (!shortcut) return;
      const handlers: Record<WorkspaceShortcut, () => void> = {
        palette: current.openPalette,
        'new-conversation': current.newConversation,
        'search-conversations': current.searchConversations,
        'focus-composer': current.focusComposer,
      };
      event.preventDefault();
      handlers[shortcut]();
    };
    // Bubble after local controls, so a nested control can consume its own key first.
    document.addEventListener('keydown', onKey);
    document.addEventListener('compositionstart', beginComposition);
    document.addEventListener('compositionend', endComposition);
    window.addEventListener('blur', endComposition);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('compositionstart', beginComposition);
      document.removeEventListener('compositionend', endComposition);
      window.removeEventListener('blur', endComposition);
    };
  }, []);
}
