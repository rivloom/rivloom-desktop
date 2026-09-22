import type { DatabaseSync } from 'node:sqlite';
import type { Bootstrap } from '../shared/types.ts';
import { conversations } from '../shared/conversations.ts';
import { conversationDirectory, historyCanTrash, historyExpiry, historyMembers, type HistoryMembers, type TrashEntry } from '../shared/conversation-history.ts';
import type { NodeQueueEntry } from '../shared/node-queue.ts';
import { RuntimeHistoryError, type RuntimeHistory } from './runtime-history.ts';

export type HistoryData = Pick<Bootstrap, 'tasks' | 'network' | 'workflows' | 'projects' | 'conversationPreferences'>;
type StoredHistory = TrashEntry & { members: HistoryMembers; fileIDs: string[] };
export class HistoryError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function createHistorySchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_trash (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_retired (kind TEXT NOT NULL, id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      permanent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS conversation_retired_id ON conversation_retired(id);
    CREATE INDEX IF NOT EXISTS conversation_retired_key ON conversation_retired(conversation_key);`);
}
/** Collect descriptors from nested workflow contexts as well as direct input/result manifests. */
export function historyFileIDs(value: unknown): string[] {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.sha256 === 'string' && typeof record.bytes === 'number') ids.add(record.id);
    for (const nested of Object.values(record)) if (typeof nested === 'object') visit(nested);
  }
  visit(value); return [...ids];
}
export class ConversationHistory {
  private db: DatabaseSync;
  private cleaning = new Map<string, Promise<void>>();
  private options: { data: () => HistoryData; queue: () => NodeQueueEntry[]; busy: (members: HistoryMembers) => boolean;
    files?: (members: HistoryMembers) => string[];
    purge: (members: HistoryMembers, fileIDs: string[], protectedIDs: Set<string>) => void | Promise<void>;
    runtime?: RuntimeHistory; clock?: () => number };
  constructor(db: DatabaseSync, options: ConversationHistory['options']) {
    this.db = db; this.options = options; createHistorySchema(db);
  }
  retired(kind: string, id: string, permanentOnly = false): boolean {
    const row = this.db.prepare('SELECT permanent FROM conversation_retired WHERE kind=? AND id=?').get(kind, id);
    return !!row && (!permanentOnly || !!row.permanent);
  }
  assertAvailable(kind: string, id: string) {
    if (this.retired(kind, id)) throw new HistoryError(410, '此会话已移入回收站或已永久删除，请先恢复或创建新会话。');
  }
  private records(): StoredHistory[] {
    return this.db.prepare('SELECT body FROM conversation_trash ORDER BY rowid DESC').all().map((r) => JSON.parse(String(r.body)));
  }
  private get(key: string): StoredHistory | null {
    const row = this.db.prepare('SELECT body FROM conversation_trash WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) : null;
  }
  list(): TrashEntry[] { return this.records().map(({ members: _members, fileIDs: _files, ...entry }) => entry); }
  filter<T extends HistoryData>(data: T): T {
    return { ...data, tasks: data.tasks.filter((v) => !this.retired('local', v.id)),
      workflows: data.workflows?.filter((v) => !this.retired('workflow', v.id)),
      network: { ...data.network, remoteTasks: data.network.remoteTasks.filter((v) => !this.retired('remote', v.id)),
        brainTasks: data.network.brainTasks.filter((v) => !this.retired('brain', v.id)) } };
  }
  trash(key: string, visible: HistoryData): TrashEntry {
    const previous = this.get(key);
    if (previous) return this.list().find((v) => v.key === key)!;
    const item = conversations(this.filter(visible)).find((v) => v.key === key);
    if (!item) throw new HistoryError(404, '会话不存在。');
    const data = this.options.data(), members = historyMembers(item, data);
    if (!historyCanTrash(item, data, this.options.queue()) || this.options.busy(members))
      throw new HistoryError(409, '会话仍在执行、排队或确认状态，请先停止并等待处理完成。');
    const deletedAt = new Date((this.options.clock || Date.now)()).toISOString();
    const related = { item, tasks: data.tasks.filter((v) => members.local.includes(v.id)),
      remotes: data.network.remoteTasks.filter((v) => members.remote.includes(v.id)) };
    const entry: StoredHistory = { key, title: item.title, directory: conversationDirectory(item, data).label,
      deletedAt, expiresAt: historyExpiry(deletedAt), purging: false, members,
      fileIDs: [...new Set([...historyFileIDs(related), ...this.options.files?.(members) || []])] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO conversation_trash VALUES (?,?)').run(key, JSON.stringify(entry));
      for (const [kind, ids] of Object.entries(members)) for (const id of ids)
        this.db.prepare('INSERT INTO conversation_retired VALUES (?,?,?,0)').run(kind, id, key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.list().find((v) => v.key === key)!;
  }
  restore(key: string) {
    const record = this.get(key);
    if (!record) throw new HistoryError(404, '回收站中没有此会话。');
    if (record.purging) throw new HistoryError(409, '此会话正在永久删除，无法恢复。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM conversation_retired WHERE conversation_key=? AND permanent=0').run(key);
      this.db.prepare('DELETE FROM conversation_trash WHERE key=?').run(key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  purge(key: string): Promise<void> {
    const previous = this.cleaning.get(key);
    if (previous) return previous;
    const pending = this.performPurge(key).finally(() => this.cleaning.delete(key));
    this.cleaning.set(key, pending); return pending;
  }
  private async performPurge(key: string) {
    const record = this.get(key);
    if (!record) throw new HistoryError(404, '回收站中没有此会话。');
    if (this.options.busy(record.members)) throw new HistoryError(409, '相关记录正在处理，请稍后重试。');
    // Persist the journal before touching separate stores; retries after a crash are idempotent.
    record.purging = true;
    record.cleanup = { state: 'pending', attempts: (record.cleanup?.attempts || 0) + 1,
      lastAttemptAt: new Date((this.options.clock || Date.now)()).toISOString() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE conversation_trash SET body=? WHERE key=?').run(JSON.stringify(record), key);
      this.db.prepare('UPDATE conversation_retired SET permanent=1 WHERE conversation_key=?').run(key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
    this.options.runtime?.prepare(key, record.members);
    await this.options.runtime?.purge(key, record.members);
    if (this.options.busy(record.members)) throw new HistoryError(409, '相关记录正在处理，请稍后重试。');
    const data = this.options.data(), m = record.members;
    const retained = { tasks: data.tasks.filter((v) => !m.local.includes(v.id)),
      workflows: data.workflows?.filter((v) => !m.workflow.includes(v.id)),
      remotes: data.network.remoteTasks.filter((v) => !m.remote.includes(v.id)),
      brains: data.network.brainTasks.filter((v) => !m.brain.includes(v.id)) };
    await this.options.purge(m, record.fileIDs, new Set(historyFileIDs(retained)));
    this.options.runtime?.finish(key);
    this.db.prepare('DELETE FROM conversation_trash WHERE key=?').run(key);
    } catch (error) {
      record.cleanup.state = 'failed';
      record.cleanup.error = error instanceof RuntimeHistoryError ? error.code : 'cleanup_failed';
      this.db.prepare('UPDATE conversation_trash SET body=? WHERE key=?').run(JSON.stringify(record), key);
      throw new HistoryError(503, '会话清理尚未完成，记录已保留，请稍后重试。');
    }
  }
  async sweep(expiredOnly = true) {
    let deleted = 0; const failed: string[] = [];
    const now = (this.options.clock || Date.now)();
    for (const record of this.records()) {
      if (expiredOnly && !record.purging && Date.parse(record.expiresAt) > now) continue;
      try { await this.purge(record.key); deleted++; } catch { failed.push(record.key); }
    }
    return { deleted, failed };
  }
}
