import { useEffect, useId, useRef, useState } from 'react';
import { ListFilter, X } from 'lucide-react';
import { t } from '../shared/i18n';
import type { ConversationSourceFilter, ConversationStatusFilter } from './conversation-filters';

export function ConversationFilterButton({
  status,
  source,
  filtering,
  onStatusChange,
  onSourceChange,
  onClear,
}: {
  status: ConversationStatusFilter;
  source: ConversationSourceFilter;
  filtering: boolean;
  onStatusChange: (value: ConversationStatusFilter) => void;
  onSourceChange: (value: ConversationSourceFilter) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstSelect = useRef<HTMLSelectElement>(null);
  const count = Number(status !== 'all') + Number(source !== 'all');
  const label = count ? t('筛选会话，已启用 {{count}} 项', { count }) : t('筛选会话');

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    firstSelect.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div
      className="history-filter-control"
      ref={container}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`history-filter-toggle${count ? ' active' : ''}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ListFilter size={16} />
        {count > 0 && (
          <span className="history-filter-count" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          className="history-filter-popover"
          id={id}
          role="dialog"
          aria-labelledby={`${id}-title`}
        >
          <div className="history-filter-heading">
            <strong id={`${id}-title`}>{t('筛选会话')}</strong>
            <button type="button" aria-label={t('关闭')} onClick={close}>
              <X size={14} />
            </button>
          </div>
          <div className="history-filters">
            <label>
              <span>{t('状态')}</span>
              <select
                ref={firstSelect}
                aria-label={t('筛选会话状态')}
                value={status}
                onChange={(event) => onStatusChange(event.target.value as ConversationStatusFilter)}
              >
                <option value="all">{t('全部状态')}</option>
                <option value="active">{t('进行中')}</option>
                <option value="attention">{t('待处理')}</option>
                <option value="completed">{t('已完成')}</option>
                <option value="ended">{t('已停止或失败')}</option>
              </select>
            </label>
            <label>
              <span>{t('来源')}</span>
              <select
                aria-label={t('筛选会话来源')}
                value={source}
                onChange={(event) => onSourceChange(event.target.value as ConversationSourceFilter)}
              >
                <option value="all">{t('全部来源')}</option>
                <option value="own">{t('自己发起')}</option>
                <option value="incoming">{t('其他设备发来')}</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className="history-filter-reset"
            disabled={!filtering}
            onClick={() => {
              onClear();
              firstSelect.current?.focus({ preventScroll: true });
            }}
          >
            {t('清除筛选')}
          </button>
        </div>
      )}
    </div>
  );
}
