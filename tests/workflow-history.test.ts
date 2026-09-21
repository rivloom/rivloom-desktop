import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore, workflowStep } from '../server/workflows.ts';
import type { Workflow, WorkflowRound } from '../shared/workflows.ts';
import { WorkflowHistoryAccess, type HistoryRemoteExecution } from '../server/workflow-history-access.ts';
import { workflowContextDigest } from '../server/workflow-contexts.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const store = new WorkflowStore(db);
  const value = store.create({ requestID: randomUUID(), creatorID: 'owner', title: 'Context',
    description: '保留原图，输出 PNG。'.repeat(400), criteria: '只修改当前项目', projectID: null, model: null, target: { mode: 'automatic' }, approvalMode: 'ask', inputFiles: [] });
  return { db, store, value };
}
function archive(value: Workflow): WorkflowRound {
  return { ...structuredClone(value), requestID: value.roundRequestID || value.requestID, createdAt: value.roundCreatedAt || value.createdAt };
}
for (const [name, source] of [
  ['ASCII', 'history '.repeat(12_000)],
  ['Chinese', '历史分页汉字'.repeat(6_000)],
  ['surrogate pairs', '😀🚀'.repeat(10_000)],
  ['JSON escapes', '汉"\\\n\t\u0000😀'.repeat(8_000)],
  ['million-character stored source', '历史'.repeat(500_000)],
] as const) test(`32 KiB history pages round-trip ${name} with metadata and UTF-16 offsets`, () => {
  const { db, store, value } = fixture();
  try {
    // Exercise already-stored sources; the separate user-input size limit is unchanged.
    value.description = source;
    const ref = store.history.state(value).goal;
    let offset = 0, content = '', pages = 0;
    while (true) {
      const page = store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision, offset }) as {
        content: string; offset: number; nextOffset: number | null; totalCharacters: number; offsetUnit: string;
      };
      const bytes = Buffer.byteLength(JSON.stringify(page));
      assert(bytes <= 32 * 1024, `Serialized page exceeded budget: ${bytes}`);
      assert.equal(page.offset, offset); assert.equal(page.offsetUnit, 'utf16');
      assert.equal(page.totalCharacters, source.length);
      assert(page.content.length > 0); assert.equal(Buffer.from(page.content).toString('utf8'), page.content);
      content += page.content; pages++;
      if (page.nextOffset === null) break;
      assert(bytes > 32 * 1024 - 16, `Nonfinal page wasted its byte budget: ${bytes}`);
      assert.equal(page.nextOffset, offset + page.content.length);
      offset = page.nextOffset;
      assert(pages < 200, 'Pagination did not make progress');
    }
    assert(pages > 1); assert.equal(content, source);
    const eof = store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision, offset: source.length }) as { content: string; nextOffset: number | null };
    assert.equal(eof.content, ''); assert.equal(eof.nextOffset, null);
    assert.throws(() => store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision, offset: source.length + 1 }), /invalid_offset/);
  } finally { db.close(); }
});

