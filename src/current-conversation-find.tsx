import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { SearchText, searchMatchLabel } from './conversation-search-view';
import { searchExcerpt, type SearchMatch } from './conversation-search.ts';
import { currentConversationFindShortcut, nextConversationFindMatch } from './current-conversation-find-keyboard.ts';
import { workspaceKeyboardOverlayOpen } from './use-workspace-shortcuts.ts';
import './current-conversation-find.css';

const focusEvent = 'rivloom-find-focus';
export function focusCurrentConversationFind() { document.dispatchEvent(new Event(focusEvent)); }
export type CurrentConversationFindProps = {
  query: string;
  onQuery: (query: string) => void;
  matches: readonly SearchMatch[];
  activeID: string | null;
  select: (match: SearchMatch) => void;
  close: () => void;
};

/** Receives the current conversation's existing index only; never searches or fetches other sessions. */
export function CurrentConversationFind({ query, onQuery, matches, activeID, select, close }: CurrentConversationFindProps) {
  const input = useRef<HTMLInputElement>(null);
  const region = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const capturedOpener = useRef(false);
  const composing = useRef(false);
  const id = useId();
  const index = matches.findIndex((match) => match.id === activeID);
  const current = matches[index];
  useLayoutEffect(() => {
    if (!capturedOpener.current) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      capturedOpener.current = true;
    }
    const focus = () => { input.current?.focus({ preventScroll: true }); input.current?.select(); };
    focus();
    document.addEventListener(focusEvent, focus);
    return () => { document.removeEventListener(focusEvent, focus); };
  }, []);
  function dismiss() {
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    close();
  }
  function navigate(direction: -1 | 1) {
    const match = nextConversationFindMatch(matches, activeID, direction);
    if (match) select(match);
  }
  return <section ref={region} role="search" className="current-conversation-find" aria-label={t('在当前会话中查找')}
    onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    }}>
    <div className="conversation-find-bar">
      <Search size={16} aria-hidden="true" />
      <input ref={input} type="search" value={query} maxLength={200} aria-label={t('在当前会话中查找')}
        aria-describedby={`${id}-status`} placeholder={t('搜索当前会话内容…')} autoComplete="off" spellCheck={false}
        onChange={(event) => onQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1);
          }
        }} />
      <span className="conversation-find-count" id={`${id}-status`} role="status" aria-live="polite">
        {query.trim() ? t('{{current}} / {{total}} 个匹配片段', { current: index + 1, total: matches.length }) : t('输入文字搜索当前会话')}
      </span>
      <div className="conversation-find-actions">
        <button type="button" className="icon-button" aria-label={t('上一处匹配')} title={t('上一处匹配')} disabled={!matches.length} onClick={() => navigate(-1)}><ChevronUp size={16} /></button>
        <button type="button" className="icon-button" aria-label={t('下一处匹配')} title={t('下一处匹配')} disabled={!matches.length} onClick={() => navigate(1)}><ChevronDown size={16} /></button>
        <button type="button" className="icon-button" aria-label={t('退出匹配定位')} title={t('退出匹配定位')} onClick={dismiss}><X size={16} /></button>
      </div>
    </div>
    {current ? <p className="conversation-find-preview"><small>{searchMatchLabel(current)}</small><SearchText text={searchExcerpt(current, 60)} query={query} /></p>
      : query.trim() && !matches.length ? <p className="conversation-find-preview">{t('当前会话没有匹配内容')}</p> : null}
  </section>;
}

export function useCurrentConversationFindShortcuts(options: {
  open: () => void;
  active: boolean;
  matches: readonly SearchMatch[];
  activeID: string | null;
  select: (match: SearchMatch) => void;
  enabled?: boolean;
  blocked?: boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    let composing = false;
    const begin = () => { composing = true; };
    const end = () => { composing = false; };
    const key = (event: KeyboardEvent) => {
      const current = latest.current;
      if (current.enabled === false) return;
      const shortcut = currentConversationFindShortcut(event, { active: current.active, composing,
        blocked: current.blocked || workspaceKeyboardOverlayOpen() });
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === 'open') {
        current.open();
        focusCurrentConversationFind();
      } else {
        const match = nextConversationFindMatch(current.matches, current.activeID, shortcut === 'previous' ? -1 : 1);
        if (match) current.select(match);
      }
    };
    document.addEventListener('keydown', key);
    document.addEventListener('compositionstart', begin);
    document.addEventListener('compositionend', end);
    window.addEventListener('blur', end);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('compositionstart', begin);
      document.removeEventListener('compositionend', end);
      window.removeEventListener('blur', end);
    };
  }, []);
}
