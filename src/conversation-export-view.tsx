import { useMemo, useState } from 'react';
import { Download, FileJson, FileText } from 'lucide-react';
import type { Conversation } from '../shared/conversations';
import { t } from '../shared/i18n.ts';
import { Button, Field, Modal } from './ui';
import { conversationExportNotes, createConversationExportFile, exportVisibleConversation, type ConversationExportFormat } from './conversation-export';
import './conversation-export.css';

/** No request is made: the caller supplies a conversation from its authorized current view. */
export function ConversationExportDialog({ item, close }: { item: Conversation; close: () => void }) {
  const [format, setFormat] = useState<ConversationExportFormat>('markdown');
  const [state, setState] = useState<'idle' | 'started' | 'failed'>('idle');
  const document = useMemo(() => exportVisibleConversation(item), [item]);
  const file = useMemo(() => createConversationExportFile(document, format), [document, format]);
  function download() {
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
      anchor = window.document.createElement('a'); anchor.href = url; anchor.download = file.fileName;
      anchor.hidden = true; window.document.body.append(anchor); anchor.click();
      setState('started');
    } catch { setState('failed'); }
    finally {
      anchor?.remove();
      // WebView/browser downloads may consume the URL after the click handler returns.
      if (url) { const downloadURL = url; window.setTimeout(() => URL.revokeObjectURL(downloadURL), 30_000); }
    }
  }
  return <Modal title={t('导出会话')} subtitle={item.title} close={close} className="conversation-export-modal">
    <p className="muted">{t('保存这段会话的可见记录，不会发送到其他服务。')}</p>
    <Field label={t('导出格式')}>
      <select value={format} onChange={event => { setFormat(event.target.value as ConversationExportFormat); setState('idle'); }}>
        <option value="markdown">Markdown (.md)</option><option value="json">JSON (.json)</option>
      </select>
    </Field>
    <div className="conversation-export-file">{format === 'json' ? <FileJson size={18} /> : <FileText size={18} />}
      <span>{file.fileName}</span></div>
    <ul className="conversation-export-notes">{conversationExportNotes(document).map(note => <li key={note}>{note}</li>)}</ul>
    {state === 'started' && <p role="status">{t('已发起下载，请检查下载位置。')}</p>}
    {state === 'failed' && <p className="error" role="alert">{t('无法发起导出，请重试。')}</p>}
    <div className="modal-actions"><Button onClick={close}>{t('关闭')}</Button>
      <Button variant="primary" onClick={download}><Download size={15} />{t('下载导出文件')}</Button></div>
  </Modal>;
}
