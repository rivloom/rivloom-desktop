import { invoke, isTauri } from '@tauri-apps/api/core';

export const desktop = isTauri();
export type DesktopInfo = { version: string; dataDirectory: string; desktopToken: string };
export const desktopInfo = () => invoke<DesktopInfo>('desktop_info');
export async function authenticateDesktop() {
  const { desktopToken } = await desktopInfo();
  if (!desktopToken) throw new Error('桌面认证信息不可用，请重启客户端。');
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
  if (!response.ok) throw new Error(data.error || '桌面身份建立失败');
}
export const chooseProjectDirectory = () => invoke<string | null>('choose_project_directory');
