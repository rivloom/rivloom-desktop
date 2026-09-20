import { useState } from 'react';
import { t } from '../shared/i18n.ts';
import { Button, Modal } from './ui';

function UnsavedChangesConfirmation({ busy, discard, keep }: { busy: boolean; discard: () => void; keep: () => void }) {
  return <Modal title={t('放弃未保存的修改？')} close={keep} className="unsaved-changes-confirm">
    <p>{t('这些修改尚未保存。你可以继续编辑，或确认放弃后关闭。')}</p>
    <div className="modal-actions"><Button disabled={busy} onClick={discard}>{t('放弃修改')}</Button>
      <Button variant="primary" onClick={keep}>{t('继续编辑')}</Button></div>
  </Modal>;
}

/** A successful save calls its own completion callback directly. Only user
 * attempts to leave the editor go through this guard. */
export function useUnsavedChangesGuard(dirty: boolean, busy: boolean, discard: () => void) {
  const [confirming, setConfirming] = useState(false);
  const keep = () => setConfirming(false);
  return {
    requestClose: () => { if (busy) return; if (dirty) setConfirming(true); else discard(); },
    confirmation: confirming ? <UnsavedChangesConfirmation busy={busy} keep={keep} discard={() => { if (!busy) { setConfirming(false); discard(); } }} /> : null,
  };
}
