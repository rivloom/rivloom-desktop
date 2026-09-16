import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, ChevronRight, Network, Search } from 'lucide-react';
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const locale = language();
  const groups = useMemo(() => groupModels(models, query, locale), [models, query, locale]);
  const isExpanded = (groupID: string) => !!query.trim() || expanded.has(groupID);
  const rows = groups.flatMap((group) => [
    { key: `@${group.id}`, group, model: undefined as AvailableModel | undefined },
    ...(isExpanded(group.id) ? group.models.map((model) => ({ key: model.id, group, model })) : []),
  ]);
  const activeIndex = Math.max(
    0,
    active ? rows.findIndex((row) => row.key === active) : rows.findIndex((row) => row.model),
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
    setExpanded(
      new Set([
        modelDetails(models.find((m) => m.id === value) || models[0] || { id: '', name: '' })
          .providerID,
      ]),
    );
    setOpen(true);
  }
  function choose(model: AvailableModel) {
    onChange(model.id);
    close(true);
  }
  function toggle(groupID: string) {
    if (query.trim()) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(groupID)) next.delete(groupID);
      else next.add(groupID);
      return next;
    });
    setActive(`@${groupID}`);
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!showing || !models.length) return;
    setExpanded((previous) =>
      previous.size && !models.some((m) => previous.has(modelDetails(m).providerID))
        ? new Set([modelDetails(models.find((m) => m.id === value) || models[0]).providerID])
        : previous,
    );
  }, [models, showing, value]);
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
  }, [showing, groups, expanded]);
  useLayoutEffect(() => {
    if (showing) search.current?.focus({ preventScroll: true });
  }, [showing]);
  useLayoutEffect(() => {
    if (showing)
      document.getElementById(`${id}-row-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [showing, activeIndex, id, query, expanded]);
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

  let rowIndex = 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="composer-select model-picker-trigger"
        aria-label={t('执行模型')}
        aria-haspopup="tree"
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
              } else if (event.target !== search.current) return;
              else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next =
                  (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
                if (rows[next]) setActive(rows[next].key);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                if (query.trim() || !rows[activeIndex]) return;
                event.preventDefault();
                const row = rows[activeIndex];
                if (event.key === 'ArrowLeft') {
                  if (row.model) setActive(`@${row.group.id}`);
                  else if (isExpanded(row.group.id)) toggle(row.group.id);
                } else if (!row.model) {
                  if (!isExpanded(row.group.id)) toggle(row.group.id);
                  else if (row.group.models[0]) setActive(row.group.models[0].id);
                }
              } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                const row = rows[activeIndex];
                if (row?.model) choose(row.model);
                else if (row) toggle(row.group.id);
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
                aria-haspopup="tree"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={rows.length ? `${id}-row-${activeIndex}` : undefined}
                value={query}
                placeholder={t('搜索模型、厂商或账号…')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive('');
                }}
              />
            </div>
            <div className="model-picker-toolbar">
              <span>{t('按服务商和账号分组')}</span>
              <button
                type="button"
                disabled={!groups.length || !!query.trim()}
                onClick={() => {
                  const all = groups.every((g) => expanded.has(g.id));
                  setExpanded(all ? new Set() : new Set(groups.map((g) => g.id)));
                  setActive(`@${groups[0]?.id}`);
                  search.current?.focus({ preventScroll: true });
                }}
              >
                {groups.length && groups.every((g) => expanded.has(g.id))
                  ? t('收起全部')
                  : t('展开全部')}
              </button>
            </div>
            <div
              id={`${id}-list`}
              role="tree"
              aria-label={t('执行模型')}
              className="model-picker-list"
            >
              {groups.map((group, groupIndex) => {
                const headerIndex = rowIndex++;
                const expandedGroup = isExpanded(group.id);
                return (
                  <div
                    key={group.id}
                    role="treeitem"
                    aria-expanded={expandedGroup}
                    aria-level={1}
                    className="model-picker-section"
                    id={`${id}-row-${headerIndex}`}
                    aria-labelledby={`${id}-group-${groupIndex}`}
                  >
                    <div
                      className={`model-picker-group${headerIndex === activeIndex ? ' active' : ''}`}
                      title={group.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggle(group.id)}
                    >
                      {expandedGroup ? (
                        <ChevronDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} aria-hidden="true" />
                      )}
                      <Network size={14} aria-hidden="true" />
                      <span className="model-picker-group-label" id={`${id}-group-${groupIndex}`}>
                        <strong>{group.name || t('其他模型')}</strong>
                        {group.accountName && <small>{group.accountName}</small>}
                      </span>
                      {group.models.some((model) => model.id === value) && (
                        <Check
                          size={13}
                          className="model-picker-group-selected"
                          aria-label={t('当前选择')}
                        />
                      )}
                      <span
                        className="model-picker-group-count"
                        aria-label={t('{{count}} 个模型', { count: group.models.length })}
                      >
                        {group.models.length}
                      </span>
                    </div>
                    {expandedGroup && (
                      <div role="group" className="model-picker-group-models">
                        {group.models.map((model) => {
                          const index = rowIndex++;
                          const context = formatContextWindow(model.contextWindow);
                          return (
                            <div
                              key={model.id}
                              id={`${id}-row-${index}`}
                              role="treeitem"
                              aria-level={2}
                              data-model-id={model.id}
                              aria-selected={model.id === value}
                              className={`model-picker-option${index === activeIndex ? ' active' : ''}`}
                              title={model.id}
                              onPointerMove={() => setActive(model.id)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => choose(model)}
                            >
                              <span className="model-picker-name">
                                {modelDetails(model).modelName}
                              </span>
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
                    )}
                  </div>
                );
              })}
            </div>
            {!groups.length && (
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
