import { t } from '../shared/i18n.ts';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopUpdateSnapshot } from '../shared/desktop-update.ts';
import type { LanFirewallReport } from '../shared/lan-firewall.ts';
import { useEffect, useState } from 'react';

export const desktop = isTauri();
export type DesktopCapabilities = {
  notifications: boolean;
  nativeSound: boolean;
  lanFirewallRepair: boolean;
  chooseFileApplication: boolean;
};
const noCapabilities: DesktopCapabilities = { notifications: false, nativeSound: false, lanFirewallRepair: false, chooseFileApplication: false };
export type DesktopInfo = {
  version: string;
  dataDirectory: string;
  desktopToken: string;
  locale: 'zh-CN' | 'en';
  capabilities: DesktopCapabilities;
};
export const desktopInfo = () => invoke<DesktopInfo>('desktop_info');
let capabilityRequest: Promise<DesktopCapabilities> | undefined;
export function desktopCapabilities(): Promise<DesktopCapabilities> {
  if (!desktop) return Promise.resolve(noCapabilities);
  return capabilityRequest ??= desktopInfo().then(info => info.capabilities ?? noCapabilities).catch(() => {
    capabilityRequest = undefined;
    return noCapabilities;
  });
}
export function useDesktopCapabilities() {
  const [capabilities, setCapabilities] = useState({ ...noCapabilities, ready: !desktop });
  useEffect(() => { let active = true; void desktopCapabilities().then(value => { if (active) setCapabilities({ ...value, ready: true }); }); return () => { active = false; }; }, []);
  return capabilities;
}
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
export const openTaskFileWith = (path: string, application: string) => invoke<void>('open_task_file_with', { path, application });
export const fileApplications = () => invoke<string[]>('file_applications');
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
