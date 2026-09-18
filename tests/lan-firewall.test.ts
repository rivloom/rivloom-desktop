import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewallCanRepair, firewallSummary, firewallErrorLabel, type LanFirewallReport } from '../shared/lan-firewall.ts';
const report = (extra: Partial<LanFirewallReport> = {}): LanFirewallReport => ({
  checkedAt: '2026-09-18T01:00:00.000Z', program: 'C:\\private-user\\runtime\\node.exe', runtimeExists: true,
  listener: 'ready', profiles: [{ name: 'Public', tcp: 'missing', udp: 'missing', mdns: 'missing' }],
  managedRuleCount: 0, managedPublic: false, ...extra,
});
test('LAN repair requires explicit Public consent, known network and an existing runtime', () => {
  assert(!firewallCanRepair(report(), false));
  assert(firewallCanRepair(report(), true));
  assert(firewallCanRepair(report({managedPublic:true}), false));
  assert(!firewallCanRepair(report({runtimeExists:false}), true));
  assert(!firewallCanRepair(report({profiles:[]}), true));
  for (const status of ['allowed','policy_blocked','block_rule','disabled'] as const)
    assert(!firewallCanRepair(report({profiles:[{name:'Private',tcp:status,udp:status,mdns:status}]}), false));
});
test('LAN summary distinguishes stale observations and excludes program paths and identifiers', () => {
  const text = firewallSummary(report(), true);
  assert(text.includes('last_known')); assert(text.includes('TCP=missing'));
  assert(!text.includes('private-user')); assert(!text.includes('node.exe'));
  assert.equal(firewallSummary(null, false), 'windows_network: unknown');
});
test('cancellation, partial failure and unknown outcome never use a success message or raw error', () => {
  assert.match(firewallErrorLabel('firewall_cancelled'), /取消/);
  assert.match(firewallErrorLabel('firewall_repair_failed'), /未能完整/);
  assert.match(firewallErrorLabel('firewall_result_unknown'), /尚未确认/);
  assert(!firewallErrorLabel(new Error('C:\\secret-path password')).includes('secret'));
});
