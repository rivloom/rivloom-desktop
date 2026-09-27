import { useState } from 'react';
import { t } from '../shared/i18n.ts';
import { Button, Modal } from './ui';

function UnsavedChangesConfirmation({ busy, discard, keep }: { busy: boolean; discard: () => void; keep: () => void }) {
  return <Modal title={t('放弃未保存的修改？')} close={keep} className="unsaved-changes-confirm">
    <p>{t('修改尚未保存。你可以继续编辑，或放弃修改后继续操作。')}</p>
    <div className="modal-actions"><Button disabled={busy} onClick={discard}>{t('放弃修改')}</Button>
      <Button variant="primary" onClick={keep}>{t('继续编辑')}</Button></div>
  </Modal>;
}

/** A successful save calls its own completion callback directly. Only user
 * attempts to leave the editor go through this guard. */
export function useUnsavedChangesGuard(dirty: boolean, busy: boolean, discard: () => void) {
  const guard = useUnsavedActionGuard(dirty, busy);
  return {
    requestClose: () => guard.request(discard),
    confirmation: guard.confirmation,
  };
}

/** Keep discard decisions inside the app: desktop window.confirm is not synchronous. */
export function useUnsavedActionGuard(dirty: boolean, busy: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  return {
    request: (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); },
    confirmation: pending ? <UnsavedChangesConfirmation busy={busy} keep={() => setPending(null)} discard={() => {
      if (busy) return;
      setPending(null); pending();
    }} /> : null,
  };
}
