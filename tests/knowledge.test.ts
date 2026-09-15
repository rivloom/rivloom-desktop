import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { safeKnowledgePath } from '../shared/knowledge.ts';

const nodeID = 'a'.repeat(32);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-knowledge-'));
  const store = new KnowledgeStore(root, nodeID);
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('memories stay private, load progressively, preserve revisions and survive organization/restart', () => {
  const f = fixture();
  try {
    const brain = randomUUID();
    const m = f.store.saveMemory({ name: 'Person', description: 'Work facts', category: 'People/Person/Work',
      body: 'Owns the migration project.', projectID: null }, 'user');
    assert.deepEqual(f.store.listShared(brain).entries, []);
    assert(!JSON.stringify(f.store.listLocal()).includes('Owns the migration'));
    f.store.share(m.id, [brain], m.revision);
    assert.equal(f.store.listShared(brain).entries[0].id, m.id);
    const next = f.store.saveMemory({ id: m.id, expectedRevision: m.revision, name: m.name, description: m.description,
      category: m.category, body: 'Owns the migration and testing projects.', projectID: null }, 'task:one');
    assert.notEqual(next.revision, m.revision);
    assert.throws(() => f.store.saveMemory({ id: m.id, expectedRevision: m.revision, name: 'Stale', description: '',
      category: 'People', body: 'stale', projectID: null }, 'user'), /conflict/);
    assert.equal(f.store.history(m.id).length, 2);
    assert.equal(f.store.organize().entries, 1);
    assert.match(readFileSync(join(f.store.root, 'wiki', 'INDEX.md'), 'utf8'), /People/);
    const reopened = new KnowledgeStore(f.root, nodeID);
    try { assert.equal(reopened.listLocal()[0].revision, next.revision); } finally { reopened.close(); }
    f.store.share(m.id, [], next.revision);
    assert.throws(() => f.store.manifest(m.id, brain), /not_shared/);
  } finally { f.close(); }
});
test('skill sources refresh latest content, exclude secrets and reject stale revision reads', async () => {
  const f = fixture();
  try {
    const source = join(f.root, 'source'); mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: sample\ndescription: Make reports\n---\nUse scripts/report.js');
    writeFileSync(join(source, 'scripts', 'report.js'), 'export const version = 1;');
    writeFileSync(join(source, '.env'), 'DO_NOT_SHARE=secret');
    const first = await f.store.registerSkill(source, null); const brain = randomUUID();
    f.store.share(first.id, [brain], first.revision);
    const manifest = await f.store.refreshManifest(first.id, brain);
    assert.equal(manifest.files.length, 2);
    assert(!JSON.stringify(manifest).includes(source));
    writeFileSync(join(source, 'scripts', 'report.js'), 'export const version = 2;');
    const next = await f.store.refreshManifest(first.id, brain);
    assert.notEqual(next.entry.revision, first.revision);
    await assert.rejects(f.store.chunk(first.id, first.revision, 'SKILL.md', 0, brain), /revision_changed/);
    const chunk = await f.store.chunk(first.id, next.entry.revision, 'scripts/report.js', 0, brain);
    assert.match(Buffer.from(chunk.data, 'base64').toString(), /version = 2/);
    assert.throws(() => f.store.manifest(first.id, randomUUID()), /not_shared/);
  } finally { f.close(); }
});
test('knowledge paths reject traversal, device names and alternate streams', () => {
  for (const path of ['../x', '/absolute', 'a\\b', 'a:stream', 'con.txt', 'a/../b', 'a./b']) assert(!safeKnowledgePath(path), path);
  assert(safeKnowledgePath('People/Alice/Work.md'));
});
test('category sharing is atomic and rejects stale grants; linked folders cannot expose unrelated files', async () => {
  const f = fixture();
  try {
    const brain = randomUUID();
    const one = f.store.saveMemory({ name: 'One', description: '', category: 'People/One', body: 'one', projectID: null }, 'user');
    const two = f.store.saveMemory({ name: 'Two', description: '', category: 'People/Two', body: 'two', projectID: null }, 'user');
    f.store.share(two.id, [], two.revision, two.updatedAt);
    const refs = [one, two].map(({id,revision,updatedAt}) => ({id,revision,updatedAt}));
    assert.throws(() => f.store.shareMany(refs, [brain]), /conflict/);
    assert.equal(f.store.listShared(brain).entries.length, 0);
    const current = f.store.localEntry(two.id); refs[1].updatedAt = current.updatedAt;
    f.store.shareMany(refs, [brain]); assert.equal(f.store.listShared(brain).entries.length, 2);
    const source = join(f.root, 'skill'); mkdirSync(source); const outside = join(f.root, 'outside'); mkdirSync(outside);
    writeFileSync(join(source, 'SKILL.md'), '---\nname: unsafe\ndescription: no outside files\n---\nInstructions');
    writeFileSync(join(outside, 'private.md'), 'unrelated');
    symlinkSync(outside, join(source, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.store.registerSkill(source, null), /unsafe/);
  } finally { f.close(); }
});
