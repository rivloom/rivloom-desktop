import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookMarked,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CodeXml,
  FileText,
  FolderOpen,
  History,
  Layers3,
  LibraryBig,
  LoaderCircle,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import { knowledgeError } from '../shared/knowledge-errors.ts';
import type {
  LocalKnowledgeEntry,
  KnowledgeManifest,
  KnowledgeSearch,
  MemoryInput,
  MemoryOrganization,
} from '../shared/knowledge.ts';
import type { Project } from '../shared/types.ts';
import { api } from './api';
import { desktop, chooseProjectDirectory } from './desktop';
import {
  buildKnowledgeCategoryTree,
  filterKnowledgeEntries,
  flattenKnowledgeTree,
  summarizeLocalKnowledge,
  type KnowledgeOutlineEntry,
  type KnowledgeScopeFilter,
} from './knowledge-outline';
import { MessageMarkdown } from './message-markdown';
import { Button, Field, Modal } from './ui';
import './knowledge-library.css';

type Library = {
  entries: LocalKnowledgeEntry[];
  brains: { id: string; name: string; masterNodeID: string; online: boolean }[];
  organization: MemoryOrganization | null;
};
type Row = KnowledgeOutlineEntry;
type Editor = MemoryInput & { id?: string };

export function KnowledgeLibrary({ projects }: { projects: Project[] }) {
  const { i18n: activeI18n } = useTranslation();
  const activeLocale = activeI18n.language;
  const [library, setLibrary] = useState<Library>({ entries: [], brains: [], organization: null });
  const [section, setSection] = useState<'catalog' | 'rules'>('catalog');
  const [scope, setScope] = useState('local');
  const [scopeFilter, setScopeFilter] = useState<KnowledgeScopeFilter>('all');
  const [brainFilter, setBrainFilter] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [shared, setShared] = useState<KnowledgeSearch>({ entries: [], unavailable: [], next: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [readFailed, setReadFailed] = useState(false);

  const notices: Record<string, string> = {
    refreshed: t('本机目录已更新。'),
    organized: t('分类索引已整理，原文和历史版本均已保留。'),
    registered: t('Skill 已添加，当前仅本机可见。'),
    saved: t('记忆已保存。'),
    shared: t('分享范围已更新。'),
    rules: t('说明已保存，后续任务开始时生效。'),
  };

  const [register, setRegister] = useState<{ directory: string; projectID: string | null } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [sharing, setSharing] = useState<{
    entries: LocalKnowledgeEntry[];
    brains: string[];
    bulk: boolean;
    scopeDescription?: string;
  } | null>(null);
  const [removing, setRemoving] = useState<LocalKnowledgeEntry | null>(null);
  const [reading, setReading] = useState<(KnowledgeManifest & { body: string; truncated: boolean }) | null>(null);
  const [history, setHistory] = useState<{
    name: string;
    revisions: { revision: string; updatedAt: string; body: string; origin: string; withdrawnAt?: string }[];
  } | null>(null);
  const [rules, setRules] = useState<{ projectID: string | null; body: string; revision: string; path: string } | null>(
    null,
  );

  const generation = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const dialogTriggers = useRef<Partial<Record<'reading' | 'editor' | 'rules' | 'history', HTMLElement>>>({});

  useEffect(() => () => {
    mounted.current = false;
    generation.current++;
  }, []);

  async function refresh() {
    const data = await api<Library>('/knowledge');
    if (mounted.current) {
      setLibrary(data);
      setLibraryReady(true);
      setReadFailed(false);
    }
  }

  async function perform(action: () => Promise<void>) {
    if (busy || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function readDialog(kind: keyof typeof dialogTriggers.current, action: () => Promise<void>) {
    if (document.activeElement instanceof HTMLElement) dialogTriggers.current[kind] = document.activeElement;
    return perform(action);
  }

  useEffect(() => {
    mounted.current = true;
    void refresh()
      .catch((cause) => {
        if (mounted.current) {
          setError(String(cause.message));
          setReadFailed(true);
        }
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  const remoteKind = scopeFilter === 'skill' || scopeFilter === 'memory' ? scopeFilter : undefined;

  useEffect(() => {
    const request = ++generation.current;
    setShared({ entries: [], unavailable: [], next: null });
    setSearching(false);
    setReadFailed(false);
    if (scope === 'local' || section === 'rules') return;
    setSearching(true);
    setError('');
    const timer = setTimeout(() => {
      void api<KnowledgeSearch>(
        '/knowledge/search',
        {
          brainID: scope,
          ...(remoteKind ? { kind: remoteKind } : {}),
          text: query,
          category,
        },
        { timeoutMilliseconds: 45_000 },
      )
        .then((result) => {
          if (request === generation.current && mounted.current) setShared(result);
        })
        .catch((cause) => {
          if (request === generation.current && mounted.current) {
            setError(cause.message);
            setReadFailed(true);
          }
        })
        .finally(() => {
          if (request === generation.current && mounted.current) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [scope, section, remoteKind, query, category, refreshKey]);

  const localSummary = useMemo(() => summarizeLocalKnowledge(library.entries), [library.entries]);

  const localRows = useMemo<Row[]>(
    () => library.entries.map((entry) => ({ ...entry, brainID: null, nodeName: t('本机') })),
    [library.entries, activeLocale],
  );

  const brainRows = useMemo<Row[]>(
    () => shared.entries.map((entry) => ({ ...entry })),
    [shared.entries],
  );

  const isLocal = scope === 'local';
  const activeScopeFilter: KnowledgeScopeFilter =
    !isLocal && (scopeFilter === 'private' || scopeFilter === 'shared') ? 'all' : scopeFilter;

  const treeSourceRows = useMemo(() => {
    if (!isLocal) return brainRows;
    return filterKnowledgeEntries(localRows, {
      filter: activeScopeFilter,
      brainFilter: activeScopeFilter === 'shared' ? brainFilter : '',
      category: '',
      query: '',
      localScope: true,
    });
  }, [isLocal, localRows, brainRows, activeScopeFilter, brainFilter]);

  const rows = useMemo(() => {
    if (!isLocal) return brainRows;
    return filterKnowledgeEntries(localRows, {
      filter: activeScopeFilter,
      brainFilter: activeScopeFilter === 'shared' ? brainFilter : '',
      category,
      query,
      localScope: true,
    });
  }, [isLocal, localRows, brainRows, activeScopeFilter, brainFilter, category, query]);

  const categoryTree = useMemo(() => buildKnowledgeCategoryTree(treeSourceRows), [treeSourceRows]);
  const treeRows = useMemo(() => flattenKnowledgeTree(categoryTree, collapsed), [categoryTree, collapsed]);
  const directoryUnavailable = isLocal ? !libraryReady : readFailed;

  const own = (id: string) => library.entries.find((entry) => entry.id === id);
  const projectLabel = (projectID: string | null | undefined) =>
    projectID ? projects.find((project) => project.id === projectID)?.name || t('已关联项目') : t('所有目录');
  const brainByID = (id: string) => library.brains.find((brain) => brain.id === id);

  const hasFilters = Boolean(query || category || (isLocal && (activeScopeFilter !== 'all' || brainFilter)) || (!isLocal && activeScopeFilter !== 'all'));

  function clearFilters() {
    setQuery('');
    setCategory('');
    setScopeFilter('all');
    setBrainFilter('');
  }

  function changeScope(next: string) {
    setScope(next);
    setCategory('');
    setBrainFilter('');
    if (next !== 'local' && (scopeFilter === 'private' || scopeFilter === 'shared')) {
      setScopeFilter('all');
    }
  }

  function toggleCollapsed(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const close = (action: () => void) => {
    if (!busy) action();
  };

  async function read(row: Row) {
    const value = await api<KnowledgeManifest & { body: string; truncated: boolean }>('/knowledge/read', {
      brainID: row.brainID,
      nodeID: row.nodeID,
      id: row.id,
    });
    setReading(value);
  }

  async function openHistory(entry: LocalKnowledgeEntry) {
    const revisions = await api<NonNullable<typeof history>['revisions']>(`/knowledge/history/${entry.id}`);
    setHistory({ name: entry.name, revisions });
  }

  function projectField(value: string | null, change: (value: string | null) => void) {
    return (
      <Field label={t('本机适用范围')}>
        <select disabled={busy} value={value || ''} onChange={(event) => change(event.target.value || null)}>
          <option value="">{t('本机所有工作目录')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  const localVisibleEntries = useMemo(
    () =>
      isLocal
        ? rows.map((row) => own(row.id)).filter((entry): entry is LocalKnowledgeEntry => !!entry)
        : [],
    [isLocal, rows, library.entries],
  );

  const canBulkShare = isLocal && !!category && localVisibleEntries.length > 0;

  function openBulkShare() {
    if (!localVisibleEntries.length) return;
    const commonBrains = library.brains
      .map((brain) => brain.id)
      .filter((brainID) => localVisibleEntries.every((entry) => entry.sharedBrains.includes(brainID)));
    setSharing({
      entries: localVisibleEntries,
      brains: commonBrains,
      bulk: true,
      scopeDescription: category
        ? t('分类「{{category}}」当前筛选下显示的 {{count}} 条现有条目', {
            category,
            count: localVisibleEntries.length,
          })
        : t('当前筛选下显示的 {{count}} 条现有条目', { count: localVisibleEntries.length }),
    });
  }

  function originLabel(entry: LocalKnowledgeEntry) {
    if (entry.provenance) return t('会话确认记忆');
    if (entry.origin === 'skill-draft') return t('Skill 草稿');
    if (entry.origin?.startsWith('task:')) return t('任务保存');
    return null;
  }

  return (
    <section className="knowledge-library" aria-label={t('技能与记忆')}>
      <div className="knowledge-heading">
        <div className="knowledge-heading-copy">
          <span className="utility-page-icon">
            <LibraryBig size={22} aria-hidden="true" />
          </span>
          <div>
            <h1>{t('技能与记忆')}</h1>
            <p>{t('默认本机私有，手动分享给 Brain；先浏览摘要大纲，再按需读取正文，不执行脚本。')}</p>
          </div>
        </div>
        <Button
          disabled={busy || loading}
          onClick={() =>
            void perform(async () => {
              await api('/knowledge/refresh', {});
              await refresh();
              setRefreshKey((value) => value + 1);
              setNotice('refreshed');
            })
          }
        >
          <RefreshCw size={15} className={busy || loading ? 'spin' : ''} />
          {t('刷新')}
        </Button>
      </div>

      <nav className="knowledge-tabs" aria-label={t('知识库分类')}>
        <button
          type="button"
          disabled={busy}
          aria-current={section === 'catalog' ? 'page' : undefined}
          onClick={() => setSection('catalog')}
        >
          <Layers3 size={15} aria-hidden="true" />
          {t('知识大纲与目录')}
          <span className="knowledge-tab-count">{localSummary.total}</span>
        </button>
        <button
          type="button"
          disabled={busy}
          aria-current={section === 'rules' ? 'page' : undefined}
          onClick={() => setSection('rules')}
        >
          <ScrollText size={15} aria-hidden="true" />
          {t('本机与目录说明')}
        </button>
      </nav>

      {error && (
        <p className="knowledge-error" role="alert">
          {knowledgeError(error) || systemText(error)}
        </p>
      )}
      {notice && (
        <p className="knowledge-notice" role="status">
          {notices[notice]}
        </p>
      )}

      {section === 'rules' ? (
        <div className="knowledge-rules-list">
          <p>{t('本机说明适用于本机发起的任务；工作目录说明随对应目录加载。Wiki 正文只在需要时读取。')}</p>
          {[{ id: null, name: t('本机主说明'), directory: 'AGENTS.md' }, ...projects].map((project) => (
            <article key={project.id || 'node'}>
              <span className="knowledge-row-icon">
                <FileText size={17} aria-hidden="true" />
              </span>
              <div>
                <strong>{project.name}</strong>
                <small>{project.directory}</small>
              </div>
              <Button
                disabled={busy}
                onClick={() =>
                  void readDialog('rules', async () => {
                    const result = await api<{ body: string; revision: string; path: string }>(
                      '/knowledge/rules/read',
                      { projectID: project.id },
                    );
                    setRules({ ...result, projectID: project.id });
                  })
                }
              >
                {t('编辑说明')}
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <>
          {isLocal && (
            <div className="knowledge-overview-strip" role="group" aria-label={t('共享状态总览')}>
              {(
                [
                  { id: 'all', label: t('全部'), count: localSummary.total, tone: 'all' },
                  { id: 'private', label: t('本机私有'), count: localSummary.privateCount, tone: 'private' },
                  { id: 'shared', label: t('已分享给 Brain'), count: localSummary.sharedCount, tone: 'shared' },
                  { id: 'skill', label: t('Skills'), count: localSummary.skillCount, tone: 'skill' },
                  { id: 'memory', label: t('Wiki'), count: localSummary.memoryCount, tone: 'memory' },
                ] as const
              ).map((stat) => (
                <button
                  key={stat.id}
                  type="button"
                  disabled={busy}
                  className={`knowledge-overview-pill is-${stat.tone}`}
                  aria-pressed={activeScopeFilter === stat.id}
                  onClick={() => {
                    setScopeFilter(stat.id);
                    if (stat.id !== 'shared') setBrainFilter('');
                  }}
                >
                  <span>{stat.label}</span>
                  <strong>{stat.count}</strong>
                </button>
              ))}
            </div>
          )}

          <div className="knowledge-toolbar">
            <select
              aria-label={t('知识库来源')}
              disabled={busy}
              value={scope}
              onChange={(event) => changeScope(event.target.value)}
            >
              <option value="local">{t('本机')}</option>
              {library.brains.map((brain) => (
                <option key={brain.id} value={brain.id}>
                  {brain.name}
                </option>
              ))}
            </select>

            {!isLocal && (
              <div className="knowledge-scope-pills" role="group" aria-label={t('类型筛选')}>
                {(
                  [
                    { id: 'all', label: t('全部') },
                    { id: 'skill', label: t('Skills') },
                    { id: 'memory', label: t('Wiki') },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={busy}
                    aria-pressed={activeScopeFilter === item.id}
                    onClick={() => setScopeFilter(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            {isLocal && activeScopeFilter === 'shared' && library.brains.length > 1 && (
              <select
                aria-label={t('按分享的 Brain 筛选')}
                disabled={busy}
                value={brainFilter}
                onChange={(event) => setBrainFilter(event.target.value)}
              >
                <option value="">{t('全部已分享 Brain')}</option>
                {library.brains.map((brain) => (
                  <option key={brain.id} value={brain.id}>
                    {brain.name}
                  </option>
                ))}
              </select>
            )}

            <label className="knowledge-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label={t('搜索技能与记忆')}
                placeholder={t('搜索名称、用途或分类')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            {hasFilters && <Button onClick={clearFilters}>{t('清除筛选')}</Button>}

            {isLocal && (
              <div className="knowledge-toolbar-create">
                <Button
                  disabled={busy}
                  onClick={() => setRegister({ directory: '', projectID: null })}
                >
                  <Plus size={14} />
                  {t('添加 Skill')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    setEditor({
                      name: '',
                      description: '',
                      category: category && category !== 'Skills' ? category : '',
                      body: '',
                      projectID: null,
                    })
                  }
                >
                  <Plus size={14} />
                  {t('新建记忆')}
                </Button>
              </div>
            )}
          </div>

          {!isLocal && (
            <p className="knowledge-explainer">
              {t('这里只显示向此 Brain 分享的目录。打开内容时会向来源 Node 核对最新版。')}
            </p>
          )}
          {!!shared.unavailable.length && !isLocal && (
            <p role="status" className="knowledge-notice">
              {t('部分来源暂时不可用，当前目录可能不完整。')}
            </p>
          )}

          <div className="knowledge-layout">
            <aside className="knowledge-tree" aria-label={t('分类大纲')}>
              <div className="knowledge-tree-heading">
                <span>{t('分类大纲')}</span>
                <small>{treeSourceRows.length}</small>
              </div>
              <button
                type="button"
                className="knowledge-tree-root"
                aria-current={!category ? 'page' : undefined}
                onClick={() => setCategory('')}
              >
                <Layers3 size={14} aria-hidden="true" />
                <span className="knowledge-tree-label">{t('全部分类')}</span>
                <span className="knowledge-tree-count">{treeSourceRows.length}</span>
              </button>

              <div className="knowledge-tree-nodes" role="tree" aria-label={t('分类层级')}>
                {treeRows.map((node) => (
                  <div
                    key={node.path}
                    className={`knowledge-tree-row${category === node.path ? ' is-selected' : ''}`}
                    style={{ paddingLeft: 6 + Math.min(node.depth, 5) * 14 }}
                    role="treeitem"
                    aria-expanded={node.hasChildren ? node.expanded : undefined}
                    aria-selected={category === node.path}
                  >
                    {node.hasChildren ? (
                      <button
                        type="button"
                        className="knowledge-tree-chevron"
                        aria-label={node.expanded ? t('收起分类') : t('展开分类')}
                        onClick={() => toggleCollapsed(node.path)}
                      >
                        {node.expanded ? (
                          <ChevronDown size={13} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={13} aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="knowledge-tree-spacer" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className="knowledge-tree-node-btn"
                      title={node.path}
                      aria-current={category === node.path ? 'page' : undefined}
                      onClick={() => setCategory(node.path)}
                    >
                      <FolderOpen size={13} aria-hidden="true" />
                      <span className="knowledge-tree-label">{node.label}</span>
                      {isLocal && node.sharedCount > 0 && (
                        <span
                          className="knowledge-tree-shared-dot"
                          title={t('含 {{count}} 条已分享条目', { count: node.sharedCount })}
                          aria-label={t('含 {{count}} 条已分享条目', { count: node.sharedCount })}
                        />
                      )}
                      <span className="knowledge-tree-count">{node.count}</span>
                    </button>
                  </div>
                ))}
              </div>

              {isLocal && (
                <div className="knowledge-tree-footer">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api('/knowledge/organize', {});
                        await refresh();
                        setNotice('organized');
                      })
                    }
                  >
                    {t('整理记忆')}
                  </Button>
                  {library.organization && (
                    <small>
                      {t('上次整理')}
                      <br />
                      {new Date(library.organization.at).toLocaleString()}
                      {library.organization.duplicates.length > 0 && (
                        <>
                          <br />
                          {t('重复正文分组：{{count}}', { count: library.organization.duplicates.length })}
                        </>
                      )}
                    </small>
                  )}
                </div>
              )}
            </aside>

            <div className="knowledge-entries" aria-busy={busy || loading || searching}>
              {(category || canBulkShare) && (
                <div className="knowledge-list-bar">
                  <span className="knowledge-list-scope">
                    {category ? (
                      <>
                        <strong>{category}</strong>
                        <small>{t('当前显示 {{count}} 条', { count: rows.length })}</small>
                      </>
                    ) : (
                      <small>{t('当前显示 {{count}} 条', { count: rows.length })}</small>
                    )}
                  </span>
                  {canBulkShare && (
                    <Button disabled={busy} onClick={openBulkShare}>
                      <Share2 size={13.5} />
                      {t('分享此分类中的条目（{{count}}）', { count: localVisibleEntries.length })}
                    </Button>
                  )}
                </div>
              )}

              {rows.map((row) => {
                const local = isLocal ? own(row.id) : undefined;
                const badge = local ? originLabel(local) : null;
                const isDuplicate =
                  !!local && library.organization?.duplicates.some((group) => group.includes(local.id));

                return (
                  <article className="knowledge-entry" key={`${row.brainID}:${row.nodeID}:${row.id}`}>
                    <span className={`knowledge-row-icon is-${row.kind}`}>
                      {row.kind === 'skill' ? (
                        <CodeXml size={16} aria-hidden="true" />
                      ) : (
                        <BookMarked size={16} aria-hidden="true" />
                      )}
                    </span>

                    <div className="knowledge-entry-main">
                      <div className="knowledge-entry-title-row">
                        <span className={`knowledge-kind-pill is-${row.kind}`}>
                          {row.kind === 'skill' ? 'Skill' : 'Wiki'}
                        </span>
                        <button
                          type="button"
                          className="knowledge-title"
                          disabled={busy}
                          onClick={() => void readDialog('reading', () => read(row))}
                        >
                          {row.name}
                        </button>
                        {local && (
                          <span className="knowledge-project-pill">{projectLabel(local.projectID)}</span>
                        )}
                        {badge && <span className="knowledge-origin-pill">{badge}</span>}
                        {local?.withdrawnAt && (
                          <span className="knowledge-status-pill is-withdrawn">{t('已撤回')}</span>
                        )}
                      </div>

                      <p>{row.description || t('暂无用途说明')}</p>

                      <div className="knowledge-entry-meta">
                        <span className="knowledge-entry-category">{row.category}</span>
                        <span>{row.nodeName}</span>
                        <code title={row.revision}>{row.revision.slice(0, 10)}</code>
                        <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>
                      </div>

                      {local && (
                        <div className="knowledge-sharing-row">
                          {local.sharedBrains.length > 0 ? (
                            <>
                              <span className="knowledge-share-badge is-shared">
                                <Share2 size={11} aria-hidden="true" />
                                {t('已分享给')}
                              </span>
                              {local.sharedBrains.map((id) => {
                                const target = brainByID(id);
                                return (
                                  <span className="knowledge-brain-chip" key={id}>
                                    <i className={`status-dot ${target?.online ? 'online' : ''}`} />
                                    {target?.name || id.slice(0, 8)}
                                  </span>
                                );
                              })}
                            </>
                          ) : (
                            <span className="knowledge-share-badge is-private">
                              <Lock size={11} aria-hidden="true" />
                              {t('仅本机私有')}
                            </span>
                          )}
                        </div>
                      )}

                      {local?.error && (
                        <p role="status" className="knowledge-error">
                          {knowledgeError(local.error)}
                        </p>
                      )}
                      {isDuplicate && (
                        <small className="knowledge-duplicate-hint">
                          {t('存在相同正文，原始条目均已保留。')}
                        </small>
                      )}
                    </div>

                    {local && (
                      <div className="knowledge-actions">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={t('管理分享')}
                          title={t('管理分享')}
                          onClick={() =>
                            setSharing({
                              entries: [local],
                              brains: [...local.sharedBrains],
                              bulk: false,
                            })
                          }
                        >
                          <Share2 size={15} />
                        </button>
                        {local.kind === 'memory' && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={t('历史版本')}
                            title={t('历史版本')}
                            onClick={() => void readDialog('history', () => openHistory(local))}
                          >
                            <History size={15} />
                          </button>
                        )}
                        {local.kind === 'memory' && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={t('编辑记忆')}
                            title={t('编辑记忆')}
                            onClick={() =>
                              void readDialog('editor', async () => {
                                const value = await api<LocalKnowledgeEntry & { body: string }>(
                                  `/knowledge/memory/${row.id}`,
                                );
                                setEditor({
                                  id: value.id,
                                  expectedRevision: value.revision,
                                  name: value.name,
                                  description: value.description,
                                  category: value.category,
                                  body: value.body,
                                  projectID: value.projectID,
                                });
                              })
                            }
                          >
                            <Pencil size={15} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="knowledge-remove"
                          disabled={busy}
                          aria-label={t('移除条目')}
                          title={t('移除条目')}
                          onClick={() => setRemoving(local)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}

              {!rows.length && (
                <div className="knowledge-empty" role="status">
                  <span className="utility-page-icon" data-error={directoryUnavailable && !loading && !searching}>
                    {loading || searching ? (
                      <LoaderCircle size={22} className="spin" />
                    ) : directoryUnavailable ? (
                      <CircleAlert size={22} />
                    ) : (
                      <BookOpen size={22} />
                    )}
                  </span>
                  <p>
                    {loading || searching
                      ? t('正在读取目录…')
                      : directoryUnavailable
                        ? t('暂时无法读取目录，请刷新重试。')
                        : hasFilters
                          ? t('没有找到匹配的内容')
                          : t('还没有保存技能或记忆')}
                  </p>
                  {!loading &&
                    !searching &&
                    !directoryUnavailable &&
                    (hasFilters ? (
                      <small>{t('换一个关键词，或清除筛选查看全部内容。')}</small>
                    ) : (
                      isLocal && (
                        <small>
                          {t('添加含 SKILL.md 的文件夹或新建 Wiki 记忆；所有内容默认本机私有，按需手动分享。')}
                        </small>
                      )
                    ))}
                </div>
              )}

              {shared.next !== null && !isLocal && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const result = await api<KnowledgeSearch>('/knowledge/search', {
                        brainID: scope,
                        ...(remoteKind ? { kind: remoteKind } : {}),
                        text: query,
                        category,
                        offset: shared.next,
                      });
                      setShared((old) => ({ ...result, entries: [...old.entries, ...result.entries] }));
                    })
                  }
                >
                  {t('加载更多')}
                </Button>
              )}
            </div>
          </div>

          <p className="knowledge-explainer">
            {t('记忆与 Skill 默认保留本机。自动整理仅更新分类索引并标记完全重复的正文，不调用模型，也不自动删除或分享。')}
          </p>
        </>
      )}

      {register && (
        <Modal title={t('添加 Skill')} close={() => close(() => setRegister(null))}>
          {error && (
            <p className="knowledge-error" role="alert">
              {knowledgeError(error) || systemText(error)}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await api('/knowledge/skills/register', register);
                await refresh();
                setRegister(null);
                setNotice('registered');
              });
            }}
          >
            <Field
              label={t('Skill 文件夹')}
              hint={t('选择直接包含 SKILL.md 的目录，脚本和参考文件会按需取用，登记与分享均不执行脚本。')}
            >
              <input
                required
                disabled={busy}
                value={register.directory}
                onChange={(event) => setRegister({ ...register, directory: event.target.value })}
              />
            </Field>
            {desktop && (
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const directory = await chooseProjectDirectory();
                    if (directory) setRegister({ ...register, directory });
                  })
                }
              >
                <FolderOpen size={15} />
                {t('选择文件夹')}
              </Button>
            )}
            {projectField(register.projectID, (projectID) => setRegister({ ...register, projectID }))}
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setRegister(null)}>
                {t('取消')}
              </Button>
              <Button type="submit" variant="primary" disabled={busy || !register.directory.trim()}>
                {t('添加')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {editor && (
        <Modal
          title={editor.id ? t('编辑记忆') : t('新建记忆')}
          close={() => close(() => setEditor(null))}
          className="knowledge-editor"
          returnFocus={editor.id ? dialogTriggers.current.editor : undefined}
        >
          {error && (
            <p className="knowledge-error" role="alert">
              {knowledgeError(error) || systemText(error)}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await api('/knowledge/memory', editor);
                await refresh();
                setEditor(null);
                setNotice('saved');
              });
            }}
          >
            <Field label={t('名称')}>
              <input
                required
                disabled={busy}
                maxLength={120}
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </Field>
            <Field label={t('用途摘要')} hint={t('Agent 先看到这段摘要，再决定是否读取正文。')}>
              <input
                disabled={busy}
                maxLength={600}
                value={editor.description}
                onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              />
            </Field>
            <Field label={t('分类路径')} hint={t('例如：人物/张三/信息，或人物/张三/工作。')}>
              <input
                required
                disabled={busy}
                maxLength={240}
                value={editor.category}
                onChange={(event) => setEditor({ ...editor, category: event.target.value })}
              />
            </Field>
            {projectField(editor.projectID, (projectID) => setEditor({ ...editor, projectID }))}
            <Field label={t('记忆正文')}>
              <textarea
                required
                disabled={busy}
                rows={10}
                maxLength={32_000}
                value={editor.body}
                onChange={(event) => setEditor({ ...editor, body: event.target.value })}
              />
            </Field>
            <div className="modal-actions">
              {editor.id && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void readDialog('history', async () => {
                      const revisions = await api<NonNullable<typeof history>['revisions']>(
                        `/knowledge/history/${editor.id}`,
                      );
                      setHistory({ name: editor.name, revisions });
                    })
                  }
                >
                  {t('历史版本')}
                </Button>
              )}
              <Button disabled={busy} onClick={() => setEditor(null)}>
                {t('取消')}
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {t('保存')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {sharing && (
        <Modal
          title={t('管理分享')}
          subtitle={
            sharing.entries.length === 1
              ? sharing.entries[0].name
              : sharing.scopeDescription || t('为此分类当前显示的条目统一设置分享范围。')
          }
          close={() => close(() => setSharing(null))}
          className="knowledge-share-modal"
        >
          {error && (
            <p className="knowledge-error" role="alert">
              {knowledgeError(error) || systemText(error)}
            </p>
          )}

          <div className="knowledge-boundary-banner" role="note">
            <ShieldCheck size={15} aria-hidden="true" />
            <div>
              {sharing.bulk && (
                <p>
                  <strong>
                    {t('此次仅更新当前筛选下显示的这 {{count}} 条现有条目，不是自动分享规则；之后新建的条目仍默认本机私有。', {
                      count: sharing.entries.length,
                    })}
                  </strong>
                </p>
              )}
              <p>
                {t(
                  '选中的 Brain 及其受信 Node 可按需读取摘要与最新版正文，绝不执行脚本。取消分享会阻止后续取用，已取走的内容无法远程收回。',
                )}
              </p>
            </div>
          </div>

          <section className="knowledge-share-preview" aria-label={t('即将更新的条目范围')}>
            <div className="knowledge-share-preview-head">
              <strong>{t('实际影响条目（{{count}}）', { count: sharing.entries.length })}</strong>
              <small>
                {sharing.brains.length > 0
                  ? t('目标：分享给 {{count}} 个 Brain', { count: sharing.brains.length })
                  : t('目标：设为仅本机私有')}
              </small>
            </div>
            <ul>
              {sharing.entries.map((entry) => (
                <li key={entry.id}>
                  <span className={`knowledge-kind-pill is-${entry.kind}`}>
                    {entry.kind === 'skill' ? 'Skill' : 'Wiki'}
                  </span>
                  <div className="knowledge-share-preview-copy">
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.category} · <code>{entry.revision.slice(0, 8)}</code>
                    </small>
                  </div>
                  <span className="knowledge-share-preview-state">
                    {entry.sharedBrains.length > 0
                      ? entry.sharedBrains
                          .map((id) => brainByID(id)?.name || id.slice(0, 8))
                          .join(', ')
                      : t('仅本机私有')}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <div className="knowledge-share-options">
            {library.brains.map((brain) => (
              <label key={brain.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={sharing.brains.includes(brain.id)}
                  onChange={(event) =>
                    setSharing({
                      ...sharing,
                      brains: event.target.checked
                        ? [...sharing.brains, brain.id]
                        : sharing.brains.filter((id) => id !== brain.id),
                    })
                  }
                />
                <span>{brain.name}</span>
                <small>{brain.online ? t('在线') : t('离线')}</small>
              </label>
            ))}
          </div>

          {!library.brains.length && <p>{t('尚无可分享的 Brain，请先完成节点连接。')}</p>}

          <div className="modal-actions">
            {sharing.brains.length > 0 && (
              <Button disabled={busy} onClick={() => setSharing({ ...sharing, brains: [] })}>
                {t('取消全部分享')}
              </Button>
            )}
            <Button disabled={busy} onClick={() => setSharing(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api('/knowledge/share-many', {
                    entries: sharing.entries.map((value) => ({
                      id: value.id,
                      revision: value.revision,
                      updatedAt: value.updatedAt,
                    })),
                    brains: sharing.brains,
                  });
                  await refresh();
                  setSharing(null);
                  setNotice('shared');
                })
              }
            >
              {t('确认保存分享范围')}
            </Button>
          </div>
        </Modal>
      )}

      {removing && (
        <Modal title={t('移除条目')} subtitle={removing.name} close={() => close(() => setRemoving(null))}>
          {error && (
            <p className="knowledge-error" role="alert">
              {knowledgeError(error) || systemText(error)}
            </p>
          )}
          <p>
            {removing.kind === 'skill'
              ? t('移除登记并取消分享，原 Skill 文件夹保留。')
              : t('移除此记忆及其历史版本，同时取消分享。')}
          </p>
          <div className="modal-actions">
            <Button disabled={busy} onClick={() => setRemoving(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api('/knowledge/remove', { id: removing.id, revision: removing.revision });
                  await refresh();
                  setRemoving(null);
                })
              }
            >
              {t('确认移除')}
            </Button>
          </div>
        </Modal>
      )}

      {reading && (
        <Modal
          title={reading.entry.name}
          subtitle={`${reading.entry.category} · ${reading.entry.revision.slice(0, 12)}`}
          close={() => setReading(null)}
          className="knowledge-editor"
          returnFocus={dialogTriggers.current.reading}
        >
          {reading.entry.kind === 'skill' && (
            <p className="knowledge-explainer">
              {t('仅查看 Skill 文本与附带文件清单，不执行其中任何脚本。')}
            </p>
          )}
          {reading.truncated ? (
            <p>{t('正文过长，请通过任务按需加载文件。')}</p>
          ) : (
            <MessageMarkdown text={reading.body} />
          )}
          <details open={reading.entry.kind === 'skill'}>
            <summary>
              {t('附带文件')} · {reading.files.length}
            </summary>
            <ul>
              {reading.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> · {file.bytes} B
                </li>
              ))}
            </ul>
          </details>
        </Modal>
      )}

      {rules && (
        <Modal
          title={t('编辑说明')}
          subtitle={rules.path}
          close={() => close(() => setRules(null))}
          className="knowledge-editor"
          returnFocus={dialogTriggers.current.rules}
        >
          {error && (
            <p className="knowledge-error" role="alert">
              {knowledgeError(error) || systemText(error)}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await api('/knowledge/rules/save', {
                  projectID: rules.projectID,
                  body: rules.body,
                  revision: rules.revision,
                });
                setRules(null);
                setNotice('rules');
              });
            }}
          >
            <Field label={t('说明内容')}>
              <textarea
                disabled={busy}
                rows={15}
                maxLength={24_000}
                value={rules.body}
                onChange={(event) => setRules({ ...rules, body: event.target.value })}
              />
            </Field>
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setRules(null)}>
                {t('取消')}
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {t('保存')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {history && (
        <Modal
          title={t('历史版本')}
          subtitle={history.name}
          close={() => setHistory(null)}
          className="knowledge-editor"
          returnFocus={dialogTriggers.current.history}
        >
          {!history.revisions.length && <p className="knowledge-empty">{t('尚无记录')}</p>}
          {history.revisions.map((item, index) => (
            <details key={item.revision} open={index === 0}>
              <summary>
                {new Date(item.updatedAt).toLocaleString()} · {item.revision.slice(0, 10)}
                {item.withdrawnAt ? ` · ${t('已撤回')}` : ''}
              </summary>
              <small>{item.origin}</small>
              <MessageMarkdown text={item.body} />
            </details>
          ))}
        </Modal>
      )}
    </section>
  );
}
