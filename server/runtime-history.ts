import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { startEngine } from './engine.ts';
import { accountIDSchema } from './provider-accounts.ts';
import type { HistoryMembers } from '../shared/conversation-history.ts';

export type RuntimeHistoryClient = Awaited<ReturnType<typeof startEngine>>['client'];
export type RuntimeHistoryBinding = { accountID: string; engineRoot: string; sessionID: string; directory: string };
export type RuntimeHistoryWithClient = <T>(binding: RuntimeHistoryBinding, work: (client: RuntimeHistoryClient) => Promise<T>) => Promise<T>;
export type RuntimeHistoryFailure = 'runtime_unavailable' | 'runtime_busy' | 'runtime_shared' | 'runtime_scope_invalid' | 'runtime_delete_unconfirmed';
export class RuntimeHistoryError extends Error {
  readonly code: RuntimeHistoryFailure;
  constructor(code: RuntimeHistoryFailure) { super(code); this.code = code; }
}
type Reference = RuntimeHistoryBinding & { taskID: string };
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const identity = (binding: RuntimeHistoryBinding) => `${pathKey(binding.engineRoot)}\0${binding.sessionID}`;

/** Only sessions whose ownership was recorded by Rivloom are eligible. Never scan a Runtime database. */
export class RuntimeHistory {
  private db: DatabaseSync;
  private options: { engineRoot: string; withClient: RuntimeHistoryWithClient };
  constructor(db: DatabaseSync, options: RuntimeHistory['options']) {
    this.db = db; this.options = options;
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_history_cleanup (
      conversation_key TEXT NOT NULL, engine_root TEXT NOT NULL, session_id TEXT NOT NULL,
      body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(conversation_key,engine_root,session_id));`);
  }
  private table(name: string) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  private validate(binding: RuntimeHistoryBinding) {
    if (!binding.sessionID || binding.sessionID.length > 120 || !/^ses[\w-]+$/.test(binding.sessionID) ||
      !isAbsolute(binding.directory) || !isAbsolute(binding.engineRoot)) throw new RuntimeHistoryError('runtime_scope_invalid');
    const expected = binding.accountID ? join(this.options.engineRoot, 'accounts', accountIDSchema.parse(binding.accountID)) : this.options.engineRoot;
    if (pathKey(binding.engineRoot) !== pathKey(expected)) throw new RuntimeHistoryError('runtime_scope_invalid');
    // Do not let a replaced account directory redirect maintenance outside the owned Runtime root.
    if (existsSync(expected) && existsSync(this.options.engineRoot)) {
      const base = pathKey(realpathSync(this.options.engineRoot));
      const actual = pathKey(realpathSync(expected));
      const expectedReal = pathKey(binding.accountID ? join(base, 'accounts', binding.accountID) : base);
      if (actual !== expectedReal) throw new RuntimeHistoryError('runtime_scope_invalid');
    }
    return binding;
  }
  private references(): Reference[] {
    const result: Reference[] = [];
    const routes = new Map(this.table('task_engine_routes') ? this.db.prepare('SELECT task_id,account_id FROM task_engine_routes').all()
      .map(row => [String(row.task_id), String(row.account_id)]) : []);
    const projects = new Map(this.table('projects') ? this.db.prepare('SELECT id,directory FROM projects').all()
      .map(row => [String(row.id), String(row.directory)]) : []);
    if (this.table('tasks')) for (const row of this.db.prepare('SELECT id,body FROM tasks').all()) {
      const task = JSON.parse(String(row.body));
      if (!task.sessionID) continue;
      const accountID = routes.get(String(row.id)) || '';
      result.push({ taskID: String(row.id), accountID, engineRoot: accountID ? join(this.options.engineRoot, 'accounts', accountID) : this.options.engineRoot,
        sessionID: task.sessionID, directory: projects.get(task.projectID) || '' });
    }
    if (this.table('task_context_runs')) for (const row of this.db.prepare('SELECT task_id,engine_root,session_id,directory,body FROM task_context_runs').all()) {
      const record = JSON.parse(String(row.body));
      result.push({ taskID: String(row.task_id), accountID: record.accountID || '', engineRoot: String(row.engine_root),
        sessionID: String(row.session_id), directory: String(row.directory) });
    }
    return result;
  }
  prepare(key: string, members: HistoryMembers) {
    for (const ref of this.references().filter(ref => members.local.includes(ref.taskID))) {
      const { taskID: _taskID, ...binding } = ref;
      this.validate(binding);
      this.remember(key, binding);
    }
  }
  private remember(key: string, binding: RuntimeHistoryBinding) {
    this.db.prepare('INSERT OR IGNORE INTO runtime_history_cleanup(conversation_key,engine_root,session_id,body) VALUES(?,?,?,?)')
      .run(key, pathKey(binding.engineRoot), binding.sessionID, JSON.stringify(binding));
  }
  async purge(key: string, members: HistoryMembers) {
    try {
      for (;;) {
        const row = this.db.prepare('SELECT body FROM runtime_history_cleanup WHERE conversation_key=? AND done=0 ORDER BY rowid LIMIT 1').get(key);
        if (!row) break;
        const binding = this.validate(JSON.parse(String(row.body)) as RuntimeHistoryBinding);
        const protectedIDs = new Set(this.references().filter(ref => !members.local.includes(ref.taskID)).map(identity));
        if (protectedIDs.has(identity(binding))) throw new RuntimeHistoryError('runtime_shared');
        await this.options.withClient(binding, client => this.remove(key, client, binding, protectedIDs));
        this.db.prepare('UPDATE runtime_history_cleanup SET done=1 WHERE conversation_key=? AND engine_root=? AND session_id=?')
          .run(key, pathKey(binding.engineRoot), binding.sessionID);
      }
    } catch (error) {
      if (error instanceof RuntimeHistoryError) throw error;
      // Provider URLs, paths and raw SDK errors must never appear in a recycle-bin response.
      throw new RuntimeHistoryError('runtime_unavailable');
    }
  }
  private async remove(key: string, client: RuntimeHistoryClient, binding: RuntimeHistoryBinding, protectedIDs: Set<string>) {
    const request = { sessionID: binding.sessionID, directory: binding.directory };
    const opts = { throwOnError: false as const, signal: AbortSignal.timeout(10_000) };
    const current = await client.session.get(request, opts);
    if (current.response.status === 404) return;
    if (!current.response.ok || !current.data) throw new RuntimeHistoryError('runtime_unavailable');
    if (pathKey(current.data.directory) !== pathKey(binding.directory)) throw new RuntimeHistoryError('runtime_scope_invalid');
    const pending = [current.data], seen = new Set<string>();
    // Official deletion recursively removes children. Prove that every affected session is idle and unshared first.
    for (let index = 0; index < pending.length; index++) {
      const session = pending[index];
      if (seen.has(session.id) || pending.length > 1000) throw new RuntimeHistoryError('runtime_scope_invalid');
      seen.add(session.id);
      if (protectedIDs.has(identity({ ...binding, sessionID: session.id }))) throw new RuntimeHistoryError('runtime_shared');
      const params = { directory: session.directory };
      const [statuses, approvals, questions, children] = await Promise.all([
        client.session.status(params, opts), client.permission.list(params, opts), client.question.list(params, opts),
        client.session.children({ ...params, sessionID: session.id }, opts),
      ]);
      if (![statuses, approvals, questions, children].every(value => value.response.ok) || !statuses.data ||
        !Array.isArray(approvals.data) || !Array.isArray(questions.data) || !Array.isArray(children.data)) throw new RuntimeHistoryError('runtime_unavailable');
      if (statuses.data[session.id] && statuses.data[session.id].type !== 'idle' || approvals.data.some(value => value.sessionID === session.id) ||
        questions.data.some(value => value.sessionID === session.id)) throw new RuntimeHistoryError('runtime_busy');
      for (const child of children.data) {
        if (child.parentID !== session.id || pathKey(child.directory) !== pathKey(binding.directory))
          throw new RuntimeHistoryError('runtime_scope_invalid');
        pending.push(child);
      }
    }
    // Keep child identities across a crash or a partial recursive deletion, even if their parent is already gone.
    for (const session of pending) this.remember(key, { ...binding, sessionID: session.id, directory: session.directory });
    const deleted = await client.session.delete(request, opts);
    if (!deleted.response.ok && deleted.response.status !== 404) throw new RuntimeHistoryError('runtime_delete_unconfirmed');
    // Fixed Runtime may swallow a delete error. Never accept its boolean response as proof.
    for (const session of pending) {
      const check = await client.session.get({ sessionID: session.id, directory: session.directory }, opts);
      if (check.response.status !== 404) throw new RuntimeHistoryError('runtime_delete_unconfirmed');
    }
  }
  finish(key: string) { this.db.prepare('DELETE FROM runtime_history_cleanup WHERE conversation_key=?').run(key); }
}
