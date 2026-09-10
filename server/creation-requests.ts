import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createHistorySchema, HistoryError } from './conversation-history.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export class CreationConflict extends Error {
  readonly status = 409;
  constructor() {
    super('创建请求 ID 与已有目标或内容冲突，请为另一项工作使用新的请求 ID。');
  }
}

export const creationFingerprint = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** Persist intent before any side effect. The allocated Task ID also bridges JSON/SQLite recovery. */
export class CreationRequestStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    createHistorySchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS creation_requests (
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id, request_id)
    )`);
  }

  reserve(actorID: string, requestID: string | undefined, normalizedRequest: unknown): string {
    if (!requestID) return randomUUID(); // Old clients keep their existing creation contract.
    const fingerprint = creationFingerprint(normalizedRequest);
    const existing = this.db
      .prepare(
        'SELECT fingerprint, task_id FROM creation_requests WHERE actor_id=? AND request_id=?',
      )
      .get(actorID, requestID);
    if (existing) {
      if (this.db.prepare('SELECT 1 FROM conversation_retired WHERE id=? LIMIT 1').get(String(existing.task_id)))
        throw new HistoryError(410, '此会话已移入回收站或已永久删除。');
      if (existing.fingerprint !== fingerprint) throw new CreationConflict();
      return String(existing.task_id);
    }
    const taskID = randomUUID();
    this.db
      .prepare('INSERT INTO creation_requests VALUES (?,?,?,?,?)')
      .run(actorID, requestID, fingerprint, taskID, new Date().toISOString());
    return taskID;
  }
}
