/** The native updater owns URLs, signatures, staged bytes and installation. */
export type DesktopUpdatePhase =
  | 'disabled' | 'idle' | 'checking' | 'available' | 'downloading'
  | 'ready' | 'preparing' | 'installing' | 'error';
export type DesktopUpdateRelease = { version: string; notes: string; publishedAt: string | null };
export type DesktopUpdateBlockers = {
  tasks: number; queues: number; workflows: number; remoteTasks: number;
  brainTasks: number; transfers: number; operations: number; modelChecks: number;
};
export type DesktopUpdateSnapshot = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  release: DesktopUpdateRelease | null;
  skippedVersion: string | null;
  lastCheckedAt: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  blockers: DesktopUpdateBlockers | null;
  revision: number;
};
export const updateCheckIntervalMilliseconds = 6 * 60 * 60 * 1000;
export const updateStartupDelayMilliseconds = 12_000;

export function updateIsBusy(phase: DesktopUpdatePhase): boolean {
  return ['checking', 'downloading', 'preparing', 'installing'].includes(phase);
}
export function shouldPromptForUpdate(value: DesktopUpdateSnapshot): boolean {
  return value.phase === 'available' && !!value.release && value.skippedVersion !== value.release.version;
}
export function updateDownloadPercent(value: DesktopUpdateSnapshot): number | null {
  if (!value.totalBytes || value.totalBytes < 0) return null;
  return Math.max(0, Math.min(100, Math.floor(value.downloadedBytes / value.totalBytes * 100)));
}
