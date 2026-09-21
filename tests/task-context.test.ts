import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { TaskContextStore, contextSource, contextRevision } from '../server/task-context.ts';
import { startKnowledgeBridge, knowledgeEngineConfig } from '../server/knowledge-engine.ts';

const pluginURL = new URL('../server/context-plugin.mjs', import.meta.url).href;
const { contextHooks } = await import(pluginURL);
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('task'),('other')");
  let active = true;
  const store = new TaskContextStore(db, () => active);
  const root = resolve('fixture-engine'), directory = resolve('fixture-project');
  const prepare = (system = 'PINNED_RULES', sessionID = 'session', taskID = 'task', accountID = '') => store.prepare({
    taskID, projectID: 'project', sessionID, runAfter: 100, accountID, engineRoot: root, directory, system,
    sources: [contextSource('policy', system), contextSource('request', 'private request')] });
  const id = { sessionID: 'session', directory, messageID: 'user', createdAt: 110 };
  return { db, store, root, directory, prepare, id, active(value: boolean) { active = value; } };
}

test('context snapshots isolate runs, accounts, directories and stale observations; deletion cascades', () => {
  const f = fixture();
  try {
    const first = f.prepare();
    const restored = f.store.call(f.root, { ...f.id, operation: 'resolve' });
    assert.ok(restored && 'system' in restored); assert.equal(restored.system, 'PINNED_RULES');
    assert.equal(f.store.call(resolve('different-engine'), { ...f.id, operation: 'resolve' }), null);
    assert.throws(() => f.store.call(f.root, { ...f.id, directory: resolve('other-project'), operation: 'resolve' }), /execution_changed/);
    assert.throws(() => f.store.call(f.root, { ...f.id, createdAt: 99, operation: 'resolve' }), /execution_changed/);
    assert.equal(f.store.call(f.root, { ...f.id, createdAt: 99, operation: 'restore' }), null);
    f.active(false); assert.throws(() => f.store.call(f.root, { ...f.id, operation: 'resolve' }), /execution_changed/); f.active(true);
    const second = f.prepare('NEW_RULES');
    assert.notEqual(second.id, first.id);
    const observe = { ...f.id, operation: 'observe', contextID: first.id, agent: 'build', model: 'test/model', systemRevision: contextRevision('PINNED_RULES'), restored: false };
    assert.throws(() => f.store.call(f.root, observe), /execution_changed/);
    assert.equal(f.db.prepare('SELECT system FROM task_context_runs WHERE id=?').get(first.id)!.system, null);
    assert.throws(() => f.store.call(f.root, { ...observe, contextID: second.id }), /system_mismatch/);
    assert.equal(f.store.list('task').records[0].observations[0].system, 'mismatch');
    f.prepare('SWITCHED', 'new-session', 'task', 'account-two');
    assert.throws(() => f.store.call(f.root, { ...f.id, operation: 'resolve' }), /execution_changed/);
    f.db.prepare('DELETE FROM tasks WHERE id=?').run('task');
    assert.equal(f.store.list('task').total, 0);
  } finally { f.db.close(); }
});

test('context observations are bounded metadata and distinguish summarization from execution', () => {
  const f = fixture();
  try {
    const record = f.prepare('SECRET_SOURCE_BODY');
    for (let i = 0; i < 55; i++) f.store.call(f.root, { ...f.id, operation: 'observe', contextID: record.id,
      agent: 'compaction', model: 'test/model', systemRevision: null, restored: false });
    const snapshot = f.store.list('task');
    assert.equal(snapshot.records[0].sources[0].inclusion, 'system');
    assert.equal(snapshot.records[0].sources[1].inclusion, 'message');
    assert.equal(contextSource('attachment', 'reference', 'file').inclusion, 'reference');
    assert.equal(snapshot.records[0].observationCount, 55);
    assert.equal(snapshot.records[0].observations.length, 50);
    assert.equal(snapshot.records[0].observations[0].system, 'not_applicable');
    assert.ok(!JSON.stringify(snapshot).includes('SECRET_SOURCE_BODY'));
    assert.ok(!JSON.stringify(snapshot).includes('private request'));
    assert.throws(() => f.store.call(f.root, { ...f.id, operation: 'observe' }), /invalid_request/);
  } finally { f.db.close(); }
});

