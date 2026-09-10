import type { DatabaseSync } from 'node:sqlite';

export const supportedWorkspaceDatabaseVersion = 3;
/** Run before any schema, WAL or application write; never rewrite a future format marker. */
export function assertReadableWorkspaceDatabase(database: DatabaseSync): number {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  if (!Number.isInteger(version) || version < 0 || version > supportedWorkspaceDatabaseVersion)
    throw new Error('此工作区由更高版本的 Rivloom 创建，请使用相同或更新版本打开。');
  return version;
}
