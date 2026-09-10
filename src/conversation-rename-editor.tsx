import { useState } from 'react';
import { t } from '../shared/i18n.ts';
import { maximumConversationTitleLength, validConversationTitle } from '../shared/conversation-preferences';
import { Button, Field, Modal } from './ui';

export function ConversationRenameEditor({ title, busy, failureMessage, save, close }: {
  title: string; busy: boolean; failureMessage: string; save: (title: string) => Promise<boolean>; close: () => void;
}) {
  const [value, setValue] = useState(title), [invalid, setInvalid] = useState(false);
  return <Modal title={t('重命名会话')} close={() => { if (!busy) close(); }}>
    <form onSubmit={(event) => {
      event.preventDefault(); if (busy) return;
      if (!validConversationTitle(value)) { setInvalid(true); return; }
      void save(value.trim()).then((ok) => { if (ok) close(); });
    }}>
      <Field label={t('会话名称')} hint={t('仅修改当前用户看到的名称，不改变任务要求。')}>
        <input autoFocus onFocus={(event) => event.currentTarget.select()} maxLength={maximumConversationTitleLength} value={value} disabled={busy}
          onChange={(event) => { setValue(event.target.value); setInvalid(false); }} />
      </Field>
      {invalid && <p className="error" role="alert">{t('请输入 1–160 个字符的会话名称，不含换行或控制字符。')}</p>}
      {failureMessage && <p className="error" role="alert">{t('会话名称未能保存，请重试。')}</p>}
      <div className="modal-actions"><Button disabled={busy} onClick={close}>{t('取消')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? t('正在保存…') : t('保存')}</Button></div>
    </form>
  </Modal>;
}
