import { t } from '../shared/i18n.ts';
import { primaryShortcut } from './keyboard-platform.ts';
import type { WorkspaceKeyEvent } from './workspace-commands.ts';

export type ComposerSendMode = 'enter' | 'ctrl-enter';
export function normalizeComposerSendMode(value: unknown): ComposerSendMode {
  return value === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
}

/** Call after mention handling. This decides intent; ordinary submit validation still applies. */
export function shouldSendComposer(
  event: WorkspaceKeyEvent,
  mode: ComposerSendMode,
  context: { composing?: boolean; mentionOpen?: boolean; disabled?: boolean } = {},
): boolean {
  if (context.composing || context.mentionOpen || context.disabled || event.defaultPrevented || event.repeat ||
    event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey && event.metaKey) return false;
  return mode === 'enter' || !!event.ctrlKey || !!event.metaKey;
}

export function composerSendHint(mode: ComposerSendMode): string {
  return mode === 'ctrl-enter' ? t('{{shortcut}} 发送 · Enter 换行', { shortcut: primaryShortcut('Enter') }) : t('Enter 发送 · Shift + Enter 换行');
}
