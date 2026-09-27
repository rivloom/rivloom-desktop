import { useEffect, useRef, useState, type RefObject } from 'react';

const narrowQuery = '(max-width: 740px)';

/** The history drawer is modal on narrow windows; desktop history stays a normal sidebar. */
export function useSidebarDrawer(open: boolean, close: () => void, sidebar: RefObject<HTMLElement | null>, trigger: RefObject<HTMLButtonElement | null>) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const update = () => { setNarrow(media.matches); if (!media.matches) closeRef.current(); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!narrow || !open) return;
    const panel = sidebar.current;
    if (!panel) return;
    const controls = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const frame = requestAnimationFrame(() => {
      if (!panel.contains(document.activeElement))
        (panel.querySelector<HTMLElement>('[aria-current="page"]') || controls()[0])?.focus({ preventScroll: true });
    });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open], [role="menu"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first || !last) return;
      if (!panel.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', key);
      if (panel.contains(document.activeElement) || document.activeElement === document.body)
        trigger.current?.focus({ preventScroll: true });
    };
  }, [narrow, open, sidebar, trigger]);
  return narrow;
}
