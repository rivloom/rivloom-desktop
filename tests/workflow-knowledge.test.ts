import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { WorkflowStore } from '../server/workflows.ts';
import { WorkflowKnowledge } from '../server/workflow-knowledge.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-workflow-knowledge-'));
  const store = new KnowledgeStore(root, 'k'.repeat(32)); const db = new DatabaseSync(':memory:');
  const workflows = new WorkflowStore(db);
  const workflow = workflows.create({ requestID: randomUUID(), creatorID: 'owner', title: 'Sourced memory',
    description: '保留原图。交付 PNG。后续改用 JPG。', criteria: 'Use current requirements.', projectID: randomUUID(),
    model: null, target: { mode: 'automatic' }, approvalMode: 'ask', inputFiles: [] });
  const service = new WorkflowKnowledge(store, workflows.history);
  const note = (text: string, authority: 'user' | 'inferred' = 'user', supersedes?: string) => {
    const state = workflows.history.state(workflow);
    return workflows.history.note(workflow, { requestID: randomUUID(), expectedVersion: state.version, kind: 'decision', text,
      source: { id: state.goal.id, revision: state.goal.revision, quote: text }, ...(supersedes ? { supersedes } : {}) }, authority);
  };
  const input = (noteID: string) => ({ requestID: randomUUID(), expectedVersion: workflows.history.state(workflow).version,
    noteID, name: 'Output format', description: 'Confirmed project choice', category: 'Projects/Fixture/Decisions' });
  return { root, store, db, workflows, workflow, service, note, input,
    close() { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('confirmed session notes become private project Wiki with exact sources and idempotent durable receipts', () => {
  const f = fixture();
  try {
    const note = f.note('交付 PNG'); const input = f.input(note.id);
    const saved = f.service.promote(f.workflow, input);
    assert.equal(saved.projectID, f.workflow.projectID); assert.equal(saved.status, 'active');
    assert.equal(saved.provenance.authority, 'user'); assert.deepEqual(saved.provenance.source, note.source);
    assert.deepEqual(f.store.localEntry(saved.id).sharedBrains, []);
    const body = f.store.readMemory(saved.id).body;
    assert(body.includes(note.source.quote)); assert(body.includes(note.source.revision)); assert(body.includes(f.workflow.id));
    assert.deepEqual(f.service.promote(f.workflow, input), saved); assert.equal(f.store.listLocal().length, 1);
    assert.throws(() => f.service.promote(f.workflow, { ...input, name: 'Different receipt' }), /operation_conflict/);
    const reopened = new KnowledgeStore(f.root, f.store.nodeID);
    try {
      const service = new WorkflowKnowledge(reopened, f.workflows.history);
      assert.deepEqual(service.promote(f.workflow, input), saved); assert.deepEqual(service.list(f.workflow), [saved]);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('models cannot confirm or replace promoted memory, and stale, withdrawn or unrelated sources cannot be promoted', () => {
  const f = fixture();
  try {
    const inferred = f.note('交付 PNG', 'inferred');
    assert.throws(() => f.service.promote(f.workflow, f.input(inferred.id)), /note_unconfirmed/);
    assert.throws(() => f.service.promote(f.workflow, { ...f.input(inferred.id), authority: 'user' }));
    const confirmed = f.note('交付 PNG', 'user', inferred.id), input = f.input(confirmed.id);
    assert.throws(() => f.service.promote({ ...f.workflow, projectID: null }, input), /project_required/);
    assert.throws(() => f.service.promote(f.workflow, { ...input, expectedVersion: input.expectedVersion - 1 }), /state_version_conflict/);
    const saved = f.service.promote(f.workflow, input);
    assert.throws(() => f.store.saveMemory({ id: saved.id, expectedRevision: saved.revision, name: saved.name, description: '',
      category: 'Projects/Fixture', projectID: f.workflow.projectID, body: 'Model invents new confirmed policy' }, 'task:test'), /confirmation_required/);
    f.workflows.history.withdraw(f.workflow, { requestID: randomUUID(), expectedVersion: f.workflows.history.state(f.workflow).version, id: confirmed.id });
    assert.throws(() => f.service.promote(f.workflow, f.input(confirmed.id)), /note_not_active/);
    const replacement = f.note('后续改用 JPG');
    const privateOther = f.store.saveMemory({ name: 'Other project', description: '', category: 'Other', body: 'private', projectID: randomUUID() }, 'user');
    assert.throws(() => f.service.promote(f.workflow, { ...f.input(replacement.id), id: privateOther.id, expectedRevision: privateOther.revision }), /not_linked/);
    assert.equal(f.store.readMemory(saved.id).body.includes('Model invents'), false);
  } finally { f.close(); }
});

test('owner replacement preserves Wiki versions and withdrawal stops reads without deleting source history', () => {
  const f = fixture();
  try {
    const original = f.note('交付 PNG'); const first = f.service.promote(f.workflow, f.input(original.id));
    const next = f.note('后续改用 JPG', 'user', original.id);
    const update = { ...f.input(next.id), id: first.id, expectedRevision: first.revision };
    const second = f.service.promote(f.workflow, update);
    assert.equal(second.id, first.id); assert.notEqual(second.revision, first.revision);
    assert.equal(second.provenance.noteID, next.id);
    assert.equal(f.store.history(second.id).length, 2); assert(f.store.history(second.id).some(v => v.body?.includes('交付 PNG')));
    assert.throws(() => f.service.promote(f.workflow, { ...update, requestID: randomUUID() }), /revision_conflict/);
    const brain = randomUUID(); f.store.share(second.id, [brain], second.revision);
    const request = { requestID: randomUUID(), id: second.id, expectedRevision: second.revision };
    const withdrawn = f.service.withdraw(f.workflow, request);
    assert.equal(withdrawn.status, 'withdrawn'); assert.notEqual(withdrawn.revision, second.revision);
    assert.deepEqual(f.service.withdraw(f.workflow, request), withdrawn);
    assert.equal(f.store.listShared(brain).entries.length, 0);
    assert.throws(() => f.store.manifest(second.id), /memory_withdrawn/);
    assert(f.store.readMemory(second.id).body.includes('后续改用 JPG'));
    assert.equal(f.store.history(second.id).length, 3);
    assert.deepEqual(f.service.list(f.workflow), [withdrawn]);
    assert.throws(() => f.service.withdraw({ ...f.workflow, id: randomUUID() }, { ...request, requestID: randomUUID() }), /not_linked/);
  } finally { f.close(); }
});

test('confirmed source validation spans history pages and rejects fabricated quote data', () => {
  const f = fixture();
  try {
    f.workflow.description = Array.from({ length: 4000 }, (_, i) => `原始资料${i.toString().padStart(4, '0')}|`).join('');
    const state = f.workflows.history.state(f.workflow);
    const first = f.workflows.history.query(f.workflow, { action: 'read', id: state.goal.id, revision: state.goal.revision }) as { nextOffset: number };
    const quote = f.workflow.description.slice(first.nextOffset - 3, first.nextOffset + 4);
    const note = f.workflows.history.note(f.workflow, { requestID: randomUUID(), expectedVersion: state.version, kind: 'constraint', text: 'Preserve source',
      source: { id: state.goal.id, revision: state.goal.revision, quote } }, 'user');
    assert.equal(f.service.promote(f.workflow, f.input(note.id)).provenance.source.quote, quote);
    const row = f.db.prepare('SELECT body FROM workflow_notes WHERE id=?').get(note.id)!;
    const corrupt = { ...JSON.parse(String(row.body)), source: { ...note.source, quote: 'INVENTED QUOTE' } };
    f.db.prepare('UPDATE workflow_notes SET body=? WHERE id=?').run(JSON.stringify(corrupt), note.id);
    assert.throws(() => f.service.promote(f.workflow, f.input(note.id)), /source_changed/);
  } finally { f.close(); }
});

test('owner edits are visibly different from the promoted source and explicit removal clears receipt content without replay resurrection', () => {
  const f = fixture();
  try {
    const note = f.note('保留原图'), input = f.input(note.id), first = f.service.promote(f.workflow, input);
    const updated = f.store.saveMemory({ id: first.id, expectedRevision: first.revision, name: first.name, description: '',
      category: 'Projects/Fixture', projectID: f.workflow.projectID, body: 'Owner-edited reference with additional explanation.' }, 'user');
    assert.equal(f.service.list(f.workflow)[0].status, 'changed');
    assert.deepEqual(f.service.list(f.workflow)[0].provenance.source, note.source);
    f.store.remove(first.id, updated.revision);
    assert.equal(f.service.list(f.workflow).length, 0);
    assert.throws(() => f.service.promote(f.workflow, input), /not_found/);
    const inspection = new DatabaseSync(join(f.store.root, 'library.sqlite'));
    try {
      assert.deepEqual(inspection.prepare('SELECT body FROM memory_actions').all().map(row => String(row.body)), ['{"removed":true}']);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM versions WHERE id=?').get(first.id)!.n, 0);
    } finally { inspection.close(); }
  } finally { f.close(); }
});
