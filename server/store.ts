import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './engine.ts';
import type { User, Project, Task, Activity } from '../shared/types.ts';
import { TaskQueries, decodeTask } from './task-queries.ts';

mkdirSync(dataRoot, { recursive: true });
export const db = new DatabaseSync(join(dataRoot, 'rivloom.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (token TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), actor_id TEXT REFERENCES users(id), kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_engine_intents (task_id TEXT PRIMARY KEY REFERENCES tasks(id), state TEXT NOT NULL CHECK(state IN ('creating','bound')), session_id TEXT, updated_at TEXT NOT NULL);
PRAGMA user_version=3;`);

export const taskQueries = new TaskQueries(db);

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function users(): User[] {
  return (db.prepare('SELECT id,username,name,owner FROM users').all() as unknown as User[]).map(
    (u) => ({ ...u, owner: !!u.owner }),
  );
}
export function user(id: string) {
  return users().find((u) => u.id === id);
}
export function projects(): Project[] {
  return db
    .prepare('SELECT body FROM projects')
    .all()
    .map((r) => JSON.parse(r.body as string));
}
export function project(id: string): Project {
  const row = db.prepare('SELECT body FROM projects WHERE id=?').get(id);
  if (!row) throw new HttpError(404, '项目不存在');
  return JSON.parse(row.body as string);
}
export function saveProject(value: Project) {
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run(
    value.id,
    value.directory,
    JSON.stringify(value),
  );
}
export function tasks(): Task[] {
  return db
    .prepare('SELECT body FROM tasks ORDER BY number DESC')
    .all()
    .map((r) => decodeTask(r.body as string));
}
export function task(id: string): Task {
  const row = db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
  if (!row) throw new HttpError(404, '任务不存在');
  return decodeTask(row.body as string);
}
export function saveTask(value: Task) {
  db.prepare(
    'INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
  ).run(value.id, value.number, value.projectID, JSON.stringify(value));
}
export function patchTask(taskID: string, patch: Partial<Task>) {
  const current = task(taskID);
  const value = { ...current, ...patch, version: current.version + 1, updatedAt: now() };
  saveTask(value);
  return value;
}
export function activity(taskID: string, actorID: string | null, kind: string, text: string) {
  db.prepare('INSERT INTO activities (task_id,actor_id,kind,text,at) VALUES (?,?,?,?,?)').run(
    taskID,
    actorID,
    kind,
    text,
    now(),
  );
}
export function activities(taskID: string): Activity[] {
  return db
    .prepare(
      'SELECT id,task_id AS taskID,actor_id AS actorID,kind,text,at FROM activities WHERE task_id=? ORDER BY id DESC LIMIT 300',
    )
    .all(taskID) as unknown as Activity[];
}
export function participant(t: Task, u: User) {
  return [t.creatorID, t.assigneeID, t.approverID, t.reviewerID].includes(u.id);
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function requireThat(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}

const locks = new Map<string, Promise<unknown>>();
export const isLocked = (key: string) => locks.has(key);
export async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  locks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (locks.get(key) === pending) locks.delete(key);
  }
}
