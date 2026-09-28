import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Reveal only clipped titles, outside the list so nearby rows remain readable. */
export function useHistoryTitleHint(title: string) {
  const titleRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = useId();
  const cancel = () => clearTimeout(timer.current);
  const hide = () => { cancel(); setAnchor(null); };
  const leave = () => { cancel(); timer.current = setTimeout(() => setAnchor(null), 120); };
  const show = (button: HTMLButtonElement) => {
    cancel();
    const text = titleRef.current;
    setAnchor(text && text.scrollWidth > text.clientWidth + 1 ? button.getBoundingClientRect() : null);
  };

  useLayoutEffect(() => {
    const hint = hintRef.current;
    if (!anchor || !hint) return;
    const { width, height } = hint.getBoundingClientRect();
    const right = anchor.right + 8;
    hint.style.left = `${Math.max(8, Math.min(right, window.innerWidth - width - 8))}px`;
    hint.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`;
  }, [anchor, title]);

  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => setAnchor(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('rivloom-menu-open', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('rivloom-menu-open', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [anchor]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    titleRef,
    trigger: {
      'aria-describedby': anchor ? id : undefined,
      onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => { if (event.pointerType !== 'touch') show(event.currentTarget); },
      onPointerLeave: leave,
      onFocus: (event: React.FocusEvent<HTMLButtonElement>) => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget); },
      onBlur: hide,
      onPointerDown: hide,
    },
    hint: anchor && createPortal(<div ref={hintRef} id={id} role="tooltip" className="history-title-hint history-graphite"
      style={{ left: anchor.right + 8, top: anchor.top }} onPointerEnter={cancel} onPointerLeave={leave}>{title}</div>, document.body),
  };
}