test('history pages preserve exact multilingual sources, revisions, round and workflow boundaries across restart', () => {
  const { db, store, value } = fixture();
  try {
    const state = store.history.state(value), ref = state.goal;
    let read = store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision }) as { content: string; nextOffset: number | null };
    let content = read.content;
    while (read.nextOffset !== null) { read = store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision, offset: read.nextOffset }) as typeof read; content += read.content; }
    assert.equal(content, value.description);
    const next = store.update(value.id, current => { current.rounds = [archive(current)]; current.roundRequestID = randomUUID(); current.description = '现在改用 JPG'; });
    const restarted = new WorkflowStore(db);
    const query = restarted.history.query(next, { action: 'search', text: '原图', round: 1 }) as { entries: { id: string }[] };
    assert(query.entries.some(entry => entry.id === ref.id)); assert(query.entries.every(entry => entry.id.startsWith(value.requestID)));
    assert.equal(restarted.history.state(next).goal.content, '现在改用 JPG');
    assert.throws(() => restarted.history.query(next, { action: 'read', id: ref.id, revision: 'a'.repeat(64) }), /revision_changed/);
    const other = restarted.create({ ...value, requestID: randomUUID(), description: 'Other' });
    assert.throws(() => restarted.history.query(other, { action: 'read', id: ref.id, revision: ref.revision }), /not_found/);
    assert.throws(() => restarted.history.query(next, { action: 'search', text: 'x', workflowID: other.id }), /invalid_query/);
  } finally { db.close(); }
});
test('notes retain sourced revisions, reject stale writes and invented quotes, and separate inferred from confirmed decisions', () => {
  const { db, store, value } = fixture();
  try {
    const state = store.history.state(value);
    const first = { requestID: randomUUID(), expectedVersion: state.version, kind: 'constraint', text: '保留原图',
      source: { id: state.goal.id, revision: state.goal.revision, quote: '保留原图' } };
    const inferred = store.history.note(value, first, 'inferred');
    assert.equal(inferred.authority, 'inferred'); assert.deepEqual(store.history.note(value, first, 'inferred'), inferred);
    assert.throws(() => store.history.note(value, { ...first, text: 'Wrong' }, 'inferred'), /conflict/);
    assert.throws(() => store.history.note(value, { ...first, requestID: randomUUID() }, 'user'), /version_conflict/);
    assert.throws(() => store.history.note(value, { ...first, requestID: randomUUID(), expectedVersion: inferred.version,
      source: { ...first.source, quote: '不存在的授权' } }, 'inferred'), /source_changed/);
    const confirmed = store.history.note(value, { ...first, requestID: randomUUID(), expectedVersion: inferred.version, supersedes: inferred.id }, 'user');
    assert.equal(store.history.state(value).notes.length, 1);
    assert.equal(store.history.audit(value)[0].supersededBy, confirmed.id);
    assert.throws(() => store.history.note(value, { ...first, requestID: randomUUID(), expectedVersion: confirmed.version, supersedes: confirmed.id }, 'inferred'), /not_replaceable/);
    const next = store.update(value.id, current => { current.rounds = [archive(current)]; current.roundRequestID = randomUUID(); current.description = '保留原图但改用 JPG'; });
    const state2 = store.history.state(next); assert.equal(state2.notes[0].authority, 'user'); assert(state2.version > confirmed.version);
    const replaced = store.history.note(next, { requestID: randomUUID(), expectedVersion: state2.version, kind: 'decision', text: '改用 JPG',
      source: { id: state2.goal.id, revision: state2.goal.revision, quote: '改用 JPG' }, supersedes: confirmed.id }, 'user');
    assert.equal(store.history.state(next).notes[0].id, replaced.id);
    assert.equal(store.history.audit(next).length, 3);
  } finally { db.close(); }
});
test('handoff records keep direct dependency provenance and recover old revisions after another attempt begins', () => {
  const { db, store, value } = fixture();
  try {
    value.steps = ['source', 'unrelated', 'target'].map(id => workflowStep({ id, title: id, instructions: id, dependsOn: id === 'target' ? ['source'] : [], nodeID: null, resources: [], software: [], requirements: {} }));
    value.steps[0].checkpoint = '已确认结果'.repeat(500); value.steps[1].checkpoint = 'UNRELATED_SECRET';
    store.history.sync(value);
    const packet = store.history.handoff(value, value.steps[2], 40);
    assert.equal(packet.progress.length, 2); assert(!JSON.stringify(packet).includes('UNRELATED_SECRET'));
    assert(packet.progress[1].truncated); const ref = packet.progress[1].reference;
    value.steps[0].checkpoint = '修订后的结果'; store.history.sync(value);
    const old = store.history.query(value, { action: 'read', id: ref.id, revision: ref.revision }) as { content: string };
    assert(old.content.includes('已确认结果')); assert(!old.content.includes('修订后的结果'));
  } finally { db.close(); }
});
test('500-round history stores each source once, bounds search responses and cascades with its conversation', () => {
  const { db, store, value } = fixture();
  try {
    value.description = 'Round source '.repeat(80); value.rounds = [];
    for (let i = 1; i <= 500; i++) {
      value.rounds.push(archive({ ...value, rounds: undefined })); value.roundRequestID = randomUUID();
    }
    store.history.sync(value);
    const bytes = Number(db.prepare('SELECT sum(length(content)) AS n FROM workflow_history').get()!.n);
    assert(bytes < 3_000_000);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM workflow_history WHERE kind='request'").get()!.n), 501);
    store.history.sync(value); assert.equal(Number(db.prepare('SELECT sum(length(content)) AS n FROM workflow_history').get()!.n), bytes);
    const page = store.history.query(value, { action: 'search', text: 'Round' }) as { entries: unknown[]; nextOffset: number };
    assert.equal(page.entries.length, 10); assert.equal(page.nextOffset, 10); assert(Buffer.byteLength(JSON.stringify(page)) < 10_000);
    db.prepare('DELETE FROM workflows WHERE id=?').run(value.id);
    for (const table of ['workflow_history', 'workflow_history_versions', 'workflow_history_rounds', 'workflow_state', 'workflow_notes'])
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0);
  } finally { db.close(); }
});

