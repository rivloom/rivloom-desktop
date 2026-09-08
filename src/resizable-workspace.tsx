import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { t } from '../shared/i18n.ts';
import {
  defaultSidebarWidths,
  resizeSidebar,
  sidebarBounds,
  sidebarLayout,
  type SidebarSide,
  type SidebarWidths,
} from '../shared/sidebar-layout.ts';
import { api } from './api';

type Drag = {
  side: SidebarSide;
  pointerID: number;
  startX: number;
  viewportWidth: number;
  original: SidebarWidths;
  layout: ReturnType<typeof sidebarLayout>;
  handle: HTMLDivElement;
};

// Keep drag updates here so the conversation tree does not render on every pointer move.
export function ResizableWorkspace({
  hasNetwork,
  sidebarOpen,
  children,
}: {
  hasNetwork: boolean;
  sidebarOpen: boolean;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  const [saved, setSaved] = useState<SidebarWidths>(defaultSidebarWidths);
  const [resizing, setResizing] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const drag = useRef<Drag | null>(null);
  const touched = useRef(false);
  const revision = useRef(0);
  const writes = useRef(Promise.resolve());
  const layout = sidebarLayout(width, hasNetwork, saved);

  useEffect(() => {
    let active = true;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current!);
    void api<SidebarWidths>('/ui/sidebar-widths')
      .then((value) => {
        if (active && !touched.current) setSaved(value);
      })
      .catch(() => {
        /* The default layout remains usable when preferences cannot be read. */
      });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  function persist(next: SidebarWidths) {
    touched.current = true;
    setSaved(next);
    setSaveError(false);
    const currentRevision = ++revision.current;
    // Serialize releases so a slower earlier write cannot overwrite the latest width.
    writes.current = writes.current.then(async () => {
      try {
        await api('/ui/sidebar-widths', next, { timeoutMilliseconds: 5000 });
        if (currentRevision === revision.current) setSaveError(false);
      } catch {
        if (currentRevision === revision.current) setSaveError(true);
      }
    });
  }

  function release() {
    const current = drag.current;
    drag.current = null;
    setResizing(false);
    if (current?.handle.hasPointerCapture(current.pointerID))
      current.handle.releasePointerCapture(current.pointerID);
  }

  function cancel() {
    if (drag.current) setSaved(drag.current.original);
    release();
  }

  useEffect(() => {
    // A viewport transition or removal of the paired rail must not leave drag capture active.
    if (drag.current) cancel();
  }, [width, hasNetwork]);

  function moveWidth(current: Drag, clientX: number) {
    const delta = (clientX - current.startX) * (current.side === 'history' ? 1 : -1);
    return resizeSidebar(
      current.layout,
      current.original,
      current.side,
      current.layout[current.side] + delta,
    );
  }

  function start(event: PointerEvent<HTMLDivElement>, side: SidebarSide) {
    if (event.button !== 0 || drag.current || width <= 740) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    touched.current = true;
    drag.current = {
      side,
      pointerID: event.pointerId,
      startX: event.clientX,
      viewportWidth: container.current!.clientWidth,
      original: saved,
      layout,
      handle: event.currentTarget,
    };
    setResizing(true);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointerID !== event.pointerId) return;
    if (container.current?.clientWidth !== current.viewportWidth) {
      cancel();
      return;
    }
    setSaved(moveWidth(current, event.clientX));
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.pointerID !== event.pointerId) return;
    // Pointer release can arrive before ResizeObserver reports a window size change.
    if (container.current?.clientWidth !== current.viewportWidth) {
      cancel();
      return;
    }
    const next = moveWidth(current, event.clientX);
    release();
    if (next[current.side] === current.layout[current.side]) setSaved(current.original);
    else persist(next);
  }

  function reset(side: SidebarSide) {
    if (drag.current) cancel();
    persist({ ...saved, [side]: null });
  }

  function key(event: KeyboardEvent<HTMLDivElement>, side: SidebarSide) {
    if (event.key === 'Escape') {
      if (drag.current) {
        event.preventDefault();
        cancel();
      }
      return;
    }
    if (drag.current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      reset(side);
      return;
    }
    const step = event.shiftKey ? 40 : 10;
    const direction = side === 'history' ? 1 : -1;
    const next =
      event.key === 'Home'
        ? sidebarBounds[side].min
        : event.key === 'End'
          ? layout[`${side}Max`]
          : event.key === 'ArrowLeft'
            ? layout[side] - step * direction
            : event.key === 'ArrowRight'
              ? layout[side] + step * direction
              : null;
    if (next === null) return;
    event.preventDefault();
    persist(resizeSidebar(layout, saved, side, next));
  }

  function handle(side: SidebarSide) {
    return (
      <div
        className={`sidebar-resize-handle ${side}`}
        role="separator"
        tabIndex={0}
        aria-label={side === 'history' ? t('调整历史会话栏宽度') : t('调整配对机器栏宽度')}
        aria-controls={
          side === 'history' ? 'conversation-history-sidebar' : 'conversation-network-sidebar'
        }
        aria-orientation="vertical"
        aria-valuemin={sidebarBounds[side].min}
        aria-valuemax={layout[`${side}Max`]}
        aria-valuenow={layout[side]}
        aria-valuetext={t('{{width}} 像素', { width: layout[side] })}
        title={t('拖动调整宽度；双击或按 Enter 恢复默认')}
        onPointerDown={(event) => start(event, side)}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (drag.current?.side === side) cancel();
        }}
        onDoubleClick={() => reset(side)}
        onKeyDown={(event) => key(event, side)}
      />
    );
  }

  return (
    <div
      ref={container}
      className={`conversation-shell ${hasNetwork ? 'with-network' : ''} ${sidebarOpen ? 'sidebar-open' : ''} ${resizing ? 'is-resizing' : ''}`}
      style={
        {
          '--history-width': `${layout.history}px`,
          '--network-width': `${layout.network}px`,
          '--workspace-center-min': `${layout.minimumCenter}px`,
        } as CSSProperties
      }
    >
      {children}
      {handle('history')}
      {hasNetwork && handle('network')}
      {saveError && (
        <div className="workspace-layout-error" role="status">
          {t('侧栏宽度暂未保存')}
          <button type="button" onClick={() => persist(saved)}>
            {t('重试')}
          </button>
        </div>
      )}
    </div>
  );
}
