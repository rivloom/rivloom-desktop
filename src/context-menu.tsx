import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './context-menu.css';

export type MenuAction = { id: string; label: string; icon?: ReactNode; disabled?: boolean; hint?: string; danger?: boolean; select: () => void };
type Anchor = { x: number; y: number; target: HTMLElement };

export function useContextMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const id = useId();
  const close = useCallback((restore = false) => {
    if (restore && anchorRef.current?.target.isConnected) anchorRef.current.target.focus({ preventScroll: true });
    anchorRef.current = null; setAnchor(null);
  }, []);
  function show(target: HTMLElement, x?: number, y?: number) {
    document.dispatchEvent(new Event('rivloom-menu-open'));
    const rect = target.getBoundingClientRect();
    setAnchor({ target, x: x ?? rect.left, y: y ?? rect.bottom });
  }
  const context = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget.querySelector<HTMLElement>('button:not(:disabled), a[href]') || event.currentTarget;
    show(target, event.clientX || undefined, event.clientY || undefined);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault(); event.stopPropagation(); show(event.target as HTMLElement);
  };
  const trigger = { 'aria-haspopup': 'menu' as const, 'aria-expanded': !!anchor, 'aria-controls': anchor ? id : undefined,
    onClick: (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); if (anchor) close(true); else show(event.currentTarget); } };
  return { anchor, id, close, context, keyboard, trigger };
}

export function ContextMenu({ menu, label, actions }: { menu: ReturnType<typeof useContextMenu>; label: string; actions: MenuAction[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, close, id } = menu;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!anchor || !element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8))}px`;
    (element.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') || element).focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: Event) => { if (!ref.current?.contains(event.target as Node) && !(event.type === 'pointerdown' && anchor.target.contains(event.target as Node))) close(); };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('rivloom-menu-open', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', outside, true); document.removeEventListener('rivloom-menu-open', dismiss);
      window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss);
    };
  }, [anchor, close]);
  if (!anchor) return null;
  return createPortal(<div ref={ref} id={id} role="menu" aria-label={label} tabIndex={-1} className="context-menu"
    style={{ left: anchor.x, top: anchor.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={(event) => {
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') || [])];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
    }}>
    {actions.map((action) => <button key={action.id} type="button" role="menuitem" tabIndex={-1} aria-disabled={!!action.disabled}
      className={action.danger ? 'danger' : undefined} title={action.hint}
      onClick={() => { if (action.disabled) return; close(true); action.select(); }}>
      {action.icon}<span>{action.label}{action.hint && <small>{action.hint}</small>}</span>
    </button>)}
  </div>, document.body);
}
