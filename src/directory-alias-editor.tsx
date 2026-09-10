import { useState } from 'react';
import { t } from '../shared/i18n.ts';
import { maximumDirectoryAliasLength, validDirectoryAlias } from '../shared/directory-aliases.ts';
import { Button, Field, Modal } from './ui';

export function DirectoryAliasEditor({ directory, alias, busy, failureMessage, save, close }: {
  directory: { key: string; label: string; name: string };
  alias: string;
  busy: boolean;
  failureMessage: string;
  save: (alias: string | null) => Promise<boolean>;
  close: () => void;
}) {
  const [value, setValue] = useState(alias);
  const [invalid, setInvalid] = useState(false);
  async function submit(alias: string | null) {
    if (busy) return;
    if (alias !== null && !validDirectoryAlias(alias)) { setInvalid(true); return; }
    setInvalid(false);
    if (await save(alias)) close();
  }
  return <Modal title={t('目录别名')} close={() => { if (!busy) close(); }}>
    <form className="directory-alias-editor" onSubmit={(event) => { event.preventDefault(); void submit(value.trim() || null); }}>
      <p className="directory-alias-location">{directory.label}</p>
      <Field label={t('别名')} hint={t('仅在本机显示，不改变真实目录或其他设备上的名称。清空后恢复目录名称。')}>
        <input autoFocus maxLength={maximumDirectoryAliasLength} value={value} disabled={busy}
          placeholder={directory.name} onChange={(event) => { setValue(event.target.value); setInvalid(false); }} />
      </Field>
      {invalid && <p className="error" role="alert">{t('别名最多 64 个字符，不能包含换行或控制字符。')}</p>}
      {failureMessage && <p className="error" role="alert">{t('目录别名未能保存，请重试。')}</p>}
      <div className="modal-actions">
        {alias && <Button disabled={busy} onClick={() => void submit(null)}>{t('恢复目录名称')}</Button>}
        <Button disabled={busy} onClick={close}>{t('取消')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? t('正在保存…') : t('保存')}</Button>
      </div>
    </form>
  </Modal>;
}
