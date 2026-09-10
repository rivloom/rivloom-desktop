import { t, systemText } from '../shared/i18n.ts';
import { reuseJson } from './desktop-refresh';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Paperclip, Download, RotateCw, X, FileText, Upload, FolderOpen, Copy, MoreHorizontal, ExternalLink } from 'lucide-react';
import { api } from './api';
import { desktop, chooseTaskFileDestination, revealTaskFile, openTaskFile } from './desktop';
import { ContextMenu, useContextMenu } from './context-menu';
import { FilePreviewButton } from './file-preview';
import { uploadTaskFile, draftFilesReady, type DraftTaskFile } from './task-file-upload';
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
  label = t('添加附件'),
  composer = false,
}: {
  files: DraftTaskFile[];
  onChange: (update: (previous: DraftTaskFile[]) => DraftTaskFile[]) => void;
  disabled?: boolean;
  label?: string;
  composer?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    running = useRef(new Set<string>());
  const [error, setError] = useState('');
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
  async function upload(item: DraftTaskFile) {
    if (running.current.has(item.id)) return;
    running.current.add(item.id);
    const update = (value: Partial<DraftTaskFile>) =>
      onChange((previous) => previous.map((f) => (f.id === item.id ? { ...f, ...value } : f)));
    update({ state: 'preparing', error: null });
    try {
      await uploadTaskFile(item, update);
    } catch (e) {
      update({ state: 'failed', error: e instanceof Error ? e.message : t('上传失败，请重试。') });
    } finally {
      running.current.delete(item.id);
    }
  }
  function select(selected: FileList | File[] | null) {
    if (!selected || disabled || running.current.size) return;
    const chosen = [...selected];
    if (
      files.length + chosen.length > taskFileUploadCount ||
      [...files.map((f) => f.file), ...chosen].reduce((n, f) => n + f.size, 0) > taskFileBatchBytes
    ) {
      setError(t('每批最多 5 个文件，合计 1000 MiB。'));
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
    onChange((previous) => [...previous, ...items]);
    // Bounded sequential uploads keep UI requests available during larger selections.
    void (async () => {
      for (const item of items) await upload(item);
    })();
  }
  useEffect(() => {
    const form = composer ? input.current?.closest('form') : null;
    if (!form) return;
    const paste = (event: ClipboardEvent) => {
      const selected = event.clipboardData?.files;
      if (!selected?.length || disabled) return;
      event.preventDefault(); select(selected);
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); if (!disabled) form.classList.add('file-drag-over');
    };
    const leave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !form.contains(event.relatedTarget)) form.classList.remove('file-drag-over'); };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); form.classList.remove('file-drag-over'); if (!disabled) select(event.dataTransfer.files);
    };
    form.addEventListener('paste', paste); form.addEventListener('dragover', over); form.addEventListener('dragleave', leave); form.addEventListener('drop', drop);
    return () => { form.removeEventListener('paste', paste); form.removeEventListener('dragover', over); form.removeEventListener('dragleave', leave); form.removeEventListener('drop', drop); form.classList.remove('file-drag-over'); };
  }, [composer, disabled, files, onChange]);
  async function remove(item: DraftTaskFile) {
    try {
      if (item.descriptor) await api(`/task-files/uploads/${item.id}/discard`, {});
      onChange((previous) => previous.filter((f) => f.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('文件未能移除。'));
    }
  }
  return (
    <div className="task-file-picker">
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
      <div className="task-file-picker-controls">
        <button
          type="button"
          className="file-action"
          aria-describedby={files.length ? `${limitID} ${usageID}` : limitID}
          disabled={
            disabled ||
            (!draftFilesReady(files) &&
              files.some((f) => ['preparing', 'uploading'].includes(f.state)))
          }
          onClick={() => input.current?.click()}
        >
          <Paperclip size={15} />
          {label}
        </button>
        <p
          id={usageID}
          className="task-file-usage"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {usage}
        </p>
      </div>
      <p className="task-file-limits" id={limitID}>
        {limits}
      </p>
      {!!files.length && (
        <ul className="task-file-list" aria-label={t('已选文件')}>
          {files.map((item) => (
            <li key={item.id}>
              <FileText size={17} />
              <span className="file-details">
                <strong>{item.file.name}</strong>
                <small>
                  {taskFileBytesLabel(item.file.size)} ·{' '}
                  {item.state === 'complete'
                    ? t('已备妥')
                    : item.state === 'failed'
                      ? t('上传失败')
                      : item.state === 'preparing'
                        ? t('正在校验')
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
              </span>
              {item.state === 'complete' && item.descriptor && <FilePreviewButton iconOnly file={item.descriptor} path={`/task-files/uploads/${item.id}`} />}
              {item.state === 'failed' && item.file.arrayBuffer && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t('重试 {{value1}}', { value1: item.file.name })}
                  onClick={() => void upload(item)}
                >
                  <RotateCw size={15} />
                </button>
              )}
              <button
                type="button"
                disabled={disabled || ['preparing', 'uploading'].includes(item.state)}
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

export function TaskFilesPanel({ scope, taskID, resultsOnly = false }: { scope: TaskFileScope; taskID: string; resultsOnly?: boolean }) {
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
                {file.state === 'failed'
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
              <p className="task-files-label">{t('交付成果')}</p>
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
