import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Task, TaskState } from '../shared/types.ts';

export const taskQuerySQL = {
  states: (count: number) =>
    `SELECT body FROM tasks WHERE json_extract(body,'$.state') IN (${Array(count).fill('?').join(',')}) ORDER BY number DESC`,
  session: `SELECT id,json_extract(body,'$.state') AS state FROM tasks
    WHERE json_extract(body,'$.sessionID')=? ORDER BY number DESC LIMIT 1`,
  remote: `SELECT body FROM tasks WHERE json_extract(body,'$.remoteOrigin.remoteTaskID')=? ORDER BY number DESC LIMIT 1`,
};

export function decodeTask(body: string): Task {
  const value = JSON.parse(body) as Task;
  return { ...value, approvalMode: value.approvalMode || 'ask' };
}

/** Indexed reads stay transactionally current without caching mutable Task objects.
 * The JSON document remains authoritative; SQLite maintains these derived indexes
 * for all writes, including rolled-back changes and older callers using plain SQL.
 */
export class TaskQueries {
  private db: DatabaseSync;
  private states = new Map<number, StatementSync>();
  private session: StatementSync;
  private remote: StatementSync;
  private state: StatementSync;
  private maximum: StatementSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE INDEX IF NOT EXISTS tasks_runtime_state ON tasks(json_extract(body,'$.state'),number DESC);
      CREATE INDEX IF NOT EXISTS tasks_runtime_session ON tasks(json_extract(body,'$.sessionID'),number DESC,id,json_extract(body,'$.state'));
      CREATE INDEX IF NOT EXISTS tasks_runtime_remote ON tasks(json_extract(body,'$.remoteOrigin.remoteTaskID'),number DESC);
    `);
    this.session = db.prepare(taskQuerySQL.session);
    this.remote = db.prepare(taskQuerySQL.remote);
    this.state = db.prepare("SELECT json_extract(body,'$.state') AS state FROM tasks WHERE id=?");
    this.maximum = db.prepare('SELECT COALESCE(MAX(number),0) AS maximum FROM tasks');
  }

  inStates(states: readonly TaskState[]): Task[] {
    if (!states.length) return [];
    let statement = this.states.get(states.length);
    if (!statement) {
      statement = this.db.prepare(taskQuerySQL.states(states.length));
      this.states.set(states.length, statement);
    }
    return statement.all(...states).map((row) => decodeTask(String(row.body)));
  }

  routeForSession(sessionID: unknown): Pick<Task, 'id' | 'state'> | undefined {
    if (typeof sessionID !== 'string' || !sessionID) return undefined;
    const row = this.session.get(sessionID);
    return row ? { id: String(row.id), state: row.state as TaskState } : undefined;
  }

  forRemote(remoteTaskID: string): Task | undefined {
    const row = this.remote.get(remoteTaskID);
    return row ? decodeTask(String(row.body)) : undefined;
  }

  stateForID(taskID: string): TaskState | undefined {
    return this.state.get(taskID)?.state as TaskState | undefined;
  }

  nextNumber(): number {
    return Number(this.maximum.get()!.maximum) + 1;
  }
}
