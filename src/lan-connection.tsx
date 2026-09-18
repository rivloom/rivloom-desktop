import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { NodeNetwork } from '../shared/types.ts';
import { firewallCanRepair, firewallCoverageLabel, firewallErrorLabel, type LanFirewallReport } from '../shared/lan-firewall.ts';
import { desktop, inspectLanFirewall, repairLanFirewall } from './desktop';
import { api } from './api';

export function LanConnection({ network, owner, onReport }: {
  network: NodeNetwork; owner: boolean;
  onReport?: (report: LanFirewallReport | null, stale: boolean) => void;
}) {
  const [report, setReport] = useState<LanFirewallReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [allowPublic, setAllowPublic] = useState(false);
  const generation = useRef(0);
  const operating = useRef(false);
  const port = network.local?.port || 0;
  const available = desktop && owner;
  const onReportRef = useRef(onReport); onReportRef.current = onReport;
  useEffect(() => { onReportRef.current?.(report, stale); }, [report, stale]);
  useEffect(() => {
    if (!available) return;
    void check();
    return () => { generation.current++; operating.current = false; };
  }, [available, port]);

  async function check(repair = false) {
    if (!available || operating.current) return;
    operating.current = true; const current = ++generation.current;
    const valid = () => current === generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      if (repair) await repairLanFirewall(allowPublic);
      if (!valid()) return;
      const next = await inspectLanFirewall(port);
      if (!valid()) return;
      setReport(next); setStale(false);
      if (repair) {
        setMessage(t('规则操作已完成，正在重新发现设备并检查连接。'));
        try {
          await api('/network/diagnostics/retry', {}, { timeoutMilliseconds: 15_000 });
          // Observe several discovery intervals, without generating pairings or
          // sending tasks. A missing peer is an unconfirmed result, not success.
          let observed: NodeNetwork | null = null;
          for (let attempt = 0; attempt < 4 && valid(); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (!valid()) return;
            observed = await api<NodeNetwork>('/network');
            if (observed.nearby.some((node) => node.online && node.verified)) break;
          }
          if (!valid()) return;
          const peers = observed?.nearby.filter((node) => node.online && node.verified) || [];
          const connected = peers.filter((node) => node.trusted && node.channelReady);
          setMessage(connected.length
            ? t('复测已确认 {{count}} 台设备的加密连接。', { count: connected.length })
            : peers.length ? t('复测已发现并验证 {{count}} 台设备，请在两端核对短码完成配对。', { count: peers.length })
              : t('复测尚未发现对端。请在另一台电脑打开 Rivloom 并检查其局域网连接权限。'));
        } catch {
          if (valid()) setMessage(t('规则操作已完成，但连接复测未完成。请点击连接诊断中的刷新并重试。'));
        }
      }
    } catch (cause) {
      if (valid()) { setStale(true); setError(firewallErrorLabel(cause)); }
    } finally { if (valid()) { operating.current = false; setBusy(false); } }
  }
  if (!available) return null;
  const publicNetwork = report?.profiles.some((p) => p.name === 'Public');
  return <section className="lan-connection" aria-label={t('本机局域网连接')} aria-busy={busy}>
    <div className="lan-connection-heading"><div><h2><ShieldCheck size={18} />{t('本机局域网连接')}</h2>
      <p>{t('检查这台电脑的通信权限；另一台电脑需要在其自身完成检查。')}</p></div>
      <button className="button" disabled={busy} onClick={() => void check()}><RefreshCw size={15} className={busy ? 'spin' : ''} />{t('检查网络权限')}</button></div>
    {busy && <p role="status">{t('正在检查或等待 Windows 授权，请留意系统提示。')}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {stale && report && <p>{t('以下为上次检查结果，当前配置尚未确认。')}</p>}
    {report && <>
      <p>{report.listener === 'ready' ? t('通信服务正在监听局域网连接。')
        : report.listener === 'missing' ? t('未找到本次应用的通信监听，请重启 Rivloom 后检查。')
        : report.listener === 'limited' ? t('通信监听范围受限，请检查应用的监听配置。') : t('通信监听状态待确认。')}</p>
      {!report.profiles.length && <p>{t('未读取到活动网络，请确认网络已连接后重试。')}</p>}
      <div className="lan-profile-list">{report.profiles.map((profile) => <div className="lan-profile" key={profile.name}>
        <strong>{profile.name === 'Public' ? t('公用网络') : profile.name === 'Domain' ? t('域网络') : t('专用网络')}</strong>
        <span>{t('设备通信')} · {firewallCoverageLabel(profile.tcp)}</span>
        <span>{t('局域网发现')} · {firewallCoverageLabel(profile.udp)}</span>
        <span>mDNS · {firewallCoverageLabel(profile.mdns)}</span>
      </div>)}</div>
      <details><summary>{t('查看本机检查详情')}</summary><p>{t('通信程序：{{path}}', { path: report.program })}</p>
        <p>{t('检查时间：{{value1}}', { value1: new Date(report.checkedAt).toLocaleString() })}</p>
        <p>{t('规则匹配仅说明本机配置；双向发现、身份验证和加密连接仍以实际通信为准。')}</p></details>
      {publicNetwork && <label className="lan-public-consent"><input type="checkbox" disabled={busy || report.managedPublic}
        checked={allowPublic || report.managedPublic} onChange={(event) => setAllowPublic(event.target.checked)} />
        <span>{report.managedPublic ? t('此安装已获准在公用网络使用局域网连接。') : t('我信任当前局域网，允许在公用网络使用局域网连接。')}</span></label>}
      <p className="lan-scope">{t('修复仅放行本应用通信程序与同一子网设备的入站通信，默认用于专用和域网络；公用网络需明确允许。系统防火墙保持原设置。')}</p>
      <button className="button primary" disabled={busy || stale || !firewallCanRepair(report, allowPublic)} onClick={() => void check(true)}>
        <ShieldCheck size={16} />{t('允许局域网连接并复测')}</button>
      {report.profiles.some((p) => [p.tcp,p.udp,p.mdns].some((v) => v === 'block_rule' || v === 'policy_blocked')) &&
        <p>{t('检测到阻止规则或组织策略，请联系管理员处理；本操作不会删除这些规则或覆盖组织策略。')}</p>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