test('history bridge tools require an active session and its engine scope; knowledge tokens and stale accounts cannot read', async () => {
  const f = fixture(); f.prepare();
  const { historyTools } = await import(new URL('../server/history-plugin.mjs', import.meta.url).href);
  const bridge = await startKnowledgeBridge(() => null, (root, raw) => f.store.call(root, raw), (root, raw) => {
    const body = raw as { sessionID: string; directory: string };
    return { taskID: f.store.authorize(root, body.sessionID, body.directory).taskID, result: 'SCOPED_HISTORY' };
  });
  try {
    const config = knowledgeEngineConfig(f.root)!;
    const tool = historyTools(config.context).rivloom_history;
    const context = { sessionID: f.id.sessionID, directory: f.directory, ask: async () => {}, abort: new AbortController().signal };
    assert.match(await tool.execute({ action: 'state' }, context), /SCOPED_HISTORY/);
    const forbidden = await fetch(config.context!.url.replace('/context', '/history'), { method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ sessionID: f.id.sessionID, directory: f.directory }) });
    assert.equal(forbidden.status, 403);
    const foreign = historyTools(knowledgeEngineConfig(resolve('other-engine'))!.context).rivloom_history;
    await assert.rejects(foreign.execute({ action: 'state' }, context), /execution_changed/);
    await assert.rejects(tool.execute({ action: 'state' }, { ...context, directory: resolve('other-project') }), /execution_changed/);
    f.active(false); await assert.rejects(tool.execute({ action: 'state' }, context), /execution_changed/); f.active(true);
    f.prepare('NEW', 'new-session', 'task', 'account-two');
    await assert.rejects(tool.execute({ action: 'state' }, context), /execution_changed/);
  } finally { await bridge.close(); f.db.close(); }
});

test('fixed-runtime hooks restore only synthetic continuation, preserve explicit input and record actual preparation', async () => {
  const f = fixture(); f.prepare();
  const bridge = await startKnowledgeBridge(() => null, (root, body) => f.store.call(root, body));
  try {
    const config = knowledgeEngineConfig(f.root)!.context!;
    const hooks = contextHooks({ ...config, directory: f.directory });
    const user = (id: string, system?: string, synthetic = false) => ({ info: { id, sessionID: 'session', role: 'user', time: { created: 110 }, ...(system !== undefined ? { system } : {}) },
      parts: [{ type: 'text', text: 'continue', synthetic, metadata: { compaction_continue: synthetic } }] });
    const params = (message: ReturnType<typeof user>, agent = 'build') => hooks['chat.params']({ sessionID: 'session', agent,
      model: { providerID: 'test', id: 'model' }, message: message.info }, {});
    const original = user('explicit', 'PINNED_RULES');
    await hooks['experimental.chat.messages.transform']({}, { messages: [original] }); await params(original);
    const summary = user('compact'); await params(summary, 'compaction');
    for (let i = 0; i < 2; i++) {
      const automatic = user(`automatic-${i}`, undefined, true);
      await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { id: 'summary', role: 'assistant', summary: true }, parts: [] }, automatic] });
      assert.equal(automatic.info.system, 'PINNED_RULES'); await params(automatic);
    }
    const explicit = user('wrong', 'OTHER_RULES');
    await hooks['experimental.chat.messages.transform']({}, { messages: [explicit] });
    assert.equal(explicit.info.system, 'OTHER_RULES'); await assert.rejects(params(explicit), /system_mismatch/);
    const missing = user('missing');
    await hooks['experimental.chat.messages.transform']({}, { messages: [missing] });
    assert.equal(missing.info.system, undefined); await assert.rejects(params(missing), /system_mismatch/);
    const historical = user('old-summary-input', undefined, true); historical.info.time.created = 99;
    await hooks['experimental.chat.messages.transform']({}, { messages: [historical] });
    assert.equal(historical.info.system, undefined);
    await assert.rejects(params(historical), /execution_changed/);
    const snapshots = f.store.list('task').records[0];
    assert.deepEqual(snapshots.observations.map(value => value.system), ['matched', 'not_applicable', 'restored', 'restored', 'mismatch', 'mismatch']);
    assert.deepEqual(snapshots.observations[2].summaryIDs, ['summary']);
    await params(original, 'custom-executor');
    assert.equal(f.store.list('task').records[0].observations.at(-1)!.agent, 'custom-executor');
    const otherConfig = knowledgeEngineConfig(resolve('different-engine'))!.context!;
    assert.notEqual(otherConfig.token, config.token);
    const denied = await fetch(config.url, { method: 'POST', headers: { Authorization: `Bearer ${knowledgeEngineConfig()!.token}` }, body: '{}' });
    assert.equal(denied.status, 403);
    const other = contextHooks({ ...otherConfig, directory: f.directory });
    const foreign = user('foreign', undefined, true);
    await other['experimental.chat.messages.transform']({}, { messages: [foreign] });
    assert.equal(foreign.info.system, undefined);
    await hooks.dispose(); await other.dispose();
  } finally { await bridge.close(); f.db.close(); }
});
