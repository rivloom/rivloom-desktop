/** Real pinned Runtime APIs and SQLite; isolated synthetic accounts, no installed-app access. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { modelFixture, until } from './m34-fixtures.ts';
import { testEnvironment } from './ci-workspace.ts';
import { RuntimeHistory, type RuntimeHistoryClient } from '../server/runtime-history.ts';
import { ProviderAccountStore } from '../server/provider-accounts.ts';

const base = resolve('test-results/runtime-history'); mkdirSync(base, { recursive: true });
const run = mkdtempSync(join(base, 'run-')), application = join(run, 'application'), home = join(run, 'home');
const directory = join(run, 'project'); mkdirSync(directory); mkdirSync(home);
process.env = { ...testEnvironment(run), RIVLOOM_DATA_DIR: application, HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
const { startEngine, engineRoot, engineDatabasePath, ENGINE_VERSION } = await import('../server/engine.ts');
const { AccountEnginePool } = await import('../server/account-engines.ts');
const fixture = await modelFixture(); fixture.configure(application); fixture.release();
const original = join(directory, 'keep.txt'); writeFileSync(original, 'Original project file.\n');
const accounts = new ProviderAccountStore(engineRoot), account = accounts.create('fixture', 'Synthetic disconnected account');
const accountRoot = accounts.directory(account.id), configDirectory = join(accountRoot, 'config', 'opencode');
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, 'opencode.json'), readFileSync(join(engineRoot, 'config', 'opencode', 'opencode.json')));
const marker = join(accountRoot, 'data', 'opencode', 'preserve.txt'); mkdirSync(join(marker, '..'), { recursive: true }); writeFileSync(marker, 'KEEP_ACCOUNT_DATA');
let main: Awaited<ReturnType<typeof startEngine>> | undefined, old: Awaited<ReturnType<typeof startEngine>> | undefined;
let db: DatabaseSync | undefined;
const pool = new AccountEnginePool(accounts);
const report: { status: string; checks: string[]; engineVersion: string; syntheticRequests?: number; maintenanceRequests?: number; error?: string } =
  { status: 'running', checks: [], engineVersion: ENGINE_VERSION };
async function seed(client: RuntimeHistoryClient, title: string) {
  const session = (await client.session.create({ directory, title })).data!;
  await client.session.promptAsync({ directory, sessionID: session.id, model: { providerID: 'fixture', modelID: 'm34' },
    parts: [{ type: 'text', text: title + ': return a short synthetic response; no tools.' }] });
  await until(async () => {
    const [status, messages] = await Promise.all([client.session.status({ directory }), client.session.messages({ directory, sessionID: session.id })]);
    return !status.data?.[session.id] && messages.data?.some(message => message.info.role === 'assistant' && message.info.time.completed);
  }, Boolean, 'synthetic session completed');
  return session;
}
function retained(root: string, sessionID: string) {
  const runtime = new DatabaseSync(engineDatabasePath(root), { readOnly: true });
  try { return createHash('sha256').update(JSON.stringify({
    session: runtime.prepare('SELECT * FROM session WHERE id=?').get(sessionID),
    messages: runtime.prepare('SELECT * FROM message WHERE session_id=? ORDER BY id').all(sessionID),
    parts: runtime.prepare('SELECT * FROM part WHERE session_id=? ORDER BY id').all(sessionID),
    events: runtime.prepare('SELECT * FROM event WHERE aggregate_id=? ORDER BY id').all(sessionID),
  })).digest('hex'); } finally { runtime.close(); }
}
function absent(root: string, sessionID: string) {
  const runtime = new DatabaseSync(engineDatabasePath(root), { readOnly: true });
  try {
    for (const [table, column] of [['session', 'id'], ['message', 'session_id'], ['part', 'session_id'], ['event', 'aggregate_id'], ['event_sequence', 'aggregate_id']] as const)
      assert.equal(runtime.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(sessionID)?.n, 0, `${table} retained purged session`);
  } finally { runtime.close(); }
}
try {
  main = await startEngine(application, 0, engineRoot);
  old = await startEngine(application, 0, accountRoot, { providerID: 'fixture' });
  const current = await seed(main.client, 'PURGE_CURRENT'), previous = await seed(old.client, 'PURGE_PREVIOUS'), keep = await seed(old.client, 'KEEP_UNRELATED');
  const before = retained(accountRoot, keep.id);
  db = new DatabaseSync(join(run, 'history.sqlite'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE task_engine_routes(task_id TEXT,account_id TEXT);
    CREATE TABLE task_context_runs(task_id TEXT,engine_root TEXT,session_id TEXT,directory TEXT,body TEXT);`);
  db.prepare('INSERT INTO projects VALUES(?,?)').run('p', directory);
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('delete', JSON.stringify({ projectID: 'p', sessionID: current.id }));
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('keep', JSON.stringify({ projectID: 'p', sessionID: keep.id }));
  db.prepare('INSERT INTO task_engine_routes VALUES(?,?)').run('keep', account.id);
  db.prepare('INSERT INTO task_context_runs VALUES(?,?,?,?,?)').run('delete', accountRoot, previous.id, directory, JSON.stringify({ accountID: account.id }));
  const members = { local: ['delete'], remote: [], brain: [], workflow: [], requests: [] };
  let fail = true;
  const options = { engineRoot, withClient: async <T>(binding: { accountID: string }, work: (client: RuntimeHistoryClient) => Promise<T>) => {
    if (fail) { fail = false; throw new Error('synthetic transport interruption'); }
    return binding.accountID ? pool.maintenance(binding.accountID, work) : work(main!.client);
  } };
  let cleanup = new RuntimeHistory(db, options); cleanup.prepare('local:delete', members);
  await assert.rejects(cleanup.purge('local:delete', members), { code: 'runtime_unavailable' });
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_history_cleanup WHERE done=0').get()?.n, 2);
  await old.waitForExit(); old = undefined; accounts.remove(account.id);
  db.close(); db = new DatabaseSync(join(run, 'history.sqlite')); cleanup = new RuntimeHistory(db, options);
  const callsBefore = fixture.requests;
  await cleanup.purge('local:delete', members);
  report.maintenanceRequests = fixture.requests - callsBefore; assert.equal(report.maintenanceRequests, 0);
  absent(engineRoot, current.id); absent(accountRoot, previous.id); assert.equal(retained(accountRoot, keep.id), before);
  assert.equal(readFileSync(original, 'utf8'), 'Original project file.\n'); assert.equal(readFileSync(marker, 'utf8'), 'KEEP_ACCOUNT_DATA');
  assert.equal(accounts.list().length, 0);
  await cleanup.purge('local:delete', members); cleanup.finish('local:delete');
  assert.equal(db.prepare('SELECT count(*) n FROM runtime_history_cleanup').get()?.n, 0);
  report.checks.push('Persisted cleanup survives a failed attempt and database reopen',
    'Current and previous-account sessions are removed through the pinned official Runtime API',
    'Disconnected account maintenance removes session/message/part/event/event_sequence without inference',
    'Unrelated session bytes, account data and project originals are unchanged', 'Repeated cleanup is idempotent');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); process.exitCode = 1; }
finally {
  await pool.close(true); await old?.waitForExit(); await main?.waitForExit(); db?.close(); await fixture.close();
  report.syntheticRequests = fixture.requests;
  writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report }, null, 2));
}
