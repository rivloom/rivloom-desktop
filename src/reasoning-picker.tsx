import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown } from 'lucide-react';
import type { AvailableModel } from '../shared/model-catalog.ts';
import { reasoningSupported, type ReasoningEffort } from '../shared/model-reasoning.ts';
import { language, t } from '../shared/i18n.ts';
import './reasoning-picker.css';

export function reasoningLabel(value: ReasoningEffort | undefined): string {
  const labels: Record<string, string> = {
    none: t('关闭思考'), minimal: t('极低'), low: t('低'), medium: t('中'), high: t('高'),
    xhigh: t('很高'), max: t('最高'), ultra: t('超高'), thinking: t('开启思考'),
  };
  return value == null ? t('自动（模型默认）') : labels[value] || value;
}
export function ReasoningPicker({ model, value, onChange, disabled = false }: {
  model: AvailableModel | undefined; value: ReasoningEffort | undefined;
  onChange: (value: ReasoningEffort) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ReasoningEffort>(value ?? null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const locale = language();
  const options = [...new Set(model?.reasoningEfforts || [])];
  const invalid = !reasoningSupported(model, value);
  const available = !!options.length || invalid;
  const showing = open && !disabled && available;
  const rows = [
    { value: null as ReasoningEffort, label: reasoningLabel(null), disabled: false },
    ...(invalid && !options.includes(value!)
      ? [{ value: value!, label: t('不可用：{{value}}', { value: reasoningLabel(value) }), disabled: true }]
      : []),
    ...options.map(option => ({ value: option, label: reasoningLabel(option), disabled: !reasoningSupported(model, option) })),
  ];
  const enabledRows = rows.filter(row => !row.disabled);
  const activeIndex = Math.max(0, rows.findIndex(row => row.value === active && !row.disabled));
  const optionSignature = JSON.stringify(options);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    if (disabled || !available) return;
    document.dispatchEvent(new Event('rivloom-menu-open'));
    setActive(invalid ? null : value ?? null);
    setOpen(true);
  }
  function choose(effort: ReasoningEffort) {
    if (disabled || !reasoningSupported(model, effort)) return;
    onChange(effort);
    close(true);
  }
  function move(direction: number) {
    const current = enabledRows.findIndex(row => row.value === rows[activeIndex].value);
    setActive(enabledRows[(current + direction + enabledRows.length) % enabledRows.length].value);
  }

  useEffect(() => {
    if (disabled || !available) setOpen(false);
  }, [disabled, available]);
  useLayoutEffect(() => {
    if (!showing || !list.current || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const element = list.current;
    const above = Math.max(0, bounds.top - viewportTop - 14);
    const below = Math.max(0, viewportTop + viewportHeight - bounds.bottom - 14);
    element.style.maxWidth = `${Math.max(0, viewportWidth - 16)}px`;
    element.style.maxHeight = '';
    const upwards = below < Math.min(360, element.scrollHeight) && above > below;
    element.style.maxHeight = `${Math.min(360, upwards ? above : below)}px`;
    const panel = element.getBoundingClientRect();
    element.style.left = `${Math.max(viewportLeft + 8, Math.min(bounds.right - panel.width, viewportLeft + viewportWidth - panel.width - 8))}px`;
    element.style.top = `${Math.max(viewportTop + 8, Math.min(upwards ? bounds.top - panel.height - 6 : bounds.bottom + 6, viewportTop + viewportHeight - panel.height - 8))}px`;
  }, [showing, optionSignature, invalid, value, locale]);
  useLayoutEffect(() => {
    if (showing) list.current?.focus({ preventScroll: true });
  }, [showing]);
  useLayoutEffect(() => {
    if (!showing || !list.current) return;
    const row = document.getElementById(`${id}-option-${activeIndex}`);
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    const panel = list.current.getBoundingClientRect();
    if (bounds.top < panel.top + 6) list.current.scrollTop -= panel.top + 6 - bounds.top;
    else if (bounds.bottom > panel.bottom - 6) list.current.scrollTop += bounds.bottom - panel.bottom + 6;
  }, [showing, activeIndex, id]);
  useEffect(() => {
    if (!showing) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('rivloom-menu-open', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.visualViewport?.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('scroll', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('rivloom-menu-open', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.visualViewport?.removeEventListener('resize', dismiss);
      window.visualViewport?.removeEventListener('scroll', dismiss);
    };
  }, [showing]);

  if (!options.length && !invalid) return null;
  return <>
    <button ref={trigger} type="button" className={`composer-select reasoning-picker${invalid ? ' needs-setup' : ''}`}
      aria-label={`${t('思考等级')}：${reasoningLabel(value)}`} aria-haspopup="listbox" aria-expanded={showing}
      aria-controls={showing ? `${id}-list` : undefined} disabled={disabled}
      title={t('自动使用模型与运行时的默认思考策略；不会切换模型。手动等级越高，通常耗时和用量越多。此设置只影响后续发送的消息。')}
      onClick={() => showing ? close() : show()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          show();
          if (event.key === 'Home') setActive(enabledRows[0].value);
          else if (event.key === 'End') setActive(enabledRows[enabledRows.length - 1].value);
        }
      }}>
      <Brain size={15} aria-hidden="true" />
      <span id={`${id}-value`}>{invalid ? t('不可用：{{value}}', { value: reasoningLabel(value) }) : value == null ? t('自动') : reasoningLabel(value)}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {showing && createPortal(<div ref={list} id={`${id}-list`} role="listbox" className="reasoning-picker-panel"
      tabIndex={-1} aria-label={t('思考等级')} aria-activedescendant={`${id}-option-${activeIndex}`}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Tab') { close(true); return; }
        if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') close(true);
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event.key === 'ArrowDown' ? 1 : -1);
        else if (event.key === 'Home') setActive(enabledRows[0].value);
        else if (event.key === 'End') setActive(enabledRows[enabledRows.length - 1].value);
        else choose(rows[activeIndex].value);
      }}>
      {rows.map((row, index) => <div key={row.value === null ? 'default' : `effort:${row.value}`} id={`${id}-option-${index}`} role="option"
        aria-selected={row.value === (value ?? null)} aria-disabled={row.disabled || undefined}
        className={`reasoning-picker-option${index === activeIndex ? ' active' : ''}`}
        onPointerMove={() => { if (!row.disabled) setActive(row.value); }}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (!row.disabled) choose(row.value); }}>
        <span>{row.label}</span>
        <span className="reasoning-picker-check">{row.value === (value ?? null) && <Check size={14} aria-hidden="true" />}</span>
      </div>)}
    </div>, document.body)}
  </>;
}
