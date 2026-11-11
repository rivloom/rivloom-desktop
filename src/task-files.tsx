import { t, systemText } from '../shared/i18n.ts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Paperclip, Download, RotateCw, X, FileText, Upload, FolderOpen, Copy, MoreHorizontal, ExternalLink } from 'lucide-react';
import { api } from './api';
import { desktop, chooseTaskFileDestination, revealTaskFile, openTaskFile } from './desktop';
import { ContextMenu, useContextMenu } from './context-menu';
import { FilePreview, FilePreviewButton } from './file-preview';
import { refreshTaskFileState, requestRemoteTaskFile, taskFileStates, useTaskFileState, type TaskFileState, type TaskFileQuery } from './use-task-file-state';
import { taskFileQueryKey } from './task-file-state';
import { uploadTaskFile, draftFilesReady, type DraftTaskFile } from './task-file-upload';
import { composerFileSelectionError, containsDroppedDirectory, isFileTransfer } from './composer-files';
import {
  taskFileBytesLabel,
  taskFileMaximumBytes,
  taskFileBatchBytes,
  taskFileUploadCount,
  type TaskFileDescriptor,
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
      !(target instanceof Element && target.closest('dialog, [role="dialog"]'));
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
                <strong title={item.file.name}>{item.state === 'complete' && item.descriptor ? <FilePreviewButton file={item.descriptor} path={`/task-files/uploads/${item.id}`} /> : item.file.name}</strong>
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
      { id: 'reveal', label: t('在文件夹中打开'), icon: <FolderOpen />, disabled: busy || !ready || !desktop, hint, select: () => action('reveal', file) },
      { id: 'save', label: t('另存为…'), icon: <Download />, disabled: busy || !ready, select: () => action('save', file) },
      { id: 'copy', label: t('复制路径'), icon: <Copy />, disabled: busy || !ready || !desktop, hint, select: () => action('copy', file) },
    ]} />
  </li>;
}

/** Necessary recovery actions stay outside the optional process disclosure. */
export function TaskFileRecovery({ states }: { states: readonly TaskFileState[] }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const operation = useRef(0), operating = useRef(false);
  const identity = states.map(state => taskFileQueryKey(state.route)).sort().join('|');
  useEffect(() => {
    operation.current++; operating.current = false; setBusy(false); setError('');
    return () => { operation.current++; operating.current = false; };
  }, [identity]);
  const unavailable = states.some(state => !!state.error || !!state.value && !state.fresh);
  const sendRoutes = new Map<string, TaskFileQuery>();
  const receiveFiles = new Map<string, { route: TaskFileQuery; fileID: string }>();
  let senderRequired = false;
  for (const state of states) {
    if (!state.fresh || !state.value?.canRetry) continue;
    for (const purpose of ['inputs', 'results'] as const) for (const file of state.value[purpose]) {
      if (file.deliveries.some(delivery => delivery.state === 'failed')) sendRoutes.set(taskFileQueryKey(state.route), state.route);
      if (file.state !== 'failed') continue;
      if (purpose === 'results' && state.route.scope === 'remote' && file.sourceNodeID)
        receiveFiles.set(`${taskFileQueryKey(state.route)}:${file.id}`, { route: state.route, fileID: file.id });
      else senderRequired = true;
    }
  }
  const canRetry = sendRoutes.size > 0 || receiveFiles.size > 0;
  useEffect(() => {
    if (!busy && error && !unavailable && !canRetry && !senderRequired && states.every(state => state.fresh)) setError('');
  }, [busy, error, unavailable, canRetry, senderRequired, states]);
  async function recover() {
    if (operating.current) return;
    if (unavailable) { states.forEach(state => refreshTaskFileState(state.route)); return; }
    const token = ++operation.current, epoch = taskFileStates.epoch();
    operating.current = true; setBusy(true); setError('');
    const errors: string[] = [];
    const current = () => operation.current === token && taskFileStates.epoch() === epoch;
    try {
      for (const route of sendRoutes.values()) {
        if (!current()) break;
        try { await api(`/task-files/${route.scope}/${route.taskID}/retry`, {}, { timeoutMilliseconds: 15_000 }); }
        catch (cause) { errors.push(cause instanceof Error ? cause.message : t('传输未能重试。')); }
        if (current()) refreshTaskFileState(route);
      }
      for (const { route, fileID } of receiveFiles.values()) {
        if (!current()) break;
        try { await requestRemoteTaskFile(route, fileID); }
        catch (cause) { errors.push(cause instanceof Error ? cause.message : t('文件取回未确认，请重试。')); }
      }
    } finally {
      if (current()) { operating.current = false; setBusy(false); setError([...new Set(errors)].join(' · ')); }
    }
  }
  if (!unavailable && !canRetry && !senderRequired && !error && !busy) return null;
  return <div className="task-file-recovery">
    {(unavailable || canRetry) && <button type="button" className="file-action activity-recovery-action" disabled={busy}
      onClick={() => void recover()}><RotateCw size={13} />{unavailable ? t('刷新文件状态') : t('重试传输')}</button>}
    {senderRequired && <span className="file-error">{t('请在发送设备重试失败附件。')}</span>}
    {error && <p className="file-error" role="alert">{systemText(error)}</p>}
  </div>;
}

