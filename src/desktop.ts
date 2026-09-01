import { invoke, isTauri } from '@tauri-apps/api/core';

export const desktop = isTauri();
export type DesktopInfo = { version: string; dataDirectory: string; setupCode: string | null };
export const desktopInfo = () => invoke<DesktopInfo>('desktop_info');
export const chooseProjectDirectory = () => invoke<string | null>('choose_project_directory');
