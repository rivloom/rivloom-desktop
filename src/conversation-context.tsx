import { useEffect, useRef, useState } from 'react';
import { t } from '../shared/i18n.ts';
import type { Conversation } from '../shared/conversations.ts';
import type { Task } from '../shared/types.ts';
import type { ContextNote, HistoryRead } from '../shared/workflow-history.ts';
import type { TaskContextRecord } from '../shared/task-context.ts';
import type { WorkflowMemoryLink, KnowledgeUsagePage } from '../shared/knowledge.ts';
import { workflowAllSteps } from '../shared/workflows.ts';
import { api } from './api';
import { Button, Field, Modal } from './ui';
import './conversation-context.css';

type Source = { id: string; revision: string; content: string };
type State = { version: number; round: number; goal: Source; criteria: Source; notes: ContextNote[] };
type Run = { task: Task; records: TaskContextRecord[]; total: number; usage: KnowledgeUsagePage };
type Snapshot = { state: State | null; reads: HistoryRead[]; memories: WorkflowMemoryLink[]; runs: Run[] };
type Edit = { note?: ContextNote; kind: ContextNote['kind']; text: string; source: ContextNote['source'] };
export function ConversationContext({ item, tasks, owner, close }: {
  item: Conversation; tasks: Task[]; owner: boolean; close: () => void;
}) {
  const [data, setData] = useState<Snapshot | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [tab, setTab] = useState<'state' | 'reads' | 'runs'>('state');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [promote, setPromote] = useState<ContextNote | null>(null), [name, setName] = useState('');
  const [targetMemory, setTargetMemory] = useState('');
  const [source, setSource] = useState<(Source & { nextOffset: number | null }) | null>(null);
  const [audit, setAudit] = useState<ContextNote[] | null>(null);
  const base = item.workflow ? `/workflows/${item.workflow.id}` : '';
  const requests = useRef(new Map<string, string>());
  const write = (path: string, body: Record<string, unknown>) => {
    const key = JSON.stringify([path, body]);
    let requestID = requests.current.get(key);
    if (!requestID) { requestID = crypto.randomUUID(); requests.current.set(key, requestID); }
    // A response may be lost after persistence. Retry the same intent with the same identity.
    return api(path, { ...body, requestID });
  };
  const load = async () => {
    const ids = new Set(item.workflow ? workflowAllSteps(item.workflow).flatMap(s => s.attempts.filter(a => a.kind === 'local').map(a => a.executionID)) : [item.localTask?.id]);
    const local = tasks.filter(task => ids.has(task.id)).slice(0, 20);
    const [state, reads, memories, runs] = await Promise.all([
      base ? api<State>(`${base}/context`) : null, base ? api<HistoryRead[]>(`${base}/context/reads`) : [],
      base && owner ? api<WorkflowMemoryLink[]>(`${base}/context/memory`) : [],
      Promise.all(local.map(async task => {
        const [context, usage] = await Promise.all([api<{ records: TaskContextRecord[]; total: number }>(`/tasks/${task.id}/context`), api<KnowledgeUsagePage>(`/tasks/${task.id}/context/knowledge`)]);
        return { task, ...context, usage };
      })),
    ]);
    setData({ state, reads, memories, runs });
    setAudit(null);
  };
  useEffect(() => { setBusy(true); load().catch(e => setError(e.message)).finally(() => setBusy(false)); }, [item.key]);
  const act = async (work: () => Promise<unknown>, refresh = true) => {
    if (busy) return; setBusy(true); setError('');
    try { await work(); if (refresh) await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const readSource = (ref: ContextNote['source'], offset = 0) => act(async () => {
    const page = await api<Source & { nextOffset: number | null }>(`${base}/history`, { action: 'read', id: ref.id, revision: ref.revision, offset });
    setSource(previous => ({ ...page, content: offset && previous?.id === page.id && previous.revision === page.revision ? previous.content + page.content : page.content }));
  }, false);
  const short = (revision: string) => revision.slice(0, 12);
  const state = data?.state;
  return <Modal title={t('会话上下文')} subtitle={item.title} close={close} className="context-panel">
    <div className="context-toolbar" aria-label={t('上下文视图')}>
      <Button disabled={tab === 'state'} onClick={() => setTab('state')}>{t('目标与记忆')}</Button>
      <Button disabled={tab === 'reads'} onClick={() => setTab('reads')}>{t('读取记录')}</Button>
      <Button disabled={tab === 'runs'} onClick={() => setTab('runs')}>{t('执行与压缩')}</Button>
      <Button disabled={busy} onClick={() => void act(async () => {})}>{t('刷新')}</Button>
    </div>
    {error && <p role="alert" className="context-error">{error}</p>}
    {busy && <p role="status">{t('正在加载…')}</p>}
    <div className="context-scroll" aria-busy={busy}>
      {tab === 'state' && <>
        <section><h3>{t('当前目标')}</h3><p className="context-text">{(state?.goal.content || item.description).slice(0, 300)}</p>
          {(state?.goal.content || item.description).length > 300 && <details className="context-goal"><summary>{t('展开完整目标')}</summary><p className="context-text">{state?.goal.content || item.description}</p></details>}
          {state?.criteria.content && <p className="context-text">{state.criteria.content}</p>}
          <p className="context-hint">{t('当前要求优先于历史与知识参考。修改条目会用于后续读取和执行，已发给模型的内容无法收回。')}</p></section>
        {state ? <section><div className="context-heading"><h3>{t('会话约束与决定')}</h3>
          <Button disabled={busy} onClick={() => { setPromote(null); setEdit({ kind: 'constraint', text: '', source: { id: state.goal.id, revision: state.goal.revision, quote: state.goal.content.slice(0, 200) } }); }}>{t('添加确认条目')}</Button></div>
          {!state.notes.length && <p className="context-hint">{t('尚无确认或推断条目。可以从当前要求中引用原文，明确保留约束和决定。')}</p>}
          {state.notes.map(note => <article className="context-card" key={note.id}>
            <div className="context-heading"><strong>{note.kind === 'constraint' ? t('约束') : t('决定')}</strong><span className={`context-badge ${note.authority}`}>{note.authority === 'user' ? t('用户已确认') : t('模型推断')}</span></div>
            <p className="context-text">{note.text}</p><blockquote>{note.source.quote}</blockquote><small>{t('来源版本：{{revision}}', { revision: short(note.source.revision) })}</small>
            <div className="context-actions">
              <Button disabled={busy} onClick={() => void readSource(note.source)}>{t('查看原文')}</Button>
              <Button disabled={busy} onClick={() => { setPromote(null); setEdit({ note, kind: note.kind, text: note.text, source: { ...note.source } }); }}>{note.authority === 'user' ? t('修正条目') : t('确认或修正')}</Button>
              <Button disabled={busy} onClick={() => void act(() => write(`${base}/context/notes/withdraw`, { id: note.id, expectedVersion: state.version }))}>{t('使条目失效')}</Button>
              {owner && note.authority === 'user' && <Button disabled={busy || !item.workflow?.projectID} onClick={() => { setEdit(null); setPromote(note); setName(note.text.slice(0, 80)); setTargetMemory(''); }}>{t('保存到项目记忆')}</Button>}
            </div>
          </article>)}
          {!item.workflow?.projectID && <p className="context-hint">{t('此会话没有关联项目，不能保存为项目记忆。')}</p>}
          <Button disabled={busy} onClick={() => void act(async () => {
            const result = await api<{ notes: ContextNote[] }>(`${base}/context/notes?offset=0`); setAudit(result.notes);
          }, false)}>{t('查看条目变更记录')}</Button>
          {audit && <details open><summary>{t('条目变更记录')}</summary>{audit.map(note => <article className="context-card" key={note.id}>
            <p>{note.text}</p><small>{note.authority === 'user' ? t('用户已确认') : t('模型推断')} · {note.withdrawn ? t('已撤回') : note.supersededBy ? t('已被替代') : t('有效')} · {new Date(note.createdAt).toLocaleString()}</small><blockquote>{note.source.quote}</blockquote>
          </article>)}{audit.length > 0 && audit.length % 50 === 0 && <Button disabled={busy} onClick={() => void act(async () => {
            const result = await api<{ notes: ContextNote[] }>(`${base}/context/notes?offset=${audit.length}`); setAudit([...audit, ...result.notes]);
          }, false)}>{t('加载更多')}</Button>}</details>}
          {edit && <form className="context-card context-editor" onSubmit={event => { event.preventDefault(); void act(async () => {
            await write(`${base}/context/notes`, { expectedVersion: state.version, kind: edit.kind, text: edit.text, source: edit.source, ...(edit.note ? { supersedes: edit.note.id } : {}) }); setEdit(null);
          }); }}>
            <h4>{t('确认会话条目')}</h4><Field label={t('类型')}><select disabled={busy} value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as Edit['kind'] })}><option value="constraint">{t('约束')}</option><option value="decision">{t('决定')}</option></select></Field>
            <Field label={t('条目内容')}><textarea disabled={busy} autoFocus required maxLength={600} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} /></Field>
            <Field label={t('来源原文摘录')} hint={t('摘录必须与所选来源原文一致，保存时会校验。')}><textarea disabled={busy} required maxLength={1000} value={edit.source.quote} onChange={e => setEdit({ ...edit, source: { ...edit.source, quote: e.target.value } })} /></Field>
            <div className="context-actions"><Button type="submit" variant="primary" disabled={busy || !edit.text.trim() || !edit.source.quote.trim()}>{t('确认并保存')}</Button><Button disabled={busy} onClick={() => setEdit(null)}>{t('取消')}</Button></div>
          </form>}
          {promote && <form className="context-card context-editor" onSubmit={event => { event.preventDefault(); void act(async () => {
            const memory = data?.memories.find(m => m.id === targetMemory);
            await write(`${base}/context/memory`, { expectedVersion: state.version, noteID: promote.id, name, description: promote.text, category: 'context', ...(memory ? { id: memory.id, expectedRevision: memory.revision } : {}) }); setPromote(null);
          }); }}>
            <h4>{t('保存到项目记忆')}</h4><p>{t('保留来源与确认记录，仅存入当前项目。分享仍由知识库中的分享设置控制。')}</p>
            <Field label={t('名称')}><input disabled={busy} autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></Field>
            <Field label={t('保存方式')}><select disabled={busy} value={targetMemory} onChange={e => setTargetMemory(e.target.value)}><option value="">{t('新增项目记忆')}</option>{data?.memories.filter(m => m.status !== 'withdrawn').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
            <div className="context-actions"><Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t('确认并保存')}</Button><Button disabled={busy} onClick={() => setPromote(null)}>{t('取消')}</Button></div>
          </form>}
        </section> : <p className="context-hint">{t('此会话没有协作上下文档案；可查看本机执行记录。')}</p>}
        {!!data?.memories.length && <section><h3>{t('关联项目记忆')}</h3>{data.memories.map(memory => <article className="context-card" key={memory.id}><strong>{memory.name}</strong><p>{memory.provenance.text}</p>
          <small>{memory.status === 'withdrawn' ? t('已撤回') : memory.status === 'changed' ? t('内容已变更，请核对') : t('有效')} · {short(memory.revision)}</small>
          {memory.status !== 'withdrawn' && <div className="context-actions"><Button disabled={busy} onClick={() => void act(() => write(`${base}/context/memory/withdraw`, { id: memory.id, expectedRevision: memory.revision }))}>{t('撤回项目记忆')}</Button></div>}
        </article>)}<p className="context-hint">{t('撤回后不再供后续知识读取；旧版本与已经读取的会话记录仍保留。会话条目和项目记忆分别管理。')}</p></section>}
        {source && <section className="context-source"><h3>{t('来源原文')}</h3><small>{short(source.revision)}</small><pre>{source.content}</pre>
          {source.nextOffset !== null && <Button disabled={busy} onClick={() => void readSource({ ...source, quote: '' }, source.nextOffset!)}>{t('读取下一页')}</Button>}
          <Button onClick={() => setSource(null)}>{t('收起原文')}</Button></section>}
      </>}
      {tab === 'reads' && <>
        <p className="context-hint">{t('记录成功处理的工具读取，不代表模型已经理解。搜索命中不计入；手动查看原文也不计入。历史最多显示最近 200 页，知识记录来自本机执行。')}</p>
        <section><h3>{t('历史原文读取')}</h3>{!data?.reads.length && <p>{t('暂无读取记录')}</p>}
          {data?.reads.map(read => <article className="context-card" key={read.id}><code>{read.sourceID}</code><p>{t('字符范围 {{start}}–{{end}} / {{total}}', { start: read.offset, end: read.nextOffset ?? read.totalCharacters, total: read.totalCharacters })} · {read.contentBytes.toLocaleString()} B</p><small>{short(read.revision)} · {new Date(read.at).toLocaleString()}</small></article>)}
        </section>
        <section><h3>{t('Wiki 与记忆读取')}</h3>{!data?.runs.some(run => run.usage.entries.length) && <p>{t('暂无读取记录')}</p>}
          {data?.runs.map(run => <div key={run.task.id}>{run.usage.entries.map(entry => <article className="context-card" key={entry.id}><strong>{entry.name}</strong><p>{entry.file} · {entry.operation === 'read' ? t('读取') : t('准备文件')}</p>
            {entry.totalCharacters !== null && <p>{t('字符范围 {{start}}–{{end}} / {{total}}', { start: entry.offset, end: entry.nextOffset ?? entry.totalCharacters, total: entry.totalCharacters })}</p>}
            <small>{short(entry.revision)} · {new Date(entry.at).toLocaleString()} · {entry.contentBytes.toLocaleString()} B</small></article>)}
            {run.usage.nextOffset !== null && <Button disabled={busy} onClick={() => void act(async () => {
              const more = await api<KnowledgeUsagePage>(`/tasks/${run.task.id}/context/knowledge?offset=${run.usage.nextOffset}`);
              setData(previous => previous && { ...previous, runs: previous.runs.map(r => r.task.id === run.task.id ? { ...r, usage: { ...more, entries: [...r.usage.entries, ...more.entries] } } : r) });
            }, false)}>{t('加载更多')}</Button>}
          </div>)}
        </section>
      </>}
      {tab === 'runs' && <>
        <p className="context-hint">{t('显示最近 20 个本机执行，每次执行最多 20 轮记录和最近 50 次检查。这里核对规则准备与压缩续聊，不是完整模型输入或 token 统计。远端执行需在执行设备查看。')}</p>
        {!data?.runs.some(run => run.records.length) && <p>{t('暂无执行上下文记录')}</p>}
        {data?.runs.map(run => run.records.map(record => <article className="context-card" key={record.id}><strong>{run.task.title}</strong><small>{new Date(record.createdAt).toLocaleString()}</small>
          <p>{t('带入来源 {{count}} 项；连续性检查 {{checks}} 次', { count: record.sources.length, checks: record.observationCount })}</p>
          <ul>{record.sources.map((s, i) => <li key={i}>{sourceLabel(s.kind)} · {s.bytes.toLocaleString()} B · <code>{short(s.revision)}</code>{s.inclusion === 'reference' && ` · ${t('仅引用')}`}</li>)}</ul>
          {record.observations.map((o, i) => <p key={i}>{o.kind === 'compaction' ? t('准备压缩摘要') : o.system === 'restored' ? t('压缩后已恢复规则') : o.system === 'matched' ? t('规则版本匹配') : t('规则检查异常')} · {new Date(o.at).toLocaleTimeString()}{o.selectedMessages !== undefined && ` · ${t('选入 {{count}} 条消息', { count: o.selectedMessages })}`}</p>)}
        </article>))}
      </>}
    </div>
  </Modal>;
}
function sourceLabel(kind: string) {
  const names: Record<string, string> = { policy: t('执行规则'), 'knowledge-guide': t('知识读取指引'), 'project-rules': t('项目规则'),
    'account-history': t('账号切换历史'), request: t('用户要求'), attachment: t('附件引用') };
  return names[kind] || kind;
}
