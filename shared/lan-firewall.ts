import { t } from './i18n.ts';

export type FirewallCoverage = 'allowed' | 'missing' | 'restricted' | 'block_rule' | 'policy_blocked' | 'disabled';
export type LanFirewallReport = {
  checkedAt: string;
  program: string;
  runtimeExists: boolean;
  listener: 'ready' | 'limited' | 'missing' | 'unknown';
  profiles: { name: 'Private' | 'Public' | 'Domain'; tcp: FirewallCoverage; udp: FirewallCoverage; mdns: FirewallCoverage }[];
  managedRuleCount: number;
  managedPublic: boolean;
};
export function firewallCoverageLabel(status: FirewallCoverage) {
  switch (status) {
    case 'allowed': return t('已匹配局域网放行规则');
    case 'missing': return t('缺少匹配的放行规则');
    case 'restricted': return t('已有规则限制来源或其他条件');
    case 'block_rule': return t('存在可能优先阻止通信的规则');
    case 'policy_blocked': return t('系统策略限制入站或本地规则');
    case 'disabled': return t('此网络的系统防火墙未启用');
    default: return t('暂时无法确认');
  }
}
export function firewallErrorLabel(error: unknown) {
  switch (String(error instanceof Error ? error.message : error)) {
    case 'firewall_busy': return t('网络检查或授权操作仍在进行，请稍后重试。');
    case 'firewall_cancelled': return t('已取消系统授权，未执行本次修复。');
    case 'firewall_rule_conflict': return t('规则标识与其他配置冲突，未覆盖已有规则。请联系管理员检查。');
    case 'firewall_runtime_missing': return t('通信程序缺失，请修复 Rivloom 安装后重试。');
    case 'firewall_result_unknown': return t('修复结果尚未确认，请重新检查；不要连续发起授权。');
    case 'firewall_elevation_failed': return t('无法取得系统授权，请联系管理员允许 Rivloom 的局域网通信。');
    case 'firewall_repair_failed': return t('规则未能完整配置，请重新检查。系统策略可能需要管理员处理。');
    default: return t('无法读取 Windows 网络配置，当前结果未知。请刷新或联系管理员检查。');
  }
}
/** Facts only; a matching rule is never treated as proof of peer connectivity. */
export function firewallCanRepair(report: LanFirewallReport, allowPublic: boolean) {
  return report.runtimeExists && report.profiles.length > 0 &&
    report.profiles.some((p) => p.name !== 'Public' || allowPublic || report.managedPublic) &&
    report.profiles.some((p) => [p.tcp, p.udp, p.mdns].some((state) => state === 'missing' || state === 'restricted'));
}
export function firewallSummary(report: LanFirewallReport | null, stale: boolean) {
  if (!report) return 'windows_network: unknown';
  return [
    `windows_network: ${stale ? 'last_known' : 'observed'} · ${report.checkedAt}`,
    `listener: ${report.listener}`,
    ...report.profiles.map((p) => `${p.name}: TCP=${p.tcp}; UDP=${p.udp}; mDNS=${p.mdns}`),
  ].join('\n');
}
