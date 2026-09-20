import { useRef, useState } from 'react';
import { t } from '../shared/i18n.ts';
import { validWorkflowMessageEdit, type Workflow, type WorkflowMessage } from '../shared/workflows';
import { api } from './api';
import { Button, Field, Modal } from './ui';
import { useUnsavedChangesGuard } from './unsaved-changes-confirm';
import './pending-message-editor.css';

export type PendingMessageEditorProps = {
  workflowID: string;
  /** Snapshot selected when opening the editor, not overwritten by live refreshes. */
  message: WorkflowMessage;
  onSaved: (workflow: Workflow) => void;
  close: () => void;
};
export function PendingMessageEditor({ workflowID, message, onSaved, close }: PendingMessageEditorProps) {
  const snapshot = useRef({ workflowID, message });
  const [text, setText] = useState(message.text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false);
  const guard = useUnsavedChangesGuard(text !== snapshot.current.message.text, busy, close);
  const request = { requestID: snapshot.current.message.requestID, expectedText: snapshot.current.message.text, text };
  const valid = validWorkflowMessageEdit(request);
  return <Modal title={t('编辑待执行消息')} close={guard.requestClose} className="pending-message-editor">
    <p className="muted">{t('仅修改尚未开始执行的正文，附件和排队位置保持不变。保存不会继续已暂停的队列。')}</p>
    <form onSubmit={event => {
      event.preventDefault(); if (!valid || saving.current) return;
      saving.current = true; setBusy(true); setError('');
      void api<Workflow>(`/workflows/${snapshot.current.workflowID}/messages/edit`, request).then(value => { onSaved(value); close(); })
        .catch(failure => {
          const code = failure instanceof Error ? failure.message : '';
          setError(code === 'workflow_message_not_queued' ? t('这条消息已开始执行或已取消，无法修改。编辑内容仍保留，可复制后另发一条消息。')
            : code === 'workflow_message_edit_conflict' ? t('这条消息已在其他窗口修改，尚未覆盖。编辑内容仍保留，请复制后关闭并核对最新消息。')
            : code === 'workflow_message_edit_invalid' ? t('正文需为 1–12000 个字符，不能包含空字符。')
            : t('保存结果尚未确认，编辑内容仍保留。请重试或关闭后核对队列中的消息。'));
        }).finally(() => { saving.current = false; setBusy(false); });
    }}>
      <Field label={t('消息正文')}><textarea autoFocus required rows={10} maxLength={12_000} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></Field>
      <p className="pending-message-edit-count">{text.length} / 12000</p>
      {!!snapshot.current.message.inputFiles.length && <p className="muted">{t('保留 {{count}} 个附件。', { count: snapshot.current.message.inputFiles.length })}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="modal-actions"><Button disabled={busy} onClick={guard.requestClose}>{t('取消')}</Button><Button type="submit" variant="primary" disabled={busy || !valid || text === request.expectedText}>{busy ? t('正在保存…') : t('保存修改')}</Button></div>
    </form>
    {guard.confirmation}
  </Modal>;
}
