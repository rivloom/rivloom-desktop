import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Bot, Check, ChevronDown, ChevronRight, Network, Search } from 'lucide-react';
import type { AvailableModel } from '../shared/model-catalog.ts';
import { language, t } from '../shared/i18n.ts';
import { formatContextWindow, groupModels, modelDetails } from './model-options.ts';
import { modelReadinessIssue, type ModelReadinessIssue } from './model-onboarding.ts';
import './model-picker.css';

export function modelReadinessMessage(issue: ModelReadinessIssue, owner: boolean) {
  if (issue === 'engine') return {
    title: t('模型服务尚未就绪'),
    description: t('请稍后重试，或查看连接诊断。已输入的内容会保留。'),
  };
  if (issue === 'selection') return {
    title: t('请选择一个可用模型'),
    description: t('当前选择未出现在可用模型列表中，请重新选择；也可检查原账号配置。'),
  };
  return {
    title: t('本机暂无可选模型'),
    description: owner
      ? t('添加一个模型账号，或检查已有账号配置，即可在这里选择模型。')
      : t('请联系工作区创建者添加或检查模型账号。你的草稿会保留。'),
  };
}

export function ModelPicker({
  models,
  value,
  onChange,
  disabled = false,
  engineReady = true,
  engineError = null,
  owner = false,
  onSetup,
}: {
  models: AvailableModel[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  engineReady?: boolean;
  engineError?: string | null;
  owner?: boolean;
  onSetup?: (issue: ModelReadinessIssue) => void;
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
  const issue = modelReadinessIssue({ ready: engineReady, error: engineError, models }, value);
  const guidance = issue ? modelReadinessMessage(issue, owner) : null;
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
  }, [showing, groups, expanded, issue, locale]);
  useLayoutEffect(() => {
    if (showing) (search.current || panel.current?.querySelector<HTMLButtonElement>('button') || panel.current)?.focus({ preventScroll: true });
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
        className={`composer-select model-picker-trigger${issue ? ' needs-setup' : ''}`}
        aria-label={guidance ? t('执行模型：{{status}}', { status: guidance.title }) : t('执行模型')}
        aria-haspopup="tree"
        aria-expanded={showing}
        aria-controls={showing ? `${id}-list` : undefined}
        disabled={disabled}
        title={guidance ? `${guidance.title}\n${guidance.description}` : selected ? `${selected.name}\n${selected.id}` : t('选择模型')}
        onClick={() => (showing ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!showing) show();
          }
        }}
      >
        {issue ? <AlertCircle size={15} className="model-picker-warning" aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
        <span>{selected?.name || (issue === 'engine' ? t('模型服务尚未就绪') : models.length ? t('选择模型') : owner ? t('添加模型') : t('暂无可选模型'))}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {showing &&
        createPortal(
          <div
            ref={panel}
            className="model-picker-panel"
            tabIndex={-1}
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
            {guidance && issue && <div className="model-picker-notice" role="status">
              <strong>{guidance.title}</strong>
              <p>{guidance.description}</p>
              {onSetup && <button type="button" className="button" onClick={() => { close(); onSetup(issue); }}>
                {issue === 'engine' ? t('连接诊断') : owner ? issue === 'empty' ? t('添加模型') : t('管理模型') : t('查看模型')}
              </button>}
            </div>}
            {!!models.length && <div className="model-picker-search">
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
            </div>}
            {!!models.length && <div className="model-picker-toolbar">
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
            </div>}
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
            {!!models.length && !groups.length && (
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
