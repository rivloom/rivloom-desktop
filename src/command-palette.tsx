import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, FilePenLine, MessageSquare, Search, X } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { executeWorkspaceCommand, searchWorkspaceCommands, workspaceCommandKey, type WorkspaceCommand } from './workspace-commands.ts';
import './command-palette.css';

/** Mount to open. All commands are supplied by the workspace and only navigate existing UI. */
export function CommandPalette({ commands, owner, onClose }: {
  commands: readonly WorkspaceCommand[];
  owner: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const dismissed = useRef(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const id = useId();
  const matches = useMemo(() => searchWorkspaceCommands(commands, query, owner), [commands, query, owner]);
  const selectable = matches.filter((command) => !command.disabled);
  const active = selectable.find((command) => workspaceCommandKey(command) === activeKey) || selectable[0];
  const activeIndex = active ? matches.indexOf(active) : -1;

  useLayoutEffect(() => {
    const element = dialog.current!;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.dispatchEvent(new Event('rivloom-menu-open'));
    dismissed.current = false;
    element.showModal();
    input.current?.focus({ preventScroll: true });
    return () => {
      const restore = element.open && (element.contains(document.activeElement) || document.activeElement === document.body);
      if (element.open) element.close();
      if (restore && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, activeIndex, query]);

  function close(command?: WorkspaceCommand) {
    if (dismissed.current || command?.disabled) return;
    dismissed.current = true;
    dialog.current?.close();
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    onClose();
    if (command) executeWorkspaceCommand(command, owner);
  }
  function move(direction: -1 | 1) {
    if (!selectable.length) return;
    const index = active ? selectable.indexOf(active) : -1;
    setActiveKey(workspaceCommandKey(selectable[(index + direction + selectable.length) % selectable.length]));
  }

  return createPortal(<dialog ref={dialog} className="workspace-command-palette" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-hint`} onCancel={(event) => { event.preventDefault(); if (!composing.current) close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    } }}>
    <div className="command-palette-heading">
      <h2 id={`${id}-title`}>{t('快速访问')}</h2>
      <button type="button" className="icon-button" aria-label={t('关闭')} onClick={() => close()}><X size={18} /></button>
    </div>
    <div className="command-palette-search">
      <Search size={18} aria-hidden="true" />
      <input ref={input} role="combobox" aria-label={t('搜索操作、会话或草稿')} aria-expanded="true" aria-autocomplete="list"
        aria-controls={`${id}-list`} aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        value={query} maxLength={200} autoComplete="off" spellCheck={false} placeholder={t('搜索操作、会话或草稿…')}
        onChange={(event) => { setQuery(event.target.value); setActiveKey(null); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
          else if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat && active) close(active);
          } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }} />
    </div>
    <div className="command-palette-results" id={`${id}-list`} role="listbox" aria-label={t('快速访问结果')}>
      {matches.map((command, index) => <button type="button" role="option" tabIndex={-1} key={workspaceCommandKey(command)}
        id={`${id}-option-${index}`} aria-selected={command === active} aria-disabled={!!command.disabled}
        className={`command-palette-option${command === active ? ' active' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => { if (!command.disabled) setActiveKey(workspaceCommandKey(command)); }} onClick={() => close(command)}>
        {command.kind === 'draft' ? <FilePenLine size={18} aria-hidden="true" /> : command.kind === 'conversation' ? <MessageSquare size={18} aria-hidden="true" /> : <ArrowUpRight size={18} aria-hidden="true" />}
        <span className="command-palette-copy"><strong>{command.label}</strong>{command.detail && <small>{command.detail}</small>}</span>
        {command.kind === 'draft' && <span className="command-palette-badge">{t('草稿')}</span>}
        {command.shortcut && <kbd>{command.shortcut}</kbd>}
      </button>)}
      {!matches.length && <p className="command-palette-empty">{t('没有匹配的操作或会话')}</p>}
    </div>
    <div className="command-palette-footer">
      <span role="status" aria-live="polite">{t('{{count}} 项结果', { count: matches.length })}</span>
      <span id={`${id}-hint`}>{t('↑ ↓ 选择 · Enter 打开 · Esc 关闭')}</span>
    </div>
  </dialog>, document.body);
}
