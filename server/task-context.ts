import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ContextSource, TaskContextRecord, ContextObservation } from '../shared/task-context.ts';

export const contextRevision = (text: string) => createHash('sha256').update(text).digest('hex');
export function contextSource(kind: ContextSource['kind'], text: string, reference?: string): ContextSource {
  return { kind, inclusion: kind === 'attachment' ? 'reference' : kind === 'request' ? 'message' : 'system',
    revision: contextRevision(text), bytes: Buffer.byteLength(text), ...(reference ? { reference } : {}) };
}
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const identity = z.object({ sessionID: z.string().min(1).max(120), directory: z.string().min(1).max(1000),
  messageID: z.string().min(1).max(120), createdAt: z.number().int().nonnegative() });
const observation = identity.extend({ operation: z.literal('observe'), contextID: z.string().uuid(),
  agent: z.string().min(1).max(120), model: z.string().min(1).max(400),
  systemRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), restored: z.boolean(),
  selectedMessages: z.number().int().min(0).max(1_000_000).optional(),
  summaryIDs: z.array(z.string().min(1).max(120)).max(8).optional() });
const requestSchema = z.union([identity.extend({ operation: z.enum(['resolve', 'restore']) }), observation]);

export class TaskContextStore {
  private db: DatabaseSync;
  private active: (record: TaskContextRecord, directory: string) => boolean;
  constructor(db: DatabaseSync, active: (record: TaskContextRecord, directory: string) => boolean) {
    this.db = db; this.active = active;
    db.exec(`CREATE TABLE IF NOT EXISTS task_context_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      engine_root TEXT NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL, system TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_context_session ON task_context_runs(engine_root,session_id);
      CREATE INDEX IF NOT EXISTS task_context_task ON task_context_runs(task_id);`);
  }
  prepare(input: { taskID: string; projectID: string; sessionID: string; runAfter: number; accountID: string;
    engineRoot: string; directory: string; system: string; sources: ContextSource[] }) {
    const record: TaskContextRecord = { schemaVersion: 1, id: randomUUID(), taskID: input.taskID, projectID: input.projectID,
      sessionID: input.sessionID, runAfter: input.runAfter, accountID: input.accountID, createdAt: new Date().toISOString(),
      systemRevision: contextRevision(input.system), sources: input.sources, observationCount: 0, observations: [] };
    this.db.exec('SAVEPOINT task_context_prepare');
    try {
      // Old runs retain metadata only. Their rules can never be restored into a new run/account.
      this.db.prepare('UPDATE task_context_runs SET system=NULL WHERE task_id=?').run(input.taskID);
      this.db.prepare('INSERT INTO task_context_runs VALUES(?,?,?,?,?,?,?)').run(record.id, input.taskID,
        pathKey(input.engineRoot), input.sessionID, pathKey(input.directory), input.system, JSON.stringify(record));
      this.db.exec('RELEASE task_context_prepare');
    } catch (error) { this.db.exec('ROLLBACK TO task_context_prepare; RELEASE task_context_prepare'); throw error; }
    return record;
  }
  call(engineRoot: string, raw: unknown) {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw new Error('context_invalid_request');
    const input = parsed.data;
    const row = this.db.prepare('SELECT * FROM task_context_runs WHERE engine_root=? AND session_id=? ORDER BY rowid DESC LIMIT 1')
      .get(pathKey(engineRoot), input.sessionID);
    // Provider probes and pre-feature sessions are deliberately unmanaged.
    if (!row) return null;
    const record: TaskContextRecord = JSON.parse(String(row.body));
    if (row.directory !== pathKey(input.directory)) throw new Error('context_execution_changed');
    if (typeof row.system !== 'string' || input.createdAt < record.runAfter || !this.active(record, input.directory)) {
      // The summarizer also transforms a cloned historical prefix. Do not restore
      // old continuation messages there; actual business preparation is checked strictly below.
      if (input.operation === 'restore') return null;
      throw new Error('context_execution_changed');
    }
    if (input.operation !== 'observe')
      return { id: record.id, system: row.system, systemRevision: record.systemRevision };
    if (input.contextID !== record.id) throw new Error('context_execution_changed');
    const kind: ContextObservation['kind'] = input.agent === 'compaction' ? 'compaction' : 'execution';
    const system: ContextObservation['system'] = kind === 'compaction' ? 'not_applicable' :
      input.systemRevision !== record.systemRevision ? 'mismatch' : input.restored ? 'restored' : 'matched';
    record.observationCount++;
    record.observations = [...record.observations, { at: new Date().toISOString(), messageID: input.messageID,
      agent: input.agent, model: input.model, kind, system,
      ...(kind === 'execution' ? { selectedMessages: input.selectedMessages, summaryIDs: input.summaryIDs } : {}) }].slice(-50);
    this.db.prepare('UPDATE task_context_runs SET body=? WHERE id=?').run(JSON.stringify(record), record.id);
    if (system === 'mismatch') throw new Error('context_system_mismatch');
    return { recorded: true };
  }
  list(taskID: string) {
    const rows = this.db.prepare('SELECT body FROM task_context_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 20').all(taskID);
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM task_context_runs WHERE task_id=?').get(taskID)!.n);
    return { records: rows.map(row => JSON.parse(String(row.body)) as TaskContextRecord), total,
      note: 'Sources describe admitted inputs; file references do not prove reading. Observations verify system continuity during runtime preparation, not provider receipts, complete context contents or model comprehension. Only the latest 50 observations per run and 20 runs are returned.' };
  }
  authorize(engineRoot: string, sessionID: unknown, directory: unknown) {
    if (typeof sessionID !== 'string' || sessionID.length > 120 || typeof directory !== 'string' || directory.length > 1000)
      throw new Error('context_invalid_request');
    const row = this.db.prepare('SELECT * FROM task_context_runs WHERE engine_root=? AND session_id=? ORDER BY rowid DESC LIMIT 1')
      .get(pathKey(engineRoot), sessionID);
    if (!row || typeof row.system !== 'string' || row.directory !== pathKey(directory)) throw new Error('context_execution_changed');
    const record: TaskContextRecord = JSON.parse(String(row.body));
    if (!this.active(record, directory)) throw new Error('context_execution_changed');
    return record;
  }
}
