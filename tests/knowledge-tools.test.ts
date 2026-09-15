import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { KnowledgeNetwork } from '../server/knowledge-network.ts';
import { KnowledgeTools, type KnowledgeTask } from '../server/knowledge-tools.ts';
import { startKnowledgeBridge, knowledgeEngineConfig } from '../server/knowledge-engine.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-knowledge-tools-'));
  const store = new KnowledgeStore(root, 't'.repeat(32)); const directory = join(root, 'project'); mkdirSync(directory);
  const task: KnowledgeTask = { id: randomUUID(), sessionID: 'ses_fixture', directory, projectID: randomUUID(), privateLocal: true, brainIDs: [], canWriteMemory: true };
  let active = true;
  const network = new KnowledgeNetwork(store, { snapshot: () => ({ local: null, paired: [], brains: [] }), trusted: () => false, request: async () => { throw new Error('unexpected_network'); } });
  const authorize = (session: string, path: string) => { if (!active || session !== task.sessionID || path !== directory) throw new Error('knowledge_task_not_active'); return { ...task }; };
  const tools = new KnowledgeTools(store, network, authorize);
  return { root, store, network, task, tools, active(value: boolean) { active = value; },
    close() { tools.close(); network.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('task tools scope private knowledge and forbid planner writes, unknown sessions and stale memory updates', async () => {
  const f = fixture();
  try {
    const entry = f.store.saveMemory({ name: 'My work', description: 'scope', category: 'Work', body: 'Known facts', projectID: null }, 'user');
    f.store.saveMemory({ name: 'Other project', description: '', category: 'Work', body: 'Invisible', projectID: randomUUID() }, 'user');
    const call = (name: string, args: unknown) => f.tools.call(f.task.sessionID, f.task.directory, name, args);
    const list = await call('rivloom_knowledge_search', {}) as { entries: { name: string }[] };
    assert.deepEqual(list.entries.map((v) => v.name), ['My work']);
    f.task.privateLocal = false;
    await assert.rejects(call('rivloom_knowledge_read', { brainID: null, nodeID: entry.nodeID, id: entry.id }), /not_authorized/);
    f.task.privateLocal = true; f.task.canWriteMemory = false;
    await assert.rejects(call('rivloom_memory_save', { name: 'Forbidden', description: '', category: 'Work', body: 'no', projectID: f.task.projectID }), /write_denied/);
    f.task.canWriteMemory = true;
    const edit = { id: entry.id, expectedRevision: entry.revision, name: entry.name, description: '', category: 'Work', body: 'changed', projectID: null };
    await assert.rejects(call('rivloom_memory_save', edit), /read_before_edit/);
    await call('rivloom_knowledge_read', { brainID: null, nodeID: entry.nodeID, id: entry.id });
    await call('rivloom_memory_save', edit);
    await assert.rejects(call('rivloom_memory_save', edit), /conflict/);
    f.active(false); await assert.rejects(call('rivloom_knowledge_search', {}), /not_active/);
  } finally { f.close(); }
});
test('skills load instructions before assets, pin revisions and materialize without executing', async () => {
  const f = fixture();
  try {
    const source = join(f.root, 'skill'); mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: report\ndescription: Report generation\n---\nRead helper.js');
    writeFileSync(join(source, 'helper.js'), 'throw new Error("never execute during load");');
    const entry = await f.store.registerSkill(source, null); const ref = { brainID: null, nodeID: entry.nodeID, id: entry.id };
    const read = (args: object) => f.tools.call(f.task.sessionID, f.task.directory, 'rivloom_knowledge_read', { ...ref, ...args });
    await assert.rejects(read({ file: 'helper.js' }), /instructions_first/);
    await read({});
    const result = await read({ file: 'helper.js', materialize: true }) as { localPath: string };
    assert(existsSync(join(f.task.directory, result.localPath)));
    assert.match(readFileSync(join(f.task.directory, result.localPath), 'utf8'), /never execute/);
    writeFileSync(join(source, 'helper.js'), 'new version');
    await assert.rejects(read({ file: 'helper.js' }), /revision_changed/);
  } finally { f.close(); }
});
test('private engine bridge rejects missing auth, browser origins and unknown sessions', async () => {
  const f = fixture(); const bridge = await startKnowledgeBridge(() => f.tools);
  try {
    const config = knowledgeEngineConfig()!;
    const body = JSON.stringify({ name: 'rivloom_knowledge_search', sessionID: f.task.sessionID, directory: f.task.directory, args: {} });
    assert.equal((await fetch(config.url, { method: 'POST', body })).status, 403);
    assert.equal((await fetch(config.url, { method: 'POST', body, headers: { Authorization: `Bearer ${config.token}`, Origin: 'https://example.invalid' } })).status, 403);
    const response = await fetch(config.url, { method: 'POST', body, headers: { Authorization: `Bearer ${config.token}` } });
    assert.equal(response.status, 200); assert(!JSON.stringify(await response.json()).includes(config.token));
    f.active(false);
    assert.equal((await fetch(config.url, { method: 'POST', body, headers: { Authorization: `Bearer ${config.token}` } })).status, 409);
  } finally { await bridge.close(); f.close(); }
});
