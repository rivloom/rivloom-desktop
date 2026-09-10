import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { Modal } from './ui';
import { t } from '../shared/i18n.ts';
import { filePreviewType } from '../shared/file-preview.ts';
import type { TaskFileDescriptor } from '../shared/task-files.ts';
import './file-preview.css';

export function FilePreviewButton({ file, path, iconOnly = false }: { file: TaskFileDescriptor; path: string; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="file-preview-button" aria-label={t('预览 {{name}}', { name: file.name })}
    onClick={() => setOpen(true)}><Eye size={15} />{!iconOnly && file.name}</button>
    {open && <FilePreview file={file} path={path} close={() => setOpen(false)} />}</>;
}
function FilePreview({ file, path, close }: { file: TaskFileDescriptor; path: string; close: () => void }) {
  const type = filePreviewType(file.name); const url = `/api${path}/preview`;
  const [text, setText] = useState<string | null>(null); const [truncated, setTruncated] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (type.kind !== 'text') return;
    const controller = new AbortController();
    void fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async (res) => {
      if (!res.ok) throw new Error(t('预览暂时不可用，请下载后打开。'));
      const content = await res.text(); setText(content); setTruncated(res.headers.get('X-Preview-Truncated') === 'true');
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [url, type.kind]);
  return <Modal title={file.name} subtitle={t('文件预览')} close={close} className="file-preview-modal"><div className="file-preview-content">
    {error ? <p role="alert">{error}</p> : type.kind === 'text' ? <>
      {text === null ? <p>{t('正在读取…')}</p> : <pre>{text}</pre>}{truncated && <p className="muted">{t('仅预览前 256 KiB，完整内容请下载查看。')}</p>}
    </> : type.kind === 'image' ? <img src={url} alt={file.name} onError={() => setError(t('图片无法预览，请下载后打开。'))} />
      : type.kind === 'video' ? <video controls preload="metadata" src={url} onError={() => setError(t('此媒体暂时无法播放，请下载后打开。'))} />
      : type.kind === 'audio' ? <audio controls preload="metadata" src={url} onError={() => setError(t('此媒体暂时无法播放，请下载后打开。'))} />
      : <p>{t('此格式暂不支持预览，请下载后打开。')}</p>}
  </div></Modal>;
}
