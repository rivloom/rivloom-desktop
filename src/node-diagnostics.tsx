import { t, systemText, language } from '../shared/i18n.ts';
import { useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Copy,
  RefreshCw,
  ArrowUpRight,
} from 'lucide-react';
import { api } from './api';
import { LanConnection } from './lan-connection';
import { firewallSummary, type LanFirewallReport } from '../shared/lan-firewall.ts';
import {
  diagnoseLocal,
  diagnosePeer,
  diagnosticSummary,
  type DiagnosticAction,
} from '../shared/node-diagnostics';
import { queueReasonLabel } from './task-receipts';
import type { Bootstrap, RivloomNode } from '../shared/types';
import type { NodeQueueSnapshot } from '../shared/node-queue';

const actionLabels: Record<DiagnosticAction, string> = {
  get retry() {
    return t('重试连接');
  },
  get network() {
    return t('打开节点设置');
  },
  get models() {
    return t('打开模型设置');
  },
  get execution() {
    return t('执行与文件夹');
  },
  get queue() {
    return t('查看本机队列');
  },
  get attention() {
    return t('查看待办');
  },
};
export function NodeDiagnosticsView({
  data,
  connected,
  queue,
  initialNodeID,
  refresh,
  navigate,
}: {
  data: Bootstrap;
  connected: boolean;
  queue: NodeQueueSnapshot | null;
  initialNodeID?: string | null;
  refresh: () => Promise<void>;
  navigate: (action: Exclude<DiagnosticAction, 'retry'>) => void;
}) {
  const [selection, setSelection] = useState(initialNodeID || 'local');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [copyText, setCopyText] = useState('');
  const nodes = [
    ...new Map(
      [...(data.network.paired || []), ...data.network.nearby]
        .filter((n) => !n.local)
        .map((n) => [n.id, n] as [string, RivloomNode]),
    ).values(),
  ];
  const node = nodes.find((n) => n.id === selection);
  const [firewall, setFirewall] = useState<{ report: LanFirewallReport | null; stale: boolean } | null>(null);
  const diagnostic =
    selection === 'local' ? diagnoseLocal(data, connected) : node ? diagnosePeer(node) : null;
  const checkedAt = new Date().toISOString();
  async function retry() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (data.user.owner)
        await api(
          '/network/diagnostics/retry',
          selection === 'local' ? {} : { nodeID: selection },
          { timeoutMilliseconds: 15_000 },
        );
      await refresh();
      setMessage(
        data.user.owner
          ? t('已发起发现与连接检查，状态会随收到的新消息更新。')
          : t('已刷新当前可见状态。'),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="diagnostics-page" aria-label={t('连接诊断')}>
      <div className="attention-heading">
        <div>
          <span className="eyebrow">{t('连接与执行条件')}</span>
          <h1>{t('连接诊断')}</h1>
          <p>{t('查看当前事实，找到下一步可以处理的位置。')}</p>
        </div>
        <button className="button" disabled={busy} onClick={() => void retry()}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
          {data.user.owner ? t('刷新并重试') : t('刷新状态')}
        </button>
      </div>
      <div className="diagnostic-target">
        <label>
          {t('检查对象')}
          <select
            value={selection}
            onChange={(e) => {
              setSelection(e.target.value);
              setError('');
              setMessage('');
              setCopyText('');
            }}
          >
            <option value="local">
              {t('本机 · {{value1}}', { value1: data.network.local?.name || t('我的 Node') })}
            </option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.remark || n.name} · {n.online ? t('在线') : t('离线')}
              </option>
            ))}
          </select>
        </label>
        {diagnostic && (
          <button
            className="button"
            onClick={() => {
              const summary = diagnosticSummary(diagnostic, checkedAt) + (diagnostic.local && firewall ? '\n' + firewallSummary(firewall.report, firewall.stale) : '');
              setCopyText(summary);
              setMessage(t('诊断摘要已准备；也可选中下方文字手动复制。'));
              void navigator.clipboard
                ?.writeText(summary)
                .then(() => setMessage(t('已复制诊断摘要，未包含任务正文、路径、网络地址或凭据。')))
                .catch(() => setMessage(t('剪贴板不可用，请选中下方摘要手动复制。')));
            }}
          >
            <Copy size={15} />
            {t('复制摘要')}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {systemText(error)}
        </p>
      )}
      {message && (
        <p className="attention-notice" role="status">
          {systemText(message)}
        </p>
      )}
      {copyText && (
        <textarea
          className="diagnostic-summary"
          aria-label={t('可复制的诊断摘要')}
          readOnly
          rows={8}
          value={copyText}
          onFocus={(event) => event.target.select()}
        />
      )}
      {selection === 'local' && <LanConnection network={data.network} owner={data.user.owner} onReport={(report, stale) => setFirewall({ report, stale })} />}
      {diagnostic ? (
        <>
          {!diagnostic.local && (
            <p className="diagnostic-contact">
              {t('最近确认通信： {{value1}}', {
                value1: diagnostic.lastContactAt
                  ? new Date(diagnostic.lastContactAt).toLocaleString(language())
                  : t('本次启动尚未记录'),
              })}
            </p>
          )}
          <div className="diagnostic-checks">
            {diagnostic.checks.map((check) => (
              <article key={check.code} className={`diagnostic-check ${check.state}`}>
                <span className="diagnostic-icon">
                  {check.state === 'ok' ? (
                    <CheckCircle2 size={19} />
                  ) : check.state === 'unknown' ? (
                    <CircleHelp size={19} />
                  ) : (
                    <AlertCircle size={19} />
                  )}
                </span>
                <div>
                  <strong>{check.title}</strong>
                  <p>{check.detail}</p>
                </div>
                {check.action && (check.action !== 'execution' || data.user.owner) && (
                  <button
                    className="button"
                    disabled={busy || (check.action === 'retry' && !data.user.owner)}
                    onClick={() =>
                      check.action === 'retry'
                        ? void retry()
                        : navigate(check.action! as Exclude<DiagnosticAction, 'retry'>)
                    }
                  >
                    {actionLabels[check.action]}
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="attention-notice">
          {t('这台设备当前不在可见记录中。刷新后选择仍然存在的设备。')}
        </p>
      )}
      {selection === 'local' && !nodes.length && (
        <div className="diagnostic-guide">
          <Activity size={20} />
          <div>
            <strong>{t('还没有发现其他设备')}</strong>
            <p>
              {t(
                '在另一台电脑打开 Rivloom，确认两台设备处于可互通网络。若仍没有发现，请检查 VPN、访客网络隔离和系统的应用通信设置，再点击刷新并重试。',
              )}
            </p>
          </div>
        </div>
      )}
      {selection === 'local' && queue && (
        <section className="diagnostic-queue">
          <h2>{t('本机等待原因')}</h2>
          {queue.paused && <p>{t('整个队列已暂停，后续任务等待恢复。')}</p>}
          {queue.entries.filter((e) => e.state !== 'ended' && e.blockReason).length ? (
            queue.entries
              .filter((e) => e.state !== 'ended' && e.blockReason)
              .slice(0, 8)
              .map((e) => (
                <p key={e.id}>
                  {queueReasonLabel(e.blockReason)}
                  <span>
                    {' '}
                    ·{' '}
                    {e.state === 'held'
                      ? t('已暂缓')
                      : e.state === 'admitted'
                        ? t('保留执行槽')
                        : t('等待中')}
                  </span>
                </p>
              ))
          ) : (
            <p>{t('当前未记录新的队列阻塞原因。')}</p>
          )}
          <button className="button" onClick={() => navigate('queue')}>
            {t('查看完整队列')}
            <ArrowUpRight size={14} />
          </button>
        </section>
      )}
      <p className="diagnostic-footnote">
        {t('在线与通道正常不代表任务已经执行。任务进展、审批和结果以原会话为准。')}
      </p>
    </section>
  );
}
