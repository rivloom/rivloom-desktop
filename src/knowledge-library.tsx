import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FolderOpen, Plus, RefreshCw, Share2, Pencil, Trash2, FileText } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { knowledgeError } from '../shared/knowledge-errors.ts';
import type { LocalKnowledgeEntry, KnowledgeManifest, KnowledgeSearch, MemoryInput, MemoryOrganization } from '../shared/knowledge.ts';
import type { Project } from '../shared/types.ts';
import { api } from './api';
import { Button, Field, Modal } from './ui';
import { desktop, chooseProjectDirectory } from './desktop';
import { MessageMarkdown } from './message-markdown';
import './knowledge-library.css';

type Library = { entries: LocalKnowledgeEntry[]; brains: { id: string; name: string; masterNodeID: string; online: boolean }[]; organization: MemoryOrganization | null };
type Row = KnowledgeSearch['entries'][number];
type Editor = MemoryInput & { id?: string };
export function KnowledgeLibrary({ projects }: { projects: Project[] }) {
  const [library, setLibrary] = useState<Library>({ entries: [], brains: [], organization: null });
  const [tab, setTab] = useState<'skill' | 'memory' | 'rules'>('skill');
  const [scope, setScope] = useState('local'); const [query, setQuery] = useState(''); const [category, setCategory] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [shared, setShared] = useState<KnowledgeSearch>({ entries: [], unavailable: [], next: null });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const notices: Record<string, string> = { refreshed: t('本机目录已更新。'), organized: t('分类索引已整理，原文和历史版本均已保留。'),
    registered: t('Skill 已添加，当前仅本机可见。'), saved: t('记忆已保存。'), shared: t('分享范围已更新。'), rules: t('说明已保存，后续任务开始时生效。') };
  const [register, setRegister] = useState<{ directory: string; projectID: string | null } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [sharing, setSharing] = useState<{ entries: LocalKnowledgeEntry[]; brains: string[] } | null>(null);
  const [removing, setRemoving] = useState<LocalKnowledgeEntry | null>(null);
  const [reading, setReading] = useState<(KnowledgeManifest & { body: string; truncated: boolean }) | null>(null);
  const [history, setHistory] = useState<{ name: string; revisions: { revision: string; updatedAt: string; body: string; origin: string }[] } | null>(null);
  const [rules, setRules] = useState<{ projectID: string | null; body: string; revision: string; path: string } | null>(null);
  const generation = useRef(0); const mounted = useRef(true);
  const mutating = useRef(false);
  useEffect(() => () => { mounted.current = false; generation.current++; }, []);
  async function refresh() { const data = await api<Library>('/knowledge'); if (mounted.current) setLibrary(data); }
  async function perform(action: () => Promise<void>) {
    if (busy || mutating.current) return; mutating.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { mutating.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void refresh().catch((cause) => { if (mounted.current) setError(String(cause.message)); }); }, []);
  useEffect(() => {
    const request = ++generation.current;
    setShared({ entries: [], unavailable: [], next: null });
    if (scope === 'local' || tab === 'rules') return;
    setBusy(true); setError('');
    const timer = setTimeout(() => { void api<KnowledgeSearch>('/knowledge/search', { brainID: scope, kind: tab, text: query, category }, { timeoutMilliseconds: 45_000 })
      .then((result) => { if (request === generation.current && mounted.current) setShared(result); })
      .catch((cause) => { if (request === generation.current && mounted.current) setError(cause.message); })
      .finally(() => { if (request === generation.current && mounted.current) setBusy(false); }); }, 200);
    return () => clearTimeout(timer);
  }, [scope, tab, query, category, refreshKey]);
  const locals = useMemo(() => library.entries.filter((v) => v.kind === tab), [library.entries, tab]);
  const localRows: Row[] = locals.map((v) => ({ ...v, brainID: null, nodeName: t('本机') }));
  const allRows = scope === 'local' ? localRows : shared.entries;
  const rows = scope === 'local' ? allRows.filter((v) => (!category || v.category === category || v.category.startsWith(`${category}/`)) &&
    `${v.name} ${v.description} ${v.category}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : allRows;
  const categories = [...new Set(allRows.flatMap((v) => v.category.split('/').map((_part, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();
  const own = (id: string) => library.entries.find((v) => v.id === id)!;
  function switchTab(value: typeof tab) { setTab(value); setCategory(''); setQuery(''); }
  const close = (action: () => void) => { if (!busy) action(); };
  async function read(row: Row) {
    const value = await api<KnowledgeManifest & { body: string; truncated: boolean }>('/knowledge/read', { brainID: row.brainID, nodeID: row.nodeID, id: row.id }); setReading(value);
  }
  function projectField(value: string | null, change: (value: string | null) => void) {
    return <Field label={t('本机适用范围')}><select value={value || ''} onChange={(e) => change(e.target.value || null)}>
      <option value="">{t('本机所有工作目录')}</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></Field>;
  }
  return <section className="knowledge-library" aria-label={t('技能与记忆')}>
    <div className="knowledge-heading"><div><h1><BookOpen size={22} />{t('技能与记忆')}</h1>
      <p>{t('本机保存，按需分享；先发现用途，再加载内容。')}</p></div>
      <Button disabled={busy} onClick={() => void perform(async () => { await api('/knowledge/refresh', {}); await refresh(); setRefreshKey((v) => v + 1); setNotice('refreshed'); })}>
        <RefreshCw size={15} />{t('刷新')}</Button></div>
    <nav className="device-settings-tabs" aria-label={t('知识库分类')}>
      <button disabled={busy} aria-current={tab === 'skill' ? 'page' : undefined} onClick={() => switchTab('skill')}>{t('Skills')}</button>
      <button disabled={busy} aria-current={tab === 'memory' ? 'page' : undefined} onClick={() => switchTab('memory')}>{t('Wiki 记忆')}</button>
      <button disabled={busy} aria-current={tab === 'rules' ? 'page' : undefined} onClick={() => switchTab('rules')}>{t('本机与目录说明')}</button>
    </nav>
    {error && <p className="knowledge-error" role="alert">{knowledgeError(error) || error}</p>}
    {notice && <p className="knowledge-notice" role="status">{notices[notice]}</p>}
    {tab === 'rules' ? <div className="knowledge-rules-list"><p>{t('本机说明适用于本机发起的任务；工作目录说明随对应目录加载。Wiki 正文只在需要时读取。')}</p>
      {[{ id: null, name: t('本机主说明'), directory: 'AGENTS.md' }, ...projects].map((p) => <article key={p.id || 'node'}>
        <FileText size={18} /><div><strong>{p.name}</strong><small>{p.directory}</small></div>
        <Button disabled={busy} onClick={() => void perform(async () => {
          const result = await api<{ body: string; revision: string; path: string }>('/knowledge/rules/read', { projectID: p.id }); setRules({ ...result, projectID: p.id });
        })}>{t('编辑说明')}</Button></article>)}
    </div> : <>
      <div className="knowledge-toolbar"><label><span className="sr-only">{t('知识库来源')}</span><select disabled={busy} value={scope} onChange={(e) => { setScope(e.target.value); setCategory(''); }}>
        <option value="local">{t('我的 Node')}</option>{library.brains.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></label><input aria-label={t('搜索技能与记忆')} placeholder={t('搜索名称、用途或分类')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {scope === 'local' && <Button disabled={busy} onClick={() => tab === 'skill' ? setRegister({ directory: '', projectID: null }) :
        setEditor({ name: '', description: '', category: category || '', body: '', projectID: null })}><Plus size={15} />{tab === 'skill' ? t('添加 Skill') : t('新建记忆')}</Button>}
    </div>
    {scope !== 'local' && <p className="knowledge-explainer">{t('这里只显示向此 Brain 分享的目录。打开内容时会向来源 Node 核对最新版。')}</p>}
    {!!shared.unavailable.length && scope !== 'local' && <p role="status" className="knowledge-notice">{t('部分来源暂时不可用，当前目录可能不完整。')}</p>}
    <div className="knowledge-layout">
      {tab === 'memory' && <aside className="knowledge-tree" aria-label={t('记忆分类')}>
        <button aria-current={!category ? 'page' : undefined} onClick={() => setCategory('')}>{t('全部分类')}</button>
        {categories.map((path) => <button key={path} title={path} aria-current={category === path ? 'page' : undefined}
          style={{ paddingLeft: 12 + Math.min(path.split('/').length - 1, 6) * 12 }} onClick={() => setCategory(path)}><FolderOpen size={14} />{path.split('/').at(-1)}</button>)}
        {scope === 'local' && <Button disabled={busy} onClick={() => void perform(async () => { await api('/knowledge/organize', {}); await refresh(); setNotice('organized'); })}>{t('整理记忆')}</Button>}
        {library.organization && scope === 'local' && <small>{t('上次整理')}<br />{new Date(library.organization.at).toLocaleString()}</small>}
      </aside>}
      <div className="knowledge-entries" aria-busy={busy}>
        {scope === 'local' && tab === 'memory' && category && !!rows.length && <Button disabled={busy} onClick={() => setSharing({ entries: rows.map((r) => own(r.id)), brains: [] })}>
          <Share2 size={14} />{t('分享此分类中的条目')}</Button>}
        {rows.map((row) => {
          const local = scope === 'local' ? own(row.id) : null;
          return <article className="knowledge-entry" key={`${row.brainID}:${row.nodeID}:${row.id}`}>
            <div className="knowledge-entry-main"><button className="knowledge-title" disabled={busy} onClick={() => void perform(() => read(row))}>{row.name}</button>
              <p>{row.description || t('暂无用途说明')}</p>
              <div className="knowledge-entry-meta"><span>{row.category}</span><span>{row.nodeName}</span><code title={row.revision}>{row.revision.slice(0, 10)}</code></div>
              {local && <small className="knowledge-sharing-state">{local.sharedBrains.length ? t('已分享给') + ' ' + local.sharedBrains.map((id) => library.brains.find((b) => b.id === id)?.name || id).join(', ') : t('仅本机可见')}</small>}
              {local?.error && <p role="status" className="knowledge-error">{knowledgeError(local.error)}</p>}
              {local && library.organization?.duplicates.some((group) => group.includes(local.id)) && <small>{t('存在相同正文，原始条目均已保留。')}</small>}
            </div>
            {local && <div className="knowledge-actions">
              <button disabled={busy} aria-label={t('管理分享')} title={t('管理分享')} onClick={() => setSharing({ entries: [local], brains: [...local.sharedBrains] })}><Share2 size={16} /></button>
              {tab === 'memory' && <button disabled={busy} aria-label={t('编辑记忆')} title={t('编辑记忆')} onClick={() => void perform(async () => {
                const v = await api<LocalKnowledgeEntry & { body: string }>(`/knowledge/memory/${row.id}`);
                setEditor({ id: v.id, expectedRevision: v.revision, name: v.name, description: v.description, category: v.category, body: v.body, projectID: v.projectID });
              })}><Pencil size={16} /></button>}
              <button disabled={busy} aria-label={t('移除条目')} title={t('移除条目')} onClick={() => setRemoving(local)}><Trash2 size={16} /></button>
            </div>}
          </article>;
        })}
        {!rows.length && <div className="knowledge-empty"><BookOpen size={30} /><p>{busy ? t('正在读取目录…') : t('此范围还没有匹配的内容。')}</p>
          {scope === 'local' && <small>{tab === 'skill' ? t('添加含 SKILL.md 的文件夹，再选择要分享的 Brain。') : t('按人物、工作、项目等分类保存记忆，正文按需读取。')}</small>}</div>}
        {shared.next !== null && scope !== 'local' && <Button disabled={busy} onClick={() => void perform(async () => {
          const result = await api<KnowledgeSearch>('/knowledge/search', { brainID: scope, kind: tab, text: query, category, offset: shared.next });
          setShared((old) => ({ ...result, entries: [...old.entries, ...result.entries] }));
        })}>{t('加载更多')}</Button>}
      </div>
    </div>
    {tab === 'memory' && <p className="knowledge-explainer">{t('记忆默认保留本机。自动整理更新分类索引并标记完全重复的内容，不额外调用模型，也不自动删除事实。')}</p>}
    </>}
    {register && <Modal title={t('添加 Skill')} close={() => close(() => setRegister(null))}>
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api('/knowledge/skills/register', register); await refresh(); setRegister(null); setNotice('registered'); }); }}>
        <Field label={t('Skill 文件夹')} hint={t('选择直接包含 SKILL.md 的目录，脚本和参考文件会按需取用。')}><input required value={register.directory} onChange={(e) => setRegister({ ...register, directory: e.target.value })} /></Field>
        {desktop && <Button disabled={busy} onClick={() => void perform(async () => { const directory = await chooseProjectDirectory(); if (directory) setRegister({ ...register, directory }); })}><FolderOpen size={15} />{t('选择文件夹')}</Button>}
        {projectField(register.projectID, (projectID) => setRegister({ ...register, projectID }))}
        <div className="modal-actions"><Button disabled={busy} onClick={() => setRegister(null)}>{t('取消')}</Button><Button type="submit" disabled={busy || !register.directory.trim()}>{t('添加')}</Button></div>
      </form>
    </Modal>}
    {editor && <Modal title={editor.id ? t('编辑记忆') : t('新建记忆')} close={() => close(() => setEditor(null))} className="knowledge-editor">
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api('/knowledge/memory', editor); await refresh(); setEditor(null); setNotice('saved'); }); }}>
        <Field label={t('名称')}><input required maxLength={120} value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /></Field>
        <Field label={t('用途摘要')} hint={t('Agent 先看到这段摘要，再决定是否读取正文。')}><input maxLength={600} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} /></Field>
        <Field label={t('分类路径')} hint={t('例如：人物/张三/信息，或人物/张三/工作。')}><input required maxLength={240} value={editor.category} onChange={(e) => setEditor({ ...editor, category: e.target.value })} /></Field>
        {projectField(editor.projectID, (projectID) => setEditor({ ...editor, projectID }))}
        <Field label={t('记忆正文')}><textarea required rows={10} maxLength={32_000} value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} /></Field>
        <div className="modal-actions">{editor.id && <Button disabled={busy} onClick={() => void perform(async () => {
          const revisions = await api<NonNullable<typeof history>['revisions']>(`/knowledge/history/${editor.id}`); setHistory({ name: editor.name, revisions });
        })}>{t('历史版本')}</Button>}<Button disabled={busy} onClick={() => setEditor(null)}>{t('取消')}</Button><Button type="submit" disabled={busy}>{t('保存')}</Button></div>
      </form>
    </Modal>}
    {sharing && <Modal title={t('管理分享')} subtitle={sharing.entries.length === 1 ? sharing.entries[0].name : t('为此分类当前显示的条目统一设置分享范围。')} close={() => close(() => setSharing(null))}>
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <p>{t('选中的 Brain 及其受信 Node 可以按需读取最新版。取消分享会阻止后续取用，已取走的内容无法远程收回。')}</p>
      <div className="knowledge-share-options">{library.brains.map((brain) => <label key={brain.id}><input type="checkbox" checked={sharing.brains.includes(brain.id)} onChange={(e) => setSharing({ ...sharing,
        brains: e.target.checked ? [...sharing.brains, brain.id] : sharing.brains.filter((id) => id !== brain.id) })} /><span>{brain.name}</span><small>{brain.online ? t('在线') : t('离线')}</small></label>)}</div>
      {!library.brains.length && <p>{t('尚无可分享的 Brain，请先完成节点连接。')}</p>}
      <div className="modal-actions"><Button disabled={busy} onClick={() => setSharing(null)}>{t('取消')}</Button><Button disabled={busy} onClick={() => void perform(async () => {
        await api('/knowledge/share-many', { entries: sharing.entries.map((v) => ({ id: v.id, revision: v.revision, updatedAt: v.updatedAt })), brains: sharing.brains });
        await refresh(); setSharing(null); setNotice('shared');
      })}>{t('保存分享范围')}</Button></div>
    </Modal>}
    {removing && <Modal title={t('移除条目')} subtitle={removing.name} close={() => close(() => setRemoving(null))}>
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <p>{removing.kind === 'skill' ? t('移除登记并取消分享，原 Skill 文件夹保留。') : t('移除此记忆及其历史版本，同时取消分享。')}</p>
      <div className="modal-actions"><Button disabled={busy} onClick={() => setRemoving(null)}>{t('取消')}</Button><Button disabled={busy} onClick={() => void perform(async () => {
        await api('/knowledge/remove', { id: removing.id, revision: removing.revision }); await refresh(); setRemoving(null);
      })}>{t('确认移除')}</Button></div>
    </Modal>}
    {reading && <Modal title={reading.entry.name} subtitle={reading.entry.revision.slice(0, 12)} close={() => setReading(null)} className="knowledge-editor">
      {reading.truncated ? <p>{t('正文过长，请通过任务按需加载文件。')}</p> : <MessageMarkdown text={reading.body} />}
      <details><summary>{t('附带文件')} · {reading.files.length}</summary><ul>{reading.files.map((f) => <li key={f.path}><code>{f.path}</code> · {f.bytes} B</li>)}</ul></details>
    </Modal>}
    {rules && <Modal title={t('编辑说明')} subtitle={rules.path} close={() => close(() => setRules(null))} className="knowledge-editor">
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api('/knowledge/rules/save', { projectID: rules.projectID, body: rules.body, revision: rules.revision }); setRules(null); setNotice('rules'); }); }}>
        <Field label={t('说明内容')}><textarea rows={15} maxLength={24_000} value={rules.body} onChange={(e) => setRules({ ...rules, body: e.target.value })} /></Field>
        <div className="modal-actions"><Button disabled={busy} onClick={() => setRules(null)}>{t('取消')}</Button><Button type="submit" disabled={busy}>{t('保存')}</Button></div>
      </form>
    </Modal>}
    {history && <Modal title={t('历史版本')} subtitle={history.name} close={() => setHistory(null)} className="knowledge-editor">
      {history.revisions.map((v) => <details key={v.revision}><summary>{new Date(v.updatedAt).toLocaleString()} · {v.revision.slice(0, 10)}</summary><small>{v.origin}</small><MessageMarkdown text={v.body} /></details>)}
    </Modal>}
  </section>;
}
