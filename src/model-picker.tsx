import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, Network, Search } from 'lucide-react';
import type { AvailableModel } from '../shared/model-catalog.ts';
import { language, t } from '../shared/i18n.ts';
import { formatContextWindow, groupModels, modelDetails } from './model-options.ts';
import './model-picker.css';

export function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
}: {
  models: AvailableModel[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(value);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const locale = language();
  const groups = useMemo(() => groupModels(models, query, locale), [models, query, locale]);
  const options = groups.flatMap((group) => group.models);
  const activeIndex = Math.max(
    0,
    options.findIndex((model) => model.id === active),
  );
  const selected = models.find((model) => model.id === value);
  const showing = open && !disabled;

  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    document.dispatchEvent(new Event('rivloom-menu-open'));
    setQuery('');
    setActive(value);
    setOpen(true);
  }
  function choose(model: AvailableModel) {
    onChange(model.id);
    close(true);
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!showing || !panel.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const above = rect.top - 16;
    const below = window.innerHeight - rect.bottom - 16;
    const upwards = below < 360 && above > below;
    const element = panel.current;
    element.style.maxHeight = `${Math.max(0, Math.min(460, upwards ? above : below))}px`;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, upwards ? rect.top - bounds.height - 6 : rect.bottom + 6)}px`;
  }, [showing, groups]);
  useLayoutEffect(() => {
    if (showing) search.current?.focus({ preventScroll: true });
  }, [showing]);
  useLayoutEffect(() => {
    if (showing)
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [showing, activeIndex, id, query]);
  useEffect(() => {
    if (!showing) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('rivloom-menu-open', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('rivloom-menu-open', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [showing]);

  let optionIndex = 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="composer-select model-picker-trigger"
        aria-label={t('执行模型')}
        aria-haspopup="listbox"
        aria-expanded={showing}
        aria-controls={showing ? `${id}-list` : undefined}
        disabled={disabled}
        title={selected ? `${selected.name}\n${selected.id}` : t('尚未连接模型')}
        onClick={() => (showing ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!showing) show();
          }
        }}
      >
        <Bot size={15} aria-hidden="true" />
        <span>{selected?.name || (models.length ? t('选择模型') : t('尚未连接模型'))}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {showing &&
        createPortal(
          <div
            ref={panel}
            className="model-picker-panel"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === 'Tab') close(true);
              else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next =
                  (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                  options.length;
                if (options[next]) setActive(options[next].id);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (options[activeIndex]) choose(options[activeIndex]);
              }
            }}
          >
            <div className="model-picker-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={search}
                role="combobox"
                aria-label={t('搜索模型')}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={options.length ? `${id}-option-${activeIndex}` : undefined}
                value={query}
                placeholder={t('搜索模型或厂商…')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive('');
                }}
              />
            </div>
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label={t('执行模型')}
              className="model-picker-list"
            >
              {groups.map((group, groupIndex) => (
                <div key={group.id} role="group" aria-labelledby={`${id}-group-${groupIndex}`}>
                  <div
                    className="model-picker-group"
                    id={`${id}-group-${groupIndex}`}
                    title={group.id}
                  >
                    <Network size={12} aria-hidden="true" />
                    <span>{group.name || t('其他模型')}</span>
                  </div>
                  {group.models.map((model) => {
                    const index = optionIndex++;
                    const context = formatContextWindow(model.contextWindow);
                    return (
                      <div
                        key={model.id}
                        id={`${id}-option-${index}`}
                        role="option"
                        aria-selected={model.id === value}
                        className={`model-picker-option${index === activeIndex ? ' active' : ''}`}
                        title={model.id}
                        onPointerMove={() => setActive(model.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(model)}
                      >
                        <span className="model-picker-name">{modelDetails(model).modelName}</span>
                        <span className="model-picker-badges">
                          {context && (
                            <span
                              className="model-picker-badge"
                              title={t('上下文：{{count}} Token', {
                                count: model.contextWindow!.toLocaleString(locale),
                              })}
                            >
                              {context}
                            </span>
                          )}
                          {model.supportsImages === true && (
                            <span className="model-picker-badge" title={t('支持图片输入')}>
                              {t('图片')}
                            </span>
                          )}
                        </span>
                        <span className="model-picker-check">
                          {model.id === value && <Check size={14} aria-hidden="true" />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {!options.length && (
              <p className="model-picker-empty" role="status">
                {models.length ? t('没有匹配的模型') : t('尚未连接模型')}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
