import { Trash2, RotateCcw } from 'lucide-react';
import { t, language } from '../shared/i18n.ts';
import type { TrashEntry } from '../shared/conversation-history.ts';
import { Button } from './ui';

export function ConversationTrash({ entries, busy, restore, purge, empty }: {
  entries: TrashEntry[]; busy: boolean; restore: (entry: TrashEntry) => void;
  purge: (entry: TrashEntry) => void; empty: () => void;
}) {
  const date = (value: string) => new Date(value).toLocaleString(language(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <section className="conversation-trash" aria-label={t('回收站')}>
    <div className="trash-heading"><div><h2>{t('回收站')}</h2>
      <p>{t('移入后保留 3 个日历月，到期会在应用运行时自动永久删除。')}</p>
      <p>{t('清理会话记录和应用中的附件副本，项目文件保持不变。')}</p></div>
      <Button variant="danger" disabled={busy || !entries.length} onClick={empty}><Trash2 size={15} />{t('清空回收站')}</Button>
    </div>
    {entries.length ? <ul className="trash-list">{entries.map((entry) => <li key={entry.key}>
      <div className="trash-summary"><strong>{entry.title}</strong><span title={entry.directory}>{entry.directory}</span>
        <small>{t('移入时间：{{date}}', { date: date(entry.deletedAt) })}</small>
        <small>{entry.purging ? t('正在永久删除，未完成的清理会自动重试。') : t('自动删除：{{date}}', { date: date(entry.expiresAt) })}</small>
        {entry.cleanup?.state === 'failed' && <small role="status">{t('引擎历史清理尚未完成，记录保留等待重试。')} {entry.cleanup.error === 'runtime_busy' ? t('引擎会话仍在执行。') : entry.cleanup.error === 'runtime_shared' ? t('另一个保留的会话仍在使用此记录。') : t('请确认本机引擎可用后重试。')}</small>}
      </div><div className="trash-actions">
        <Button disabled={busy || entry.purging} onClick={() => restore(entry)}><RotateCcw size={15} />{t('恢复会话')}</Button>
        <Button variant="danger" disabled={busy} onClick={() => purge(entry)}><Trash2 size={15} />{entry.cleanup ? t('重试清理') : t('永久删除')}</Button>
      </div></li>)}</ul> : <div className="trash-empty"><Trash2 size={30} /><h3>{t('回收站为空')}</h3><p>{t('删除的会话会先移到这里，你可以在保留期内恢复。')}</p></div>}
  </section>;
}