export function TaskFilesPanel({ scope, taskID, resultsOnly = false, inputsOnly = false, nodeName = (id: string) => id, revision, enabled = true, lazy = false, manifest = [] }: {
  scope: TaskFileScope; taskID: string; resultsOnly?: boolean; nodeName?: (id: string) => string; revision?: unknown; enabled?: boolean;
  lazy?: boolean; manifest?: readonly TaskFileDescriptor[]; inputsOnly?: boolean;
}) {
  const path = `/task-files/${scope}/${taskID}`;
  const [activatedPath, setActivatedPath] = useState<string | null>(null);
  // Historical metadata is immutable; live round revisions must not revive its reads.
  const snapshot = useTaskFileState(scope, taskID, lazy ? undefined : revision, enabled && (!lazy || activatedPath === path));
  const value = snapshot.value, refreshError = snapshot.error;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DraftTaskFile[]>([]),
    [saved, setSaved] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<TaskFileView | null>(null);
  const openAfterReceive = useRef<{ path: string; fileID: string; fetchRequested: boolean } | null>(null);
  const operating = useRef(false);
  useEffect(() => {
    setError(''); setNotice(''); setSaved({}); setPreview(null); openAfterReceive.current = null;
  }, [path]);
  useEffect(() => {
    const pending = openAfterReceive.current;
    if (!snapshot.fresh || !pending || pending.path !== path) return;
    const file = value?.results.find(item => item.id === pending.fileID);
    if (file?.state === 'complete') { openAfterReceive.current = null; setPreview(file); }
    else if (file?.sourceNodeID && !pending.fetchRequested && ['remote', 'failed'].includes(file.state)) {
      pending.fetchRequested = true; void fetchRemote(file);
    } else if (!file || file.state === 'failed' && !pending.fetchRequested) {
      openAfterReceive.current = null; setError(file?.error || t('文件当前不可用，请稍后重试。'));
    }
  }, [path, snapshot.fresh, snapshot.revision, value]);
  function inspectResult(fileID: string) {
    if (!enabled || operating.current) return;
    setError(''); openAfterReceive.current = { path, fileID, fetchRequested: false };
    setActivatedPath(path); refreshTaskFileState({ scope, taskID });
  }
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
      refreshTaskFileState({ scope, taskID });
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
      await api(`${path}/retry`, {}, { timeoutMilliseconds: 15_000 });
      refreshTaskFileState({ scope, taskID });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('传输未能重试。'));
    } finally {
      operating.current = false; setBusy(false);
    }
  }
  async function fetchRemote(file: TaskFileView) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    const epoch = taskFileStates.epoch();
    const previewRequest = { path, fileID: file.id, fetchRequested: true };
    openAfterReceive.current = previewRequest;
    try {
      await requestRemoteTaskFile({ scope, taskID }, file.id);
    } catch (e) {
      if (taskFileStates.epoch() === epoch && openAfterReceive.current === previewRequest) {
        openAfterReceive.current = null;
        setError(e instanceof Error ? e.message : t('文件取回未确认，请重试。'));
      }
    }
    finally { operating.current = false; setBusy(false); }
  }
  const list = (items: TaskFileView[]) => (
    <ul className="task-file-links">
      {items.map((file) => (
        <TaskFileRow key={file.id} file={file} ready={!!value?.canSave && file.state === 'complete'} busy={busy}
          action={(kind, file) => void (kind === 'save' ? save(file) : locate(file, kind))}>
          <span className="file-details">
            {value?.canSave && file.state === 'complete' ? (
              <FilePreviewButton file={file} path={`${path}/${file.id}`} source={file.sourceNodeID ? nodeName(file.sourceNodeID) : undefined} />
            ) : file.sourceNodeID && ['remote', 'failed'].includes(file.state) ? (
              <button type="button" className="file-preview-button" disabled={busy}
                aria-label={t('取回并预览 {{name}}', { name: file.name })} onClick={() => void fetchRemote(file)}>{file.name}</button>
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
        </TaskFileRow>
      ))}
    </ul>
  );
  return (
    <section className="task-files-panel" aria-label={t('任务文件')}>
      {preview && <FilePreview file={preview} path={`${path}/${preview.id}`} source={preview.sourceNodeID ? nodeName(preview.sourceNodeID) : undefined} close={() => setPreview(null)} />}
      {notice && <p className="file-saved" role="status">{notice}</p>}
      {!inputsOnly && !value && manifest.length > 0 && <ul className="task-file-links">
        {manifest.map(file => <li key={file.id}><button type="button" className="file-preview-button"
          disabled={!enabled || busy || snapshot.loading} aria-label={t('查看文件 {{name}}', { name: file.name })}
          onClick={() => inspectResult(file.id)}>{file.name}</button></li>)}
      </ul>}
      {value && (
        <>
          {!inputsOnly && !!value.results.length && (
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
          {!resultsOnly && !inputsOnly && value.canPublish && (
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
            [...(resultsOnly ? [] : value.inputs), ...(inputsOnly ? [] : value.results)].some((f) =>
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
