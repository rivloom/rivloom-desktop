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
    await assert.rejects(read({ file: 'helper.js', revision: entry.revision, materialize: true, offset: 9999 }), /invalid_offset/);
    assert(!existsSync(join(f.task.directory, '.rivloom-knowledge')));
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

for (const [name, content] of [
  ['Chinese', '长期知识'.repeat(8000)], ['emoji', '😀🚀'.repeat(8000)],
  ['escaped JSON', '汉"\\\n\t😀'.repeat(4500)],
] as const) test(`knowledge reads round-trip ${name} within 32 KiB and record exact successful ranges`, async () => {
  const f = fixture();
  try {
    const entry = f.store.saveMemory({ name, description: '分页资料', category: 'Projects/Fixture', body: content, projectID: f.task.projectID }, 'user');
    const ref = { brainID: null, nodeID: entry.nodeID, id: entry.id };
    const call = (args: object) => f.tools.call(f.task.sessionID, f.task.directory, 'rivloom_knowledge_read', { ...ref, ...args });
    await f.tools.call(f.task.sessionID, f.task.directory, 'rivloom_knowledge_search', {});
    assert.equal(f.tools.usage(f.task.id).total, 0);
    await assert.rejects(call({ revision: 'f'.repeat(64) }), /revision_changed/);
    await assert.rejects(call({ offset: 1 }), /revision_required/);
    assert.equal(f.tools.usage(f.task.id).total, 0);
    let offset = 0, joined = '', pages = 0;
    while (true) {
      const page = await call({ revision: entry.revision, offset }) as { content: string; nextOffset: number | null; totalCharacters: number; offsetUnit: string };
      assert(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024);
      assert.equal(Buffer.from(page.content).toString('utf8'), page.content); assert.equal(page.offsetUnit, 'utf16');
      assert.equal(page.totalCharacters, content.length); joined += page.content; pages++;
      if (page.nextOffset === null) break;
      assert(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert(pages > 1); assert.equal(joined, content);
    const usage = f.tools.usage(f.task.id);
    assert.equal(usage.total, pages); assert.equal(usage.entries[0].nextOffset, null);
    assert(usage.entries.every(v => v.revision === entry.revision && v.sessionID === f.task.sessionID && v.reference.id === entry.id));
    assert(!JSON.stringify(usage).includes('content":')); assert(!JSON.stringify(usage).includes(f.task.directory));
    const reopened = new KnowledgeTools(f.store, f.network, () => f.task);
    try { assert.deepEqual(reopened.usage(f.task.id), usage); } finally { reopened.close(); }
    await assert.rejects(call({ revision: entry.revision, offset: content.length + 1 }), /invalid_offset/);
    assert.equal(f.tools.usage(f.task.id).total, pages);
    f.tools.removeTasks([f.task.id]); assert.equal(f.tools.usage(f.task.id).total, 0);
  } finally { f.close(); }
});

test('long Skill instructions require all pages before assets and paginate supporting-file metadata', async () => {
  const f = fixture();
  try {
    const source = join(f.root, 'paged-skill'); mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: paged\ndescription: Large instructions\n---\n' + '执行约束'.repeat(20_000));
    for (let i = 0; i < 25; i++) writeFileSync(join(source, `support-${i}.md`), `support ${i}`);
    const entry = await f.store.registerSkill(source, null);
    const ref = { brainID: null, nodeID: entry.nodeID, id: entry.id, revision: entry.revision };
    const read = (args: object) => f.tools.call(f.task.sessionID, f.task.directory, 'rivloom_knowledge_read', { ...ref, ...args });
    let page = await read({}) as { nextOffset: number | null; files: { path: string }[]; nextManifestOffset: number | null };
    assert.equal(page.files.length, 20); assert.equal(page.nextManifestOffset, 20);
    await assert.rejects(read({ file: 'support-0.md' }), /instructions_first/);
    while (page.nextOffset !== null) page = await read({ offset: page.nextOffset }) as typeof page;
    assert.equal((await read({ file: 'support-0.md' }) as { content: string }).content, 'support 0');
    const last = await read({ manifestOffset: 20 }) as typeof page;
    assert.equal(last.files.length, 6); assert.equal(last.nextManifestOffset, null);
  } finally { f.close(); }
});

test('knowledge bridge binds tools to engine account and rechecks identity before recording a read', async () => {
  const f = fixture(); const allowed = join(f.root, 'account-a'); let run = 'run-one';
  const bridge = await startKnowledgeBridge(() => f.tools, undefined, undefined, (root, session, directory) => {
    if (root !== allowed.toLowerCase() && root !== allowed || session !== f.task.sessionID || directory !== f.task.directory)
      throw new Error('context_execution_changed');
    return run;
  });
  try {
    const entry = f.store.saveMemory({ name: 'Scoped', description: '', category: 'Tests', body: 'PRIVATE-ACCOUNT-SOURCE', projectID: null }, 'user');
    const input = { name: 'rivloom_knowledge_read', sessionID: f.task.sessionID, directory: f.task.directory,
      args: { brainID: null, nodeID: entry.nodeID, id: entry.id, revision: entry.revision } };
    const request = (config: NonNullable<ReturnType<typeof knowledgeEngineConfig>>) => fetch(config.url, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: JSON.stringify(input),
    });
    assert.equal((await request(knowledgeEngineConfig()!)).status, 403);
    assert.equal((await request(knowledgeEngineConfig(join(f.root, 'account-b'))!)).status, 409);
    assert.equal(f.tools.usage(f.task.id).total, 0);
    assert.equal((await request(knowledgeEngineConfig(allowed)!)).status, 200);
    assert.equal(f.tools.usage(f.task.id).total, 1);
    const original = f.network.file.bind(f.network);
    f.network.file = async (...args) => { const result = await original(...args); run = 'run-two'; return result; };
    const response = await request(knowledgeEngineConfig(allowed)!);
    assert.equal(response.status, 409); assert(!JSON.stringify(await response.json()).includes('PRIVATE-ACCOUNT-SOURCE'));
    assert.equal(f.tools.usage(f.task.id).total, 1);
  } finally { await bridge.close(); f.close(); }
});