test('remote history binds the authenticated live target, exact digest, accepted execution and planner-only note writes', () => {
  const { db, store, value } = fixture();
  try {
    const peer = 'B'.repeat(32), executionID = randomUUID();
    const context = { workflowID: value.id, stepID: 'planner', attempt: 1, role: 'planner' as const,
      target: value.target, instructions: 'Plan', evidence: '', priorContext: '' };
    store.update(value.id, current => { current.planner.attempts = [{ number: 1, executionID, nodeID: peer, kind: 'remote', phase: 'running',
      createdAt: value.createdAt, updatedAt: value.updatedAt, summary: '', outcome: null, inputFiles: [], outputFiles: [],
      error: null, context, handled: false }]; });
    let trusted = true, available = true;
    const remote: HistoryRemoteExecution = { direction: 'outgoing', targetNodeID: peer, status: 'accepted', executionState: 'running', controlPending: false };
    const access = new WorkflowHistoryAccess(store, id => id === executionID ? remote : null, id => trusted && id === peer, () => available);
    const request = { workflowID: value.id, executionID, digest: workflowContextDigest(context, []), name: 'rivloom_history', args: { action: 'state' } };
    const reply = access.handle(peer, request); assert.equal(reply.executionID, executionID); assert.equal(reply.digest, request.digest);
    assert.throws(() => access.handle('C'.repeat(32), request), /not_authorized/);
    assert.throws(() => access.handle(peer, { ...request, digest: 'a'.repeat(64) }), /execution_changed/);
    assert.throws(() => access.handle(peer, { ...request, executionID: randomUUID() }), /execution_changed/);
    assert.throws(() => access.handle(peer, { ...request, workflowID: randomUUID() }), /not_available/);
    trusted = false; assert.throws(() => access.handle(peer, request), /not_authorized/); trusted = true;
    available = false; assert.throws(() => access.handle(peer, request), /not_authorized/); available = true;
    remote.status = 'pending'; assert.throws(() => access.handle(peer, request), /not_authorized/); remote.status = 'accepted';
    remote.executionState = 'accepted'; assert.throws(() => access.handle(peer, request), /not_authorized/); remote.executionState = 'running';
    const state = store.history.state(store.get(value.id)!);
    const long = store.update(value.id, current => { current.description = '历史分页汉字'.repeat(1900); });
    const ref = store.history.state(long).goal;
    const page = access.handle(peer, { ...request, args: { action: 'read', id: ref.id, revision: ref.revision } });
    const read = page.result as { content: string; nextOffset: number | null };
    assert(Buffer.byteLength(JSON.stringify(read)) <= 32 * 1024);
    assert(read.content.length > 10_000); assert(read.nextOffset !== null);
    assert(Buffer.byteLength(JSON.stringify(page)) < 60_000);
    // Restore the source before checking note authorization below.
    store.update(value.id, current => { current.description = value.description; });
    const args = { requestID: randomUUID(), expectedVersion: state.version, kind: 'decision', text: 'Use PNG',
      source: { id: state.goal.id, revision: state.goal.revision, quote: 'PNG' } };
    const saved = access.handle(peer, { ...request, name: 'rivloom_context_note', args });
    assert.equal((saved.result as { authority: string }).authority, 'inferred');
    store.update(value.id, current => { current.planner.attempts[0].context.role = 'executor'; });
    const executor = { ...request, digest: workflowContextDigest({ ...context, role: 'executor' }, []) };
    assert.throws(() => access.handle(peer, { ...executor, name: 'rivloom_context_note', args }), /not_authorized/);
    store.update(value.id, current => { current.state = 'stopped'; });
    assert.throws(() => access.handle(peer, executor), /execution_changed/);
  } finally { db.close(); }
});
