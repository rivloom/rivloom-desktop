import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import { filterPromptTemplates, maximumPromptTemplates, maximumPromptTemplateText, maximumPromptTemplateTitle, validPromptTemplateInput, type PromptTemplate, type PromptTemplateList } from '../shared/prompt-templates';
import type { ConversationDraft } from './conversation-drafts';
import type { MessageReuseIntent } from './message-reuse';
import { MessageReuseActions } from './message-reuse-view';
import { api } from './api';
import { Button, Field, Modal } from './ui';
import { useUnsavedChangesGuard } from './unsaved-changes-confirm';
import './prompt-template-library.css';

type Editor = { id: string; title: string; text: string; revision: number | null; initialTitle: string; initialText: string };
export type PromptTemplateLibraryProps = {
  /** Current account identity, used only to clear UI state when the account changes. */
  scopeKey: string;
  draft: ConversationDraft;
  existingConversation: boolean;
  onApply: (intent: MessageReuseIntent) => boolean;
  close: () => void;
};
function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const labels: Record<string, string> = {
    prompt_template_invalid: t('模板名称需为 1–80 个字符，正文需为 1–12000 个字符。'),
    prompt_template_missing: t('模板已被删除或当前账号无法访问，请刷新列表。'),
    prompt_template_conflict: t('模板已在其他窗口修改。当前操作未覆盖它，你的编辑仍保留。'),
    prompt_template_limit: t('最多保存 100 个提示词模板，请先删除不再使用的模板。'),
  };
  return labels[code] || t('模板操作未完成，请重试；未保存的编辑仍保留。');
}
function starters() {
  return [
    { title: t('制定实施计划'), text: t('请根据当前目标和已有资料制定实施计划，说明需要确认的约束、具体步骤和验收方式。遇到信息缺口时明确列出，不要假设已经完成。') },
    { title: t('审查当前改动'), text: t('请审查当前改动，优先检查功能错误、回归风险和缺失的验证。说明具体位置、影响及建议；没有发现问题时也请明确说明检查范围。') },
    { title: t('整理研究结论'), text: t('请整理当前问题的主要结论、依据与尚不确定的部分，注明资料来源，最后列出可执行的下一步。') },
  ];
}

