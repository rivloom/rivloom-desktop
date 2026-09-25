import { t, systemText } from '../shared/i18n.ts';
import { reuseJson } from './desktop-refresh';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Paperclip, Download, RotateCw, X, FileText, Upload, FolderOpen, Copy, MoreHorizontal, ExternalLink } from 'lucide-react';
import { api } from './api';
import { desktop, chooseTaskFileDestination, revealTaskFile, openTaskFile } from './desktop';
import { ContextMenu, useContextMenu } from './context-menu';
import { FilePreviewButton } from './file-preview';
import { uploadTaskFile, draftFilesReady, type DraftTaskFile } from './task-file-upload';
import { composerFileSelectionError, containsDroppedDirectory, isFileTransfer } from './composer-files';
import {
  taskFileBytesLabel,
  taskFileMaximumBytes,
  taskFileBatchBytes,
  taskFileUploadCount,
  type TaskFileConversation,
  type TaskFileScope,
  type TaskFileView,
} from '../shared/task-files';
import './task-file-usage.css';

export function TaskFilePicker({
  files,
  onChange,
  disabled = false,
  unavailableReason,
  label = t('添加附件'),
  composer = false,
  children,
}: {
  files: DraftTaskFile[];
  onChange: (update: (previous: DraftTaskFile[]) => DraftTaskFile[]) => void;
  disabled?: boolean;
  unavailableReason?: string;
  label?: string;
  composer?: boolean;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null),
    running = useRef(new Set<string>());
  const latestFiles = useRef(files);
  latestFiles.current = files;
  const queue = useRef(Promise.resolve());
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const usageID = useId();
  const limitID = useId();
  const selectedBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const limits = t('单个文件最多 {{single}}；每批最多 {{count}} 个，合计 {{total}}。', {
    single: taskFileBytesLabel(taskFileMaximumBytes),
    count: taskFileUploadCount,
    total: taskFileBytesLabel(taskFileBatchBytes),
  });
  const usage = files.length
    ? t('已选 {{count}} / {{limit}} 个文件 · 合计 {{size}} / {{total}}', {
        count: files.length,
        limit: taskFileUploadCount,
        size: taskFileBytesLabel(selectedBytes),
        total: taskFileBytesLabel(taskFileBatchBytes),
      })
    : '';
  function updateFiles(update: (previous: DraftTaskFile[]) => DraftTaskFile[]) {
    latestFiles.current = update(latestFiles.current);
    onChange(update);
  }
  async function upload(item: DraftTaskFile) {
    if (running.current.has(item.id)) return;
    running.current.add(item.id);
    const update = (value: Partial<DraftTaskFile>) =>
      updateFiles((previous) => previous.map((f) => (f.id === item.id ? { ...f, ...value } : f)));
    update({ state: 'preparing', error: null });
    try {
      await uploadTaskFile(item, update);
    } catch (e) {
      update({ state: 'failed', error: e instanceof Error ? e.message : t('上传失败，请重试。') });
    } finally {
      running.current.delete(item.id);
    }
  }
  function enqueue(item: DraftTaskFile) {
    updateFiles(previous => previous.map(file => file.id === item.id ? { ...file, state: 'preparing', error: null } : file));
    queue.current = queue.current.then(() => upload(item));
  }
  function select(selected: FileList | File[] | null) {
    if (!selected?.length) return;
    if (disabled || unavailableReason) {
      setError(unavailableReason || t('当前无法添加附件，请稍后再试。'));
      return;
    }
    const chosen = [...selected];
    const selectionError = composerFileSelectionError(latestFiles.current.map(file => file.file), chosen);
    if (selectionError) {
      setError(selectionError);
      return;
    }
    setError('');
    const items: DraftTaskFile[] = chosen.map((file) => ({
      id: crypto.randomUUID(),
      file,
      state: 'preparing',
      receivedBytes: 0,
      error: null,
    }));
    updateFiles((previous) => [...previous, ...items]);
    setNotice(t('已添加 {{count}} 个附件', { count: items.length }));
    // Share one queue across selections, including files added while an upload runs.
    for (const item of items) enqueue(item);
  }
  const interactions = useRef({ select, disabled, unavailableReason });
  interactions.current = { select, disabled, unavailableReason };
  useEffect(() => {
    const form = composer ? input.current?.closest('form') : null;
    if (!form) return;
    const region = form.closest('.conversation-center') || form;
    const inside = (target: EventTarget | null) => target instanceof Node && region.contains(target) &&
      !(target instanceof Element && target.closest('[role="dialog"]'));
    const reset = () => { setDragging(false); form.classList.remove('file-drag-over'); };
    const paste = (event: ClipboardEvent) => {
      const selected = event.clipboardData?.files;
      if (!selected?.length) return;
      event.preventDefault(); interactions.current.select(selected);
    };
    const over = (event: DragEvent) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      // Prevent external files from navigating the WebView, including outside the composer.
      event.preventDefault();
      const accepted = inside(event.target) && !interactions.current.disabled && !interactions.current.unavailableReason;
      if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
      setDragging(accepted);
      form.classList.toggle('file-drag-over', accepted);
    };
    const leave = (event: DragEvent) => { if (!inside(event.relatedTarget)) reset(); };
    const drop = (event: DragEvent) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault(); reset();
      if (!inside(event.target) || !event.dataTransfer) return;
      if (containsDroppedDirectory(Array.from(event.dataTransfer.items))) {
        setError(t('暂不支持拖入文件夹，请选择其中的文件。')); return;
      }
      interactions.current.select(event.dataTransfer.files);
    };
    form.addEventListener('paste', paste);
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    region.addEventListener('dragleave', leave as EventListener);
    window.addEventListener('dragend', reset); window.addEventListener('blur', reset);
    return () => {
      form.removeEventListener('paste', paste);
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop);
      region.removeEventListener('dragleave', leave as EventListener);
      window.removeEventListener('dragend', reset); window.removeEventListener('blur', reset);
      form.classList.remove('file-drag-over');
    };
  }, [composer]);
  async function remove(item: DraftTaskFile) {
    if (latestFiles.current.find(file => file.id === item.id)?.removing) return;
    updateFiles(previous => previous.map(file => file.id === item.id ? { ...file, removing: true } : file));
    try {
      if (item.descriptor) await api(`/task-files/uploads/${item.id}/discard`, {});
      updateFiles((previous) => previous.filter((f) => f.id !== item.id));
      setError('');
      setNotice(t('已移除附件 {{name}}', { name: item.file.name }));
    } catch (e) {
      updateFiles(previous => previous.map(file => file.id === item.id ? { ...file, removing: false } : file));
      setError(e instanceof Error ? e.message : t('文件未能移除。'));
    }
  }
  const controls = (
    <>
      <div className={composer ? 'composer-input-tools' : 'task-file-picker-controls'}>
        <button
          type="button"
          className={composer ? `composer-tool composer-attach${files.length ? ' has-files' : ''}` : 'file-action'}
          data-state={files.some(file => file.state === 'failed') ? 'failed' : files.some(file => ['preparing', 'uploading'].includes(file.state)) ? 'uploading' : 'ready'}
          aria-label={label}
          title={unavailableReason || (composer ? `${label} · ${t('也可粘贴或拖入文件')}\n${limits}` : undefined)}
          aria-describedby={files.length ? `${limitID} ${usageID}` : limitID}
          disabled={disabled || !!unavailableReason}
          onClick={() => input.current?.click()}
        >
          <Paperclip size={16} aria-hidden="true" />
          {!composer && <span>{label}</span>}
          {composer && files.length > 0 && <span className="composer-file-count">{files.length}</span>}
        </button>
        <p
          id={usageID}
          className={composer ? 'composer-accessible-note' : 'task-file-usage'}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {usage}
        </p>
        {children}
      </div>
      <p className={composer ? 'composer-accessible-note' : 'task-file-limits'} id={limitID}>
        {limits}
      </p>
    </>
  );
  return (
    <div className={`task-file-picker${composer ? ' composer-file-picker' : ''}`}>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          select(e.target.files);
          e.target.value = '';
        }}
      />
      {!composer && controls}
      {composer && <span className="composer-accessible-note" role="status" aria-live="polite">{notice}</span>}
      {composer && dragging && <div className="composer-drop-overlay" role="status"><Paperclip size={22} /><strong>{t('松开以添加附件')}</strong><span>{t('文件会附在这条消息中')}</span></div>}
      {!!files.length && (
        <ul className="task-file-list" aria-label={t('已选文件')}>
          {files.map((item) => (
            <li key={item.id} data-state={item.state}>
              <FileText size={17} />
              <span className="file-details">
                <strong title={item.file.name}>{item.file.name}</strong>
                <small>
                  {taskFileBytesLabel(item.file.size)} ·{' '}
                  {item.removing ? t('正在移除') : item.state === 'complete'
                    ? t('已备妥')
                    : item.state === 'failed'
                      ? t('上传失败')
                      : item.state === 'preparing'
                        ? t('准备上传')
                        : t('上传 {{value1}}%', {
                            value1: Math.round(
                              (item.receivedBytes / Math.max(item.file.size, 1)) * 100,
                            ),
                          })}
                </small>
                {item.error && (
                  <span role="alert" className="file-error">
                    {systemText(item.error)}
                  </span>
                )}
                {['preparing', 'uploading'].includes(item.state) && <progress
                  aria-label={t('上传 {{name}}', { name: item.file.name })}
                  max={Math.max(item.file.size, 1)} value={item.receivedBytes} />}
              </span>
              {item.state === 'complete' && item.descriptor && <FilePreviewButton iconOnly file={item.descriptor} path={`/task-files/uploads/${item.id}`} />}
              {item.state === 'failed' && item.file.arrayBuffer && (
                <button
                  type="button"
                  disabled={disabled || item.removing}
                  aria-label={t('重试 {{value1}}', { value1: item.file.name })}
                  onClick={() => enqueue(item)}
                >
                  <RotateCw size={15} />
                </button>
              )}
              <button
                type="button"
                disabled={disabled || item.removing || ['preparing', 'uploading'].includes(item.state)}
                aria-label={t('移除 {{value1}}', { value1: item.file.name })}
                onClick={() => void remove(item)}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="file-error" role="alert">
          {systemText(error)}
        </p>
      )}
      {composer && controls}
    </div>
  );
}

function TaskFileRow({ file, ready, busy, action, children }: {
  file: TaskFileView; ready: boolean; busy: boolean; children: ReactNode;
  action: (kind: 'open' | 'reveal' | 'copy' | 'save', file: TaskFileView) => void;
}) {
  const menu = useContextMenu();
  const hint = !ready ? t('文件完整接收后可操作。') : !desktop ? t('请在桌面端操作本机文件。') : undefined;
  return <li onContextMenu={menu.context} onKeyDown={menu.keyboard} tabIndex={ready ? undefined : 0}>
    {children}
    <button type="button" className="context-more icon-button" aria-label={t('文件操作：{{name}}', { name: file.name })} title={t('更多操作')} {...menu.trigger}><MoreHorizontal size={15} /></button>
    <ContextMenu menu={menu} label={t('文件操作')} actions={[
      { id: 'open', label: t('打开'), icon: <ExternalLink />, disabled: busy || !ready || !desktop, hint, select: () => action('open', file) },
      { id: 'reveal', label: t('打开所在目录'), icon: <FolderOpen />, disabled: busy || !ready || !desktop, hint, select: () => action('reveal', file) },
      { id: 'save', label: t('另存为…'), icon: <Download />, disabled: busy || !ready, select: () => action('save', file) },
      { id: 'copy', label: t('复制路径'), icon: <Copy />, disabled: busy || !ready || !desktop, hint, select: () => action('copy', file) },
    ]} />
  </li>;
}

export function TaskFilesPanel({ scope, taskID, resultsOnly = false, nodeName = (id: string) => id }: {
  scope: TaskFileScope; taskID: string; resultsOnly?: boolean; nodeName?: (id: string) => string;
}) {
  const [value, setValue] = useState<TaskFileConversation | null>(null),
    [error, setError] = useState(''),
    [refreshError, setRefreshError] = useState(''),
    [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DraftTaskFile[]>([]),
    [saved, setSaved] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const operating = useRef(false);
  const path = `/task-files/${scope}/${taskID}`;
  useEffect(() => {
    setValue(null); setError(''); setNotice(''); setSaved({});
    let alive = true,
      polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api<TaskFileConversation>(path);
        if (alive) {
          setValue((previous) => reuseJson(previous, next));
          setRefreshError('');
        }
      } catch (e) {
        if (alive) setRefreshError(e instanceof Error ? e.message : t('文件状态未更新。'));
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path]);
  async function locate(file: TaskFileView, kind: 'open' | 'reveal' | 'copy') {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError(''); setNotice('');
    try {
      const result = await api<{ path: string }>(`${path}/${file.id}/location`, {});
      if (kind === 'open') await openTaskFile(result.path);
      else if (kind === 'reveal') await revealTaskFile(result.path);
      else {
        try { await navigator.clipboard.writeText(result.path); setNotice(t('已复制到剪贴板')); }
        catch { throw new Error(t('复制失败，请重试。')); }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : typeof e === 'string' && e ? e : t('文件操作失败，请重试。'));
    } finally {
      operating.current = false; setBusy(false);
    }
  }
  async function save(file: TaskFileView) {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError('');
    try {
      if (desktop) {
        const destination = await chooseTaskFileDestination(file.name);
        if (!destination) return;
        const result = await api<{ path: string }>(`${path}/${file.id}/export`, { destination });
        setSaved((old) => ({
          ...old,
          [file.id]: t('已保存至 {{value1}}', { value1: result.path }),
        }));
      } else {
        const link = document.createElement('a'); link.href = `/api${path}/${file.id}/content`; link.download = file.name;
        document.body.append(link); link.click(); link.remove();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : typeof e === 'string' && e ? e : t('文件保存失败。'));
    } finally {
      operating.current = false; setBusy(false);
    }
  }
  async function publish() {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`${path}/results`, { attachmentIDs: files.map((f) => f.id) });
      setFiles([]);
      setValue(await api(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('成果发布未确认，重试会保留原文件。'));
    } finally {
      operating.current = false; setBusy(false);
    }
  }
  async function retry() {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`${path}/retry`, {});
      setValue(await api(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('传输未能重试。'));
    } finally {
      operating.current = false; setBusy(false);
    }
  }
  async function fetchRemote(file: TaskFileView) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try { await api(`${path}/fetch`, { fileID: file.id }); setValue(await api(path)); }
    catch (e) { setError(e instanceof Error ? e.message : t('文件取回未确认，请重试。')); }
    finally { operating.current = false; setBusy(false); }
  }
  const list = (items: TaskFileView[]) => (
    <ul className="task-file-links">
      {items.map((file) => (
        <TaskFileRow key={file.id} file={file} ready={!!value?.canSave && file.state === 'complete'} busy={busy}
          action={(kind, file) => void (kind === 'save' ? save(file) : locate(file, kind))}>
          <span className="file-details">
            {file.state === 'complete' && <FilePreviewButton iconOnly file={file} path={`${path}/${file.id}`} />}
            {value?.canSave && file.state === 'complete' ? (
              desktop ? (
                <button
                  type="button"
                  className="task-file-link"
                  disabled={busy}
                  title={`${t('打开所在文件夹')} · ${taskFileBytesLabel(file.bytes)}`}
                  onClick={() => void locate(file, 'reveal')}
                >
                  {file.name}
                </button>
              ) : (
                <a
                  className="task-file-link"
                  href={`/api${path}/${file.id}/content`}
                  download={file.name}
                  title={t('下载 {{value1}}', { value1: file.name })}
                >
                  {file.name}
                </a>
              )
            ) : (
              <span className="task-file-name">{file.name}</span>
            )}
            {file.state !== 'complete' && (
              <small>
                {file.state === 'remote' ? t('保留在远端') : file.state === 'failed'
                  ? t('接收失败')
                  : t('接收 {{value1}}%', {
                      value1: Math.round((file.receivedBytes / Math.max(file.bytes, 1)) * 100),
                    })}
              </small>
            )}
            {file.deliveries
              .filter((d) => d.state !== 'complete')
              .map((d) => (
                <small key={d.peerNodeID}>
                  {d.state === 'failed'
                    ? t('传输失败')
                    : d.state === 'sending'
                      ? t('发送 {{value1}}%', {
                          value1: Math.round((d.bytes / Math.max(file.bytes, 1)) * 100),
                        })
                      : t('等待传输')}
                  {d.error && `(${systemText(d.error)})`}
                </small>
              ))}
            {file.error && <span className="file-error">{systemText(file.error)}</span>}
            {saved[file.id] && (
              <small className="file-saved" role="status" title={saved[file.id]}>
                {t('文件已保存')}
              </small>
            )}
          </span>
          {file.sourceNodeID && <small className="task-file-source" title={`${nodeName(file.sourceNodeID)} · ${file.sourcePath || file.name}`}>
            {nodeName(file.sourceNodeID)} · {file.sourcePath || file.name} · {taskFileBytesLabel(file.bytes)}
          </small>}
          {file.sourceNodeID && file.state !== 'complete' && <button type="button" className="file-action task-file-fetch"
            disabled={busy} onClick={() => void fetchRemote(file)}>
            <Download size={14} />{file.state === 'remote' ? t('取回到本机') : t('重试取回')}
          </button>}
          {value?.canSave && file.state === 'complete' && desktop && (
            <button
              type="button"
              className="task-file-save"
              disabled={busy}
              onClick={() => void save(file)}
              aria-label={t('保存 {{value1}}', { value1: file.name })}
              title={t('另存文件')}
            >
              <Download size={16} />
            </button>
          )}
        </TaskFileRow>
      ))}
    </ul>
  );
  return (
    <section className="task-files-panel" aria-label={t('任务文件')}>
      {notice && <p className="file-saved" role="status">{notice}</p>}
      {value && (
        <>
          {!!value.results.length && (
            <>
              {list(value.results)}
            </>
          )}
          {!resultsOnly && !!value.inputs.length && (
            <details className="task-files-secondary">
              <summary>
                {t('输入附件')} <span>{value.inputs.length}</span>
              </summary>
              {list(value.inputs)}
            </details>
          )}
          {!resultsOnly && value.canPublish && (
            <details className="task-files-secondary file-publish">
              <summary>{t('添加交付文件')}</summary>
              <TaskFilePicker
                files={files}
                onChange={setFiles}
                disabled={busy}
                label={t('选择成果文件')}
              />
              {!!files.length && (
                <button
                  type="button"
                  className="file-action"
                  disabled={busy || !draftFilesReady(files)}
                  onClick={() => void publish()}
                >
                  <Upload size={15} />
                  {t('发布所选成果')}
                </button>
              )}
            </details>
          )}
          {value.canRetry &&
            [...(resultsOnly ? [] : value.inputs), ...value.results].some((f) =>
              f.deliveries.some((d) => d.state === 'failed' || d.state === 'waiting'),
            ) && (
              <button
                type="button"
                className="file-action"
                disabled={busy}
                onClick={() => void retry()}
              >
                <RotateCw size={15} />
                {t('重试文件传输')}
              </button>
            )}
        </>
      )}
      {(error || refreshError) && (
        <p className="file-error" role="alert">
          {systemText(error || refreshError)}
        </p>
      )}
    </section>
  );
}
