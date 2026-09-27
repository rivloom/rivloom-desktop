import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Eye, Maximize2, Minimize2, Pencil, Download, FolderOpen, Copy, Quote, ExternalLink } from 'lucide-react';
import { Modal } from './ui';
import { useUnsavedActionGuard } from './unsaved-changes-confirm';
import { t } from '../shared/i18n.ts';
import { filePreviewType } from '../shared/file-preview.ts';
import { officeKind, type OfficeDocument } from '../shared/office-files.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';
import { MessageMarkdown } from './message-markdown';
import { api } from './api';
import { desktop, chooseTaskFileDestination, openTaskFile, revealTaskFile, openTaskFileWith, fileApplications } from './desktop';
import { officeMessage } from './office-messages';
import './file-preview.css';
const PdfPreview = lazy(() => import('./pdf-preview'));
export function FilePreviewButton({ file, path, iconOnly = false, source }: { file: TaskFileDescriptor; path: string; iconOnly?: boolean; source?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="file-preview-button" aria-label={t('预览 {{name}}', { name: file.name })}
    onClick={() => setOpen(true)}>{iconOnly && <Eye size={15} />}{!iconOnly && file.name}</button>
    {open && <FilePreview file={file} path={path} source={source} close={() => setOpen(false)} />}</>;
}
export function FilePreview({ file: initialFile, path: initialPath, source, close }: { file: Pick<TaskFileDescriptor, 'name' | 'bytes'>; path: string; source?: string; close: () => void }) {
  const [file, setFile] = useState(initialFile), [path, setPath] = useState(initialPath);
  const [applications, setApplications] = useState<string[]>([]);
  useEffect(() => { if (desktop) void fileApplications().then(setApplications).catch(() => {}); }, []);
  const [document, setDocument] = useState<OfficeDocument | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [documentError, setDocumentError] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [maximized, setMaximized] = useState(false);
  const [page, setPage] = useState(1), [sheet, setSheet] = useState(0), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [raw, setRaw] = useState(false), [editing, setEditing] = useState(false), [text, setText] = useState(''), [original, setOriginal] = useState(''), [expected, setExpected] = useState('');
  const [selectedText, setSelectedText] = useState(''), [query, setQuery] = useState(''), [selectedCell, setSelectedCell] = useState('');
  const [matches, setMatches] = useState(0);
  const content = useRef<HTMLDivElement>(null); const kind = officeKind(file.name), type = filePreviewType(file.name);
  const isProject = path.startsWith('/projects/'), dirty = editing && text !== original;
  const { request: guardUnsaved, confirmation } = useUnsavedActionGuard(dirty, busy);
  const requestClose = () => guardUnsaved(close);
  useEffect(() => {
    setSelectedCell(''); setSelectedText('');
  }, [path, page, sheet, offset]);
  useEffect(() => {
    if (!kind) return; const abort = new AbortController(); setLoading(true); setError(''); setDocumentError(false); setDocument(null);
    const params = new URLSearchParams({ page: String(page), sheet: String(sheet), offset: String(offset) });
    void fetch(`/api${path}/document?${params}`, { credentials: 'same-origin', signal: abort.signal }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.error || 'office_unavailable');
      if (!abort.signal.aborted) setDocument(value);
    }).catch(error => { if (!abort.signal.aborted) { setError(officeMessage(error.message)); setDocumentError(true); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [path, kind, page, sheet, offset, revision]);
  useEffect(() => {
    const selection = () => { const value = window.getSelection();
      setSelectedText(value?.anchorNode && value.focusNode && content.current?.contains(value.anchorNode) && content.current.contains(value.focusNode) ? value.toString().slice(0, 11000) : ''); };
    window.document.addEventListener('selectionchange', selection); return () => window.document.removeEventListener('selectionchange', selection);
  }, []);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  useEffect(() => {
    if (editing || kind === 'table' || !content.current || !('highlights' in CSS)) return;
    const update = () => {
      const ranges: Range[] = [], needle = query.toLocaleLowerCase();
      if (needle) for (const element of content.current!.querySelectorAll('.office-word, .office-markdown, pre, .textLayer')) {
        const walker = window.document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode()) && ranges.length < 200) {
          const text = (node.textContent || '').toLocaleLowerCase(); let from = 0, index: number;
          while ((index = text.indexOf(needle, from)) >= 0 && ranges.length < 200) {
            const range = window.document.createRange(); range.setStart(node, index); range.setEnd(node, index + needle.length); ranges.push(range); from = index + needle.length;
          }
        }
      }
      CSS.highlights.set('office-search', new Highlight(...ranges)); setMatches(ranges.length);
    };
    update(); const observer = new MutationObserver(update); observer.observe(content.current, { childList: true, subtree: true });
    return () => { observer.disconnect(); CSS.highlights.delete('office-search'); };
  }, [query, document, editing, kind]);
  async function act(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setDocumentError(false); setNotice('');
    try { await action(); } catch (cause) { setError(officeMessage(typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'office_unavailable')); } finally { setBusy(false); }
  }
  const location = () => api<{ path: string }>(`${path}/location`, {});
  const external = (application = 'default') => act(async () => { const value = await location();
    if (application === 'folder') await revealTaskFile(value.path);
    else if (application === 'copy') { await navigator.clipboard.writeText(value.path); setNotice(t('已复制到剪贴板')); }
    else if (application === 'default') await openTaskFile(value.path); else await openTaskFileWith(value.path, application);
  });
  const edit = () => act(async () => { const value = await api<{ text: string; revision: string }>(`${path}/text`);
    setText(value.text); setOriginal(value.text); setExpected(value.revision); setEditing(true); });
  const save = () => act(async () => {
    if (isProject) { const value = await api<{ revision: string }>(`${path}/save`, { text, expectedRevision: expected }); setExpected(value.revision); }
    else {
      const copyName = file.name.replace(/(\.[^.]+)$/, '-copy$1');
      const destination = desktop ? await chooseTaskFileDestination(copyName) : null;
      if (desktop && !destination) return;
      const value = await api<{ file: TaskFileDescriptor; path: string }>(`${path}/copy`, { text, expectedRevision: expected });
      if (destination) await api(`${value.path}/export`, { destination });
      else { const link = window.document.createElement('a'); link.href = `/api${value.path}/content`; link.download = copyName; link.click(); }
      setFile(value.file); setPath(value.path); setExpected(value.file.sha256);
    }
    setOriginal(text); setEditing(false); setOffset(0); setRevision(value => value + 1);
    setNotice(isProject ? t('文件已保存') : t('已保存为新副本，历史文件保持原样。'));
  });
  const saveAs = () => act(async () => {
    if (desktop) { const destination = await chooseTaskFileDestination(file.name); if (destination) { await api(`${path}/export`, { destination }); setNotice(t('文件已保存')); } }
    else { const a = window.document.createElement('a'); a.href = `/api${path}/content`; a.download = file.name; a.click(); }
  });
  const quote = () => {
    const selected = selectedText || selectedCell; if (!selected.trim()) return;
    const where = kind === 'pdf' ? `${t('页码')} ${page}` : document?.sheets ? `${document.sheets[sheet]?.name || ''}` : '';
    const detail = { text: `${file.name}${where ? ` · ${where}` : ''}\n${selected}`, accepted: false, onAccepted: requestClose };
    window.dispatchEvent(new CustomEvent('rivloom:file-quote', { detail })); if (detail.accepted) requestClose();
  };
  const rows = document?.rows || [], visibleRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => !query || row.some(cell => cell.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <><Modal title={file.name} subtitle={source || (isProject ? t('项目文件') : t('附件与成果预览'))} close={requestClose} className={`file-preview-modal${maximized ? ' maximized' : ''}`}>
    <div className="office-file-toolbar">
      <button title={maximized ? t('还原窗口') : t('最大化预览')} aria-label={maximized ? t('还原窗口') : t('最大化预览')} onClick={() => setMaximized(!maximized)}>{maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button disabled={busy || dirty} onClick={() => void saveAs()}><Download size={15} />{t('另存为')}</button>
      {desktop && <><button disabled={busy} onClick={() => void external('folder')}><FolderOpen size={15} />{t('在文件夹中打开')}</button>
        <label className="office-open-with"><ExternalLink size={15} /><select aria-label={t('打开方式')} value="" disabled={busy} onChange={event => void external(event.target.value)}>
          <option value="" disabled>{t('打开方式')}</option><option value="default">{t('默认应用')}</option>
          {/\.(pdf|txt|md|csv|tsv|json|log|png|jpe?g|gif|webp)$/i.test(file.name) && applications.map(app => <option value={app} key={app}>{app === 'chrome' ? 'Chrome' : 'Microsoft Edge'}</option>)}
          <option value="choose">{t('选择其他应用')}</option></select></label>
        <button disabled={busy} onClick={() => void external('copy')}><Copy size={15} />{t('复制路径')}</button></>}
      <button disabled={busy || !(selectedText || selectedCell)} onMouseDown={event => event.preventDefault()} onClick={quote}><Quote size={15} />{t('引用到聊天')}</button>
      {document?.editable && !editing && <button disabled={busy} onClick={() => void edit()}><Pencil size={15} />{t('编辑')}</button>}
      {kind === 'markdown' && !editing && <button onClick={() => setRaw(!raw)}>{raw ? t('排版预览') : t('查看源码')}</button>}
      {kind && kind !== 'table' && !editing && <label className="office-text-search"><input aria-label={t('查找本页内容')} placeholder={t('查找本页内容')} value={query} onChange={event => setQuery(event.target.value)} />{query && <span>{matches}{matches === 200 ? '+' : ''}</span>}</label>}
    </div>
    {notice && <p className="office-notice" role="status">{notice}</p>}{error && !(kind === 'pdf' && documentError) && <p className="office-error" role="alert">{error}{documentError && <button disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('重试')}</button>}</p>}
    {document?.warnings.map(code => <p className="office-warning" key={code}>{officeMessage(code)}</p>)}
    {loading && <p role="status">{t('正在读取…')}</p>}
    {editing ? <div className="office-text-editor"><textarea aria-label={t('文件内容')} value={text} spellCheck={false} onChange={event => setText(event.target.value)} disabled={busy} />
      <div className="office-document-controls"><span>{dirty ? t('尚未保存') : t('没有未保存的修改')}</span><button disabled={busy} onClick={() => guardUnsaved(() => setEditing(false))}>{t('取消')}</button>
        <button disabled={busy || !dirty} onClick={() => void save()}>{isProject ? t('保存文件') : t('保存为新副本')}</button></div></div>
      : <div className="file-preview-content" ref={content}>
        {kind === 'pdf' ? documentError ? <p className="office-error office-empty" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>{t('重试')}</button></p> : <Suspense fallback={<p>{t('正在读取…')}</p>}><PdfPreview key={revision} url={`/api${path}/preview`} page={page} retry={() => setRevision(value => value + 1)} changePage={value => { setPage(value); setOffset(0); }} /></Suspense>
        : document?.kind === 'table' ? <><div className="office-document-controls"><label>{t('工作表')} <select value={sheet} onChange={event => { setSheet(Number(event.target.value)); setOffset(0); setSelectedCell(''); }}>{document.sheets?.map((sheet, index) => <option key={index} value={index}>{sheet.name}</option>)}</select></label>
            <input aria-label={t('查找本页内容')} placeholder={t('查找本页内容')} value={query} onChange={event => setQuery(event.target.value)} />
            <span>{t('从第 {{row}} 行开始', { row: offset + 1 })}</span></div>
          <div className="office-table-scroll"><table className="office-table"><thead><tr><th>#</th>{Array.from({ length: document.columns || 0 }, (_, col) => <th key={col}>{columnName(col)}</th>)}</tr></thead><tbody>
            {visibleRows.map(({ row, index }) => <tr key={index}><th scope="row">{offset + index + 1}</th>{row.map((cell, col) => <td key={col}><button title={cell} aria-pressed={selectedCell === `${columnName(col)}${offset + index + 1}: ${cell}`} onClick={() => setSelectedCell(`${columnName(col)}${offset + index + 1}: ${cell}`)}>{cell || '\u00a0'}</button></td>)}</tr>)}
          </tbody></table></div>{!rows.length && <p className="office-empty" role="status">{t('此文件没有可显示的内容。')}</p>}{!!rows.length && !visibleRows.length && <p className="office-empty" role="status">{t('此范围还没有匹配的内容。')}<button onClick={() => setQuery('')}>{t('清空搜索')}</button></p>}{selectedCell && <p className="office-cell-value">{selectedCell}</p>}</>
        : document?.kind === 'word' && document.html ? <article className="office-word" dangerouslySetInnerHTML={{ __html: document.html }} />
        : document ? document.kind === 'markdown' && !raw ? <div className="office-markdown"><MessageMarkdown text={document.text} /></div> : <pre>{document.text || t('此文件没有可显示的内容。')}</pre>
        : type.kind === 'image' ? <ImagePreview url={`/api${path}/preview`} name={file.name} />
        : type.kind === 'video' ? <video controls preload="metadata" src={`/api${path}/preview`} onError={() => setError(t('此媒体暂时无法播放，请下载后打开。'))} />
        : type.kind === 'audio' ? <audio controls preload="metadata" src={`/api${path}/preview`} onError={() => setError(t('此媒体暂时无法播放，请下载后打开。'))} />
        : !kind && <p>{t('此格式暂不支持内置预览，请使用系统应用打开。')}</p>}
      </div>}
    {!editing && document && (offset > 0 || document.nextOffset !== undefined) && <div className="office-document-controls office-pagination"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - (document.kind === 'table' ? 100 : 24000)))}>{t('上一部分')}</button>
      <span>{document.truncated ? t('当前显示部分内容，可继续查看。') : t('已到末尾')}</span><button disabled={document.nextOffset === undefined} onClick={() => setOffset(document.nextOffset!)}>{t('下一部分')}</button></div>}
  </Modal>{confirmation}</>;
}
function columnName(column: number) { let name = ''; for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name; }
function ImagePreview({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState(1), [error, setError] = useState(false);
  return <><label className="office-document-controls">{t('缩放')} <input type="range" aria-label={t('缩放')} min="0.5" max="3" step="0.25" value={zoom} onChange={event => setZoom(Number(event.target.value))} />{zoom * 100}%</label>
    {error ? <p role="alert">{t('图片无法预览，请下载后打开。')}</p> : <div className="office-image-scroll"><img src={url} alt={name} style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }} onError={() => setError(true)} /></div>}</>;
}
