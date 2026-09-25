import { useState } from 'react';
import { PencilLine, Quote } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { ConversationDraft } from './conversation-drafts';
import { applyMessageReuse, type MessageReuseIntent, type MessageReuseMode, type MessageReusePlacement, type MessageReuseResult } from './message-reuse';
import { Button, Modal } from './ui';
import { CopyButton } from './copy-button';
import { splitQuotedMessage } from './message-quote';
import { MessageQuoteCard } from './message-quote-view';
import './message-reuse.css';

export type MessageReuseActionsProps = {
  text: string;
  draft: ConversationDraft;
  existingConversation: boolean;
  /** Recheck/apply this intent against the latest draft with applyMessageReuse; return false on conflict. */
  onApply: (intent: MessageReuseIntent) => boolean;
  disabled?: boolean;
  allowReuse?: boolean;
  reuseLabel?: string;
  showQuote?: boolean;
  iconOnly?: boolean;
  className?: string;
};
function failure(result: MessageReuseResult): string {
  if (result.ok) return '';
  if (result.reason === 'too-long') return t('加入后共 {{length}} 字符，超过 {{limit}} 字符限制；原草稿已保留。', { length: result.length!, limit: result.limit! });
  if (result.reason === 'draft-changed') return t('草稿已变化，请关闭后重新选择消息。');
  if (result.reason === 'confirmation-required') return t('当前已有草稿，请选择追加或替换正文。');
  return t('这条消息没有可复用的正文。');
}
export function MessageReuseActions({ text, draft, existingConversation, onApply, disabled = false, allowReuse = true, reuseLabel, showQuote = true, iconOnly = false, className = '' }: MessageReuseActionsProps) {
  const [selection, setSelection] = useState<Omit<MessageReuseIntent, 'placement' | 'replaceConfirmed'> | null>(null);
  const [error, setError] = useState('');
  const preview = (intent: MessageReuseIntent) => applyMessageReuse(draft, intent, existingConversation, () => draft.requestID);
  function apply(intent: MessageReuseIntent) {
    const result = preview(intent);
    if (!result.ok) { setError(failure(result)); return; }
    if (!onApply(intent)) { setError(t('草稿已变化，请关闭后重新选择消息。')); return; }
    setSelection(null); setError('');
  }
  function choose(mode: MessageReuseMode) {
    const selected = { text, mode, quoteAuthor: allowReuse ? 'user' as const : 'assistant' as const, expectedDraft: { text: draft.text, requestID: draft.requestID } };
    setError('');
    if (mode === 'reuse' && draft.text.length) setSelection(selected);
    else apply({ ...selected, placement: 'append' });
  }
  const candidate = (placement: MessageReusePlacement): MessageReuseIntent => ({ ...selection!, placement, replaceConfirmed: placement === 'replace' });
  const append = selection ? preview(candidate('append')) : null;
  const replace = selection ? preview(candidate('replace')) : null;
  return <span className={`message-reuse-actions ${className}`}>
    {showQuote && <CopyButton text={text} label={t('复制这条消息')} iconOnly={iconOnly} />}
    {showQuote && <button type="button" className={`message-reuse-button ${iconOnly ? '' : 'has-label'}`} title={t('引用这条消息')} aria-label={t('引用这条消息')}
      disabled={disabled || !text.trim()} onClick={() => choose('quote')}>{iconOnly ? <Quote size={13} /> : <span>{t('引用')}</span>}</button>}
    {allowReuse && <button type="button" className={`message-reuse-button ${iconOnly ? '' : 'has-label'}`} title={reuseLabel || t('重新编辑')} aria-label={reuseLabel || t('重新编辑')}
      disabled={disabled || !text.trim()} onClick={() => choose('reuse')}>{iconOnly ? <PencilLine size={13} /> : <span>{reuseLabel || t('重新编辑')}</span>}</button>}
    {!selection && error && <span className="message-reuse-error" role="alert">{error}</span>}
    {selection && <Modal title={reuseLabel || t('重新编辑')} close={() => { setSelection(null); setError(''); }} className="message-reuse-modal">
      <p>{t('原消息保持不变。选择如何放入输入框，确认发送后才会执行。')}</p>
      <p className="muted">{t('当前附件和设备选择会保留。')}</p>
      {splitQuotedMessage(selection.text).quote && <MessageQuoteCard quote={splitQuotedMessage(selection.text).quote!} />}
      <label className="field"><span>{t('要加入的正文')}</span><textarea readOnly value={splitQuotedMessage(selection.text).text} rows={6} /></label>
      {append && !append.ok && <p className="error" role="status">{failure(append)}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions"><Button onClick={() => { setSelection(null); setError(''); }}>{t('取消')}</Button>
        <Button disabled={disabled || !replace?.ok} onClick={() => apply(candidate('replace'))}>{t('替换草稿正文')}</Button>
        <Button variant="primary" disabled={disabled || !append?.ok} onClick={() => apply(candidate('append'))}>{t('追加到草稿')}</Button></div>
    </Modal>}
  </span>;
}