export function PromptTemplateLibrary({ scopeKey, draft, existingConversation, onApply, close }: PromptTemplateLibraryProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null), [removing, setRemoving] = useState<PromptTemplate | null>(null);
  const [latest, setLatest] = useState<PromptTemplate | null>(null);
  const editorGuard = useUnsavedChangesGuard(!!editor && (editor.title !== editor.initialTitle || editor.text !== editor.initialText), busy, () => setEditor(null));
  const generation = useRef(0), working = useRef(false);
  useEffect(() => {
    const current = ++generation.current, controller = new AbortController();
    setTemplates([]); setQuery(''); setEditor(null); setRemoving(null); setLatest(null); setError(''); setLoading(true); working.current = false; setBusy(false);
    void api<PromptTemplateList>('/prompt-templates', undefined, { signal: controller.signal }).then(value => {
      if (generation.current === current) setTemplates(value.templates);
    }).catch(failure => { if (!controller.signal.aborted && generation.current === current) setError(errorText(failure)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { controller.abort(); generation.current++; };
  }, [scopeKey]);
  const visible = useMemo(() => filterPromptTemplates(templates, query), [templates, query]);
  async function perform(action: () => Promise<void>) {
    if (working.current) return;
    const current = generation.current; working.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (generation.current === current) setError(errorText(failure)); }
    finally { if (generation.current === current) { working.current = false; setBusy(false); } }
  }
  async function refresh() {
    const current = generation.current, value = await api<PromptTemplateList>('/prompt-templates');
    if (generation.current === current) setTemplates(value.templates);
  }
  function create(title = '', text = '') { setError(''); setLatest(null); setEditor({ id: crypto.randomUUID(), revision: null, title, text, initialTitle: '', initialText: '' }); }
  const insert = (intent: MessageReuseIntent) => { const applied = onApply(intent); if (applied) close(); return applied; };
  const full = templates.length >= maximumPromptTemplates;
  return <Modal title={t('提示词模板')} close={() => { if (busy) return; if (editor) editorGuard.requestClose(); else if (removing) setRemoving(null); else close(); }} className="prompt-template-library">
    <p className="muted">{t('仅保存在本机当前账号。插入输入框后仍可编辑，不会自动发送或执行。')}</p>
    <div className="prompt-template-toolbar"><input aria-label={t('搜索提示词模板')} placeholder={t('搜索名称或正文')} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
      <Button disabled={busy || loading} onClick={() => void perform(refresh)}><RefreshCw size={14} />{t('刷新')}</Button>
      <Button disabled={busy || loading || full} onClick={() => create()}><Plus size={14} />{t('新建模板')}</Button></div>
    <div className="prompt-template-draft-action"><Button disabled={busy || loading || full || !validPromptTemplateInput({ title: 'draft', text: draft.text })} onClick={() => create('', draft.text)}><Save size={14} />{t('将当前草稿存为模板')}</Button></div>
    <p className="prompt-template-count">{templates.length} / {maximumPromptTemplates}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p role="status">{t('正在读取模板…')}</p> : <div className="prompt-template-list">
      {visible.map(template => <article className="prompt-template-card" key={template.id}>
        <div className="prompt-template-card-heading"><strong>{template.title}</strong><div className="prompt-template-actions">
          <button className="icon-button" type="button" disabled={busy} aria-label={t('编辑模板：{{title}}', { title: template.title })} title={t('编辑模板')}
            onClick={() => { setError(''); setLatest(null); setEditor({ ...template, initialTitle: template.title, initialText: template.text }); }}><Pencil size={15} /></button>
          <button className="icon-button" type="button" disabled={busy} aria-label={t('删除模板：{{title}}', { title: template.title })} title={t('删除模板')}
            onClick={() => { setError(''); setRemoving(template); }}><Trash2 size={15} /></button></div></div>
        <pre>{template.text}</pre><MessageReuseActions text={template.text} draft={draft} existingConversation={existingConversation}
          onApply={insert} disabled={busy} reuseLabel={t('插入草稿')} showQuote={false} iconOnly={false} />
      </article>)}
      {!visible.length && <p className="prompt-template-empty">{query.trim() ? t('没有匹配的模板。') : t('还没有保存模板。可以新建，或从下面的示例开始编辑。')}</p>}
    </div>}
    <details className="prompt-template-starters"><summary><BookOpen size={15} />{t('从常用示例开始')}</summary>
      <p className="muted">{t('示例只有在你编辑并保存后才会加入模板库。')}</p>
      <div>{starters().map(starter => <Button key={starter.title} disabled={busy || loading || full} onClick={() => create(starter.title, starter.text)}>{starter.title}</Button>)}</div>
    </details>
    {editor && <Modal title={editor.revision === null ? t('新建模板') : t('编辑模板')} close={editorGuard.requestClose} className="prompt-template-editor">
      <form onSubmit={event => {
        event.preventDefault(); if (!validPromptTemplateInput({ title: editor.title, text: editor.text })) return;
        const current = generation.current, savedEditor = editor;
        void perform(async () => {
          let saved: PromptTemplate;
          try {
            saved = await api<PromptTemplate>(savedEditor.revision === null ? '/prompt-templates' : `/prompt-templates/${savedEditor.id}`,
              { ...(savedEditor.revision === null ? { id: savedEditor.id } : { revision: savedEditor.revision }), title: savedEditor.title, text: savedEditor.text });
          } catch (failure) {
            if (failure instanceof Error && failure.message === 'prompt_template_conflict' && savedEditor.revision !== null) {
              const currentTemplate = await api<PromptTemplate>(`/prompt-templates/${savedEditor.id}`).catch(() => null);
              if (generation.current === current && currentTemplate) setLatest(currentTemplate);
            }
            throw failure;
          }
          if (generation.current !== current) return;
          setTemplates(previous => [saved, ...previous.filter(template => template.id !== saved.id)]); setEditor(null);
        });
      }}>
        <Field label={t('模板名称')}><input autoFocus required maxLength={maximumPromptTemplateTitle} value={editor.title} disabled={busy} onChange={event => setEditor({ ...editor, title: event.target.value })} /></Field>
        <Field label={t('模板正文')}><textarea required rows={10} maxLength={maximumPromptTemplateText} value={editor.text} disabled={busy} onChange={event => setEditor({ ...editor, text: event.target.value })} /></Field>
        <p className="prompt-template-count">{editor.text.length} / {maximumPromptTemplateText}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {latest && <details className="prompt-template-conflict" open><summary>{t('其他窗口保存的最新内容')}</summary><strong>{latest.title}</strong><pre>{latest.text}</pre>
          <Button disabled={busy || full} onClick={() => create(editor.title, editor.text)}>{t('将当前编辑另存为新模板')}</Button></details>}
        <div className="modal-actions"><Button disabled={busy} onClick={editorGuard.requestClose}>{t('取消')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !validPromptTemplateInput({ title: editor.title, text: editor.text })}>{busy ? t('正在保存…') : t('保存')}</Button></div>
      </form>
      {editorGuard.confirmation}
    </Modal>}
    {removing && <Modal title={t('删除提示词模板')} close={() => { if (!busy) setRemoving(null); }}>
      <p>{t('删除“{{title}}”？此操作不能撤销，已经插入的草稿和历史消息保持不变。', { title: removing.title })}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><Button disabled={busy} onClick={() => setRemoving(null)}>{t('取消')}</Button>
        <Button disabled={busy} onClick={() => {
          const current = generation.current, target = removing;
          void perform(async () => { await api(`/prompt-templates/${target.id}/delete`, { revision: target.revision });
            if (generation.current === current) { setTemplates(previous => previous.filter(template => template.id !== target.id)); setRemoving(null); } });
        }}>{t('确认删除模板')}</Button></div>
    </Modal>}
  </Modal>;
}
