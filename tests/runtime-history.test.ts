import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RuntimeHistory, type RuntimeHistoryClient } from '../server/runtime-history.ts';
import { ConversationHistory, type HistoryData } from '../server/conversation-history.ts';
import { AccountEnginePool } from '../server/account-engines.ts';
import { ProviderAccountStore } from '../server/provider-accounts.ts';
import type { startEngine } from '../server/engine.ts';
import type { HistoryMembers } from '../shared/conversation-history.ts';

const members: HistoryMembers = { local: ['one'], remote: [], brain: [], workflow: [], requests: [] };
function fixture() {
  const base = resolve('.data/unit-runtime-history'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-')), engineRoot = join(root, 'engine'), directory = join(root, 'project');
  mkdirSync(engineRoot); mkdirSync(directory);
  const db = new DatabaseSync(join(root, 'history.sqlite'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE task_engine_routes(task_id TEXT,account_id TEXT);
    CREATE TABLE task_context_runs(task_id TEXT,engine_root TEXT,session_id TEXT,directory TEXT,body TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?)').run('p', directory);
  const add = (id: string, sessionID: string) => db.prepare('INSERT INTO tasks VALUES(?,?)').run(id, JSON.stringify({ sessionID, projectID: 'p' }));
  add('one', 'ses_one'); add('keep', 'ses_keep');
  const sessions = new Map<string, { id: string; directory: string; parentID?: string }>([
    ['ses_one', { id: 'ses_one', directory }], ['ses_keep', { id: 'ses_keep', directory }],
  ]);
  const removed: string[] = []; let busy = false, confirms = true;
  const response = (data: unknown, status = 200) => ({ data, response: new Response(null, { status }) });
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => response(sessions.get(sessionID), sessions.has(sessionID) ? 200 : 404),
      status: async () => response(busy ? { ses_one: { type: 'busy' } } : {}),
      children: async ({ sessionID }: { sessionID: string }) => response([...sessions.values()].filter(value => value.parentID === sessionID)),
      delete: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID); if (confirms) sessions.delete(sessionID); return response(true); },
    }, permission: { list: async () => response([]) }, question: { list: async () => response([]) },
  } as unknown as RuntimeHistoryClient;
  const runtime = new RuntimeHistory(db, { engineRoot, withClient: async (_binding, work) => work(client) });
  return { root, db, runtime, engineRoot, directory, sessions, removed, client, add,
    busy: (value: boolean) => { busy = value; }, confirms: (value: boolean) => { confirms = value; } };
}
test('runtime cleanup requires official delete and a confirmed 404, preserves unrelated sessions', async () => {
  const f = fixture();
  try {
    f.runtime.prepare('local:one', members); f.confirms(false);
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_delete_unconfirmed' });
    assert(f.sessions.has('ses_one')); assert.equal(f.db.prepare('SELECT done FROM runtime_history_cleanup').get()?.done, 0);
    f.confirms(true); await f.runtime.purge('local:one', members);
    assert(!f.sessions.has('ses_one')); assert(f.sessions.has('ses_keep')); assert.equal(f.removed.length, 2);
    await f.runtime.purge('local:one', members); assert.equal(f.removed.length, 2);
    f.runtime.finish('local:one'); assert.equal(f.db.prepare('SELECT count(*) n FROM runtime_history_cleanup').get()?.n, 0);
  } finally { f.db.close(); }
});
test('runtime cleanup rejects active sessions and protects another task sharing a historical session', async () => {
  const f = fixture();
  try {
    f.runtime.prepare('local:one', members); f.busy(true);
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_busy' }); assert.deepEqual(f.removed, []);
    f.busy(false); f.db.prepare('INSERT INTO task_context_runs VALUES(?,?,?,?,?)').run('keep', f.engineRoot, 'ses_one', f.directory, '{}');
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_shared' }); assert.deepEqual(f.removed, []);
  } finally { f.db.close(); }
});
test('runtime cleanup retains child identities when a recursive delete leaves its parent missing', async () => {
  const f = fixture();
  try {
    f.sessions.set('ses_child', { id: 'ses_child', directory: f.directory, parentID: 'ses_one' });
    f.runtime.prepare('local:one', members);
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_delete_unconfirmed' });
    assert(!f.sessions.has('ses_one')); assert(f.sessions.has('ses_child'));
    const restarted = new RuntimeHistory(f.db, { engineRoot: f.engineRoot, withClient: async (_binding, work) => work(f.client) });
    await restarted.purge('local:one', members);
    assert(!f.sessions.has('ses_child')); assert(f.sessions.has('ses_keep')); assert.deepEqual(f.removed, ['ses_one', 'ses_child']);
  } finally { f.db.close(); }
});
test('runtime cleanup refuses recursive deletion of a child owned by another retained task', async () => {
  const f = fixture();
  try {
    f.sessions.get('ses_keep')!.parentID = 'ses_one'; f.runtime.prepare('local:one', members);
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_shared' }); assert.deepEqual(f.removed, []);
  } finally { f.db.close(); }
});
test('runtime cleanup refuses a descendant outside the recorded project directory', async () => {
  const f = fixture();
  try {
    f.sessions.set('ses_child', { id: 'ses_child', directory: join(f.root, 'another-project'), parentID: 'ses_one' });
    f.runtime.prepare('local:one', members);
    await assert.rejects(f.runtime.purge('local:one', members), { code: 'runtime_scope_invalid' }); assert.deepEqual(f.removed, []);
  } finally { f.db.close(); }
});
test('runtime cleanup includes prior account sessions and refuses unowned Runtime roots', async () => {
  const f = fixture();
  try {
    const accountID = `rivloom-account-${randomUUID()}`, root = join(f.engineRoot, 'accounts', accountID);
    f.db.prepare('INSERT INTO task_context_runs VALUES(?,?,?,?,?)').run('one', root, 'ses_prior', f.directory, JSON.stringify({ accountID }));
    f.runtime.prepare('local:one', members);
    assert.equal(f.db.prepare('SELECT count(*) n FROM runtime_history_cleanup').get()?.n, 2);
    f.db.prepare('INSERT INTO task_context_runs VALUES(?,?,?,?,?)').run('one', join(f.root, 'outside'), 'ses_other', f.directory, '{}');
    assert.throws(() => f.runtime.prepare('local:one', members), { code: 'runtime_scope_invalid' }); assert.deepEqual(f.removed, []);
  } finally { f.db.close(); }
});
test('purge journals failures without leaking errors, survives business-store interruption, and coalesces retries', async () => {
  const f = fixture();
  const input = { tasks: [{ id: 'one', title: 'one', state: 'accepted', projectID: 'p', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z' }],
    workflows: [], projects: [{ id: 'p', directory: f.directory }], network: { local: { id: 'node' }, remoteTasks: [], brainTasks: [], nearby: [] } } as unknown as HistoryData;
  let fail = true, calls = 0;
  const options = { data: () => input, queue: () => [], busy: () => false, runtime: f.runtime,
    purge: () => { calls++; if (fail) throw new Error('SECRET/path/provider'); input.tasks = []; f.db.exec("DELETE FROM tasks WHERE id='one'"); } };
  try {
    let history = new ConversationHistory(f.db, options); history.trash('local:one', input);
    const first = history.purge('local:one'), second = history.purge('local:one'); assert.equal(first, second);
    await assert.rejects(first, { status: 503 }); assert.equal(calls, 1);
    assert.equal(history.list()[0].cleanup?.error, 'cleanup_failed'); assert(!JSON.stringify(history.list()).includes('SECRET'));
    assert.throws(() => history.restore('local:one'), { status: 409 }); assert(!f.sessions.has('ses_one'));
    fail = false; history = new ConversationHistory(f.db, options); await history.purge('local:one');
    assert.equal(history.list().length, 0); assert.equal(f.removed.length, 1); assert(f.sessions.has('ses_keep'));
  } finally { f.db.close(); }
});
test('disconnected account maintenance uses a restricted Runtime and closes it even when cleanup fails', async () => {
  const f = fixture();
  try {
    const accounts = new ProviderAccountStore(f.engineRoot), account = accounts.create('fixture', 'Retired');
    mkdirSync(accounts.directory(account.id), { recursive: true }); accounts.remove(account.id);
    let launched = 0, closed = 0, exited = 0;
    const launch = (async (_cwd, _port, root, scope) => {
      launched++; assert.equal(root, accounts.directory(account.id)); assert.deepEqual(scope, { maintenance: true });
      return { client: f.client, child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
        close: () => { closed++; }, waitForExit: async () => { exited++; } };
    }) as typeof startEngine;
    const pool = new AccountEnginePool(accounts, launch);
    await assert.rejects(pool.maintenance(account.id, async () => { throw new Error('fixture'); }), /fixture/);
    assert.deepEqual({ launched, closed, exited }, { launched: 1, closed: 1, exited: 1 });
    assert.equal(accounts.list().length, 0); await pool.close(true);
    await assert.rejects(pool.maintenance(account.id, async () => true), /shutting down/);
  } finally { f.db.close(); }
});
test('a configured but cold account uses maintenance isolation and normal launch waits for its exit', async () => {
  const f = fixture();
  try {
    const accounts = new ProviderAccountStore(f.engineRoot), account = accounts.create('fixture', 'Cold');
    mkdirSync(accounts.directory(account.id), { recursive: true });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(ok => { release = ok; }), started = new Promise<void>(ok => { entered = ok; });
    const scopes: unknown[] = []; let exits = 0;
    const launch = (async (_cwd, _port, _root, scope) => {
      scopes.push(scope);
      return { client: f.client, child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
        close: () => {}, waitForExit: async () => { exits++; } };
    }) as typeof startEngine;
    const pool = new AccountEnginePool(accounts, launch);
    const maintenance = pool.maintenance(account.id, async () => { entered(); await held; });
    await started;
    const regular = pool.get(account.id); await Promise.resolve();
    assert.deepEqual(scopes, [{ maintenance: true }]);
    release(); await maintenance; await regular;
    assert.equal(exits, 1); assert.deepEqual(scopes, [{ maintenance: true }, { workspace: true, providerID: 'fixture' }]);
    await pool.close(true);
  } finally { f.db.close(); }
});
