import { t } from '../shared/i18n.ts';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopUpdateSnapshot } from '../shared/desktop-update.ts';
import type { LanFirewallReport } from '../shared/lan-firewall.ts';

export const desktop = isTauri();
export type DesktopInfo = {
  version: string;
  dataDirectory: string;
  desktopToken: string;
  locale: 'zh-CN' | 'en';
};
export const desktopInfo = () => invoke<DesktopInfo>('desktop_info');
export const inspectLanFirewall = (port: number) => invoke<LanFirewallReport>('inspect_lan_firewall', { port });
export const repairLanFirewall = (allowPublic: boolean) => invoke<void>('repair_lan_firewall', { allowPublic });
export async function authenticateDesktop() {
  const { desktopToken } = await desktopInfo();
  if (!desktopToken) throw new Error(t('桌面认证信息不可用，请重启客户端。'));
  const response = await fetch('/api/auth/desktop', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Rivloom-Request': '1',
      'X-Rivloom-Desktop-Token': desktopToken,
    },
    body: '{}',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('桌面身份建立失败'));
}
export const chooseProjectDirectory = () => invoke<string | null>('choose_project_directory');
export const chooseTaskFileDestination = (name: string) =>
  invoke<string | null>('choose_task_file_destination', { name });
export const revealTaskFile = (path: string) => invoke<void>('reveal_task_file', { path });
export const openTaskFile = (path: string) => invoke<void>('open_task_file', { path });
export const openProjectDirectory = (path: string) => invoke<void>('open_project_directory', { path });
export const notifyAttention = (target: string, kind: string, count: number, silent = false) =>
  invoke<boolean>('notify_attention', { target, kind, count, silent });
export const takeNotificationTarget = () => invoke<string | null>('take_notification_target');
export const desktopUpdateSnapshot = () => invoke<DesktopUpdateSnapshot>('desktop_update_snapshot');
export const checkDesktopUpdate = () => invoke<DesktopUpdateSnapshot>('check_desktop_update');
export const skipDesktopUpdate = () => invoke<DesktopUpdateSnapshot>('skip_desktop_update');
export const downloadDesktopUpdate = () => invoke<DesktopUpdateSnapshot>('download_desktop_update');
export const cancelDesktopUpdate = () => invoke<DesktopUpdateSnapshot>('cancel_desktop_update');
export const installDesktopUpdate = () => invoke<DesktopUpdateSnapshot>('install_desktop_update');
export const confirmDesktopStartup = () => invoke<boolean>('confirm_desktop_startup');
