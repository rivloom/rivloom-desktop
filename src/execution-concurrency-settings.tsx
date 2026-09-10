import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import { maximumRemoteConcurrency, minimumRemoteConcurrency } from '../shared/execution-concurrency.ts';
import type { NodeExecutionPolicy } from '../shared/types.ts';
import { api } from './api';
import { Button, Field } from './ui';

export function ExecutionConcurrencySettings({ policy, onChanged }: {
  policy: NodeExecutionPolicy;
  onChanged: () => void;
}) {
  const [saved, setSaved] = useState(policy.maxConcurrent);
  const [draft, setDraft] = useState(policy.maxConcurrent);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const previous = useRef(policy.maxConcurrent);
  useEffect(() => {
    if (previous.current === policy.maxConcurrent) return;
    const old = previous.current;
    previous.current = policy.maxConcurrent;
    setSaved(policy.maxConcurrent);
    setDraft((value) => value === old ? policy.maxConcurrent : value);
  }, [policy.maxConcurrent]);
  return <form className="execution-concurrency-settings" onSubmit={async (event) => {
    event.preventDefault();
    if (pending || draft === saved) return;
    setPending(true);
    setError('');
    setConfirmed(false);
    try {
      const result = await api<NodeExecutionPolicy>('/network/execution-concurrency', { maxConcurrent: draft });
      setSaved(result.maxConcurrent);
      setDraft(result.maxConcurrent);
      setConfirmed(true);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setPending(false); }
  }}>
    <div className="concurrency-current" aria-label={t('当前并发设置')}>
      <div><span>{t('本机任务')}</span><strong>{t('不设固定上限')}</strong></div>
      <div><span>{t('其他机器任务')}</span><strong>{t('最多 {{count}} 项', { count: saved })}</strong></div>
    </div>
    <Field label={t('其他机器任务的并发上限')} hint={t('默认 3 项，可调整为 1–10 项。降低上限不会中断正在运行的任务。')}>
      <select aria-label={t('其他机器任务的并发上限')} value={draft} disabled={pending} onChange={(event) => {
        setDraft(Number(event.target.value)); setConfirmed(false); setError('');
      }}>
        {Array.from({ length: maximumRemoteConcurrency - minimumRemoteConcurrency + 1 }, (_, i) => i + minimumRemoteConcurrency)
          .map((value) => <option key={value} value={value}>{t('{{count}} 项', { count: value })}</option>)}
      </select>
    </Field>
    <div className="concurrency-save">
      <Button type="submit" variant="primary" disabled={pending || draft === saved}>
        {pending ? <LoaderCircle size={15} className="spin" /> : confirmed && draft === saved ? <Check size={15} /> : null}
        {pending ? t('保存中…') : t('保存并发设置')}
      </Button>
      <small role="status">{draft !== saved ? t('尚未保存') : confirmed ? t('并发设置已保存') : ''}</small>
    </div>
    {error && <p className="queue-sync-error" role="alert">{systemText(error)}</p>}
  </form>;
}
