import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationActivityRegistry } from '../server/operation-activity.ts';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { knowledgeActivityActions } from '../shared/operation-activity.ts';

test('active groups preserve long operations and concurrent failures without unbounded records', () => {
  let now = 100;
  const activity = new OperationActivityRegistry(() => {}, () => now);
  const long = activity.begin('read');
  const concurrent = Array.from({ length: 200 }, () => activity.begin('read'));
  assert.equal(activity.snapshot().find((item) => item.status === 'running')?.activeCount, 201);
  concurrent.forEach((operation) => operation.finish({ status: 'failed', error: 'knowledge_source_unavailable' }));
  now += 3_600_000;
  assert.equal(activity.snapshot().find((item) => item.status === 'running')?.activeCount, 1);
  const issue = activity.snapshot().find((item) => item.status === 'failed')!;
  assert.equal(issue.occurrences, 200);
  assert.equal(activity.dismiss(activity.snapshot().find((item) => item.status === 'running')!.id), false);
  for (let n = 0; n < 100; n++) for (const action of knowledgeActivityActions) {
    activity.begin(action).finish();
    activity.begin(action).finish({ status: 'failed', error: 'knowledge_source_unavailable' });
  }
  assert(activity.snapshot().length <= knowledgeActivityActions.length * 3);
  assert.equal(activity.snapshot().find((item) => item.status === 'running')?.activeCount, 1);
  long.finish(); long.finish();
  assert(!activity.snapshot().some((item) => item.status === 'running'));
  const retained = activity.snapshot().find((item) => item.action === issue.action && item.status === 'failed')!;
  assert.equal(retained.startedAt, issue.startedAt);
  assert.equal(retained.occurrences, 300);
});

test('completed activities expire while issues require explicit dismissal; snapshots cannot mutate state', () => {
  let now = 100;
  const activity = new OperationActivityRegistry(() => {}, () => now);
  activity.begin('save').finish();
  activity.begin('refresh').finish({ status: 'partial', error: 'knowledge_source_unavailable' });
  const issue = activity.snapshot().find((item) => item.status === 'partial')!;
  activity.snapshot()[0].status = 'running';
  now += 8_000;
  assert.deepEqual(activity.snapshot().map((item) => item.status), ['partial']);
  activity.begin('refresh').finish();
  assert(activity.snapshot().some((item) => item.id === issue.id));
  now += 24 * 60 * 60 * 1000;
  assert.equal(activity.snapshot().length, 1);
  assert.equal(activity.dismiss(issue.id), true);
  assert.equal(activity.dismiss(issue.id), false);
  assert.deepEqual(activity.snapshot(), []);
});

test('a delayed dismissal cannot clear a newer occurrence of the same knowledge failure', () => {
  let now = 100;
  const activity = new OperationActivityRegistry(() => {}, () => now);
  activity.begin('read').finish({ status: 'failed', error: 'knowledge_source_unavailable' });
  const first = activity.snapshot()[0];
  // A second operation can fail before the click from the displayed first issue reaches the server.
  activity.begin('read').finish({ status: 'failed', error: 'knowledge_source_unavailable' });
  const second = activity.snapshot()[0];
  assert.equal(activity.dismiss(first.id), false);
  assert.equal(activity.snapshot().length, 1);
  assert.equal(second.occurrences, 2);
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.updatedAt, first.updatedAt, 'UUID fencing also handles failures in the same millisecond');
  now++;
  activity.begin('read').finish({ status: 'partial', error: 'knowledge_source_unavailable' });
  const third = activity.snapshot()[0];
  assert.equal(activity.dismiss(second.id), false);
  assert.equal(third.occurrences, 3);
  assert.equal(activity.dismiss(third.id), true);
  assert.deepEqual(activity.snapshot(), []);
});

test('tracking preserves synchronous and asynchronous results/errors and excludes private error text', async () => {
  const activity = new OperationActivityRegistry(() => { throw new Error('observer failure'); });
  const privateError = new Error('Cannot read C:\\private\\secret.md: sensitive body');
  assert.equal(activity.trackSync('save', () => 42), 42);
  assert.throws(() => activity.trackSync('save', () => { throw privateError; }), (error) => error === privateError);
  await assert.rejects(activity.track('read', async () => { throw privateError; }), (error) => error === privateError);
  assert(!JSON.stringify(activity.snapshot()).includes('private'));
  assert(activity.snapshot().filter((item) => item.status === 'failed').every((item) => item.error === 'knowledge_request_failed'));
  assert.equal(await activity.track('read', async () => 'result'), 'result');
  assert(!activity.snapshot().some((item) => item.status === 'running'));
});

function knowledgeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-operation-activity-'));
  const store = new KnowledgeStore(root, 'a'.repeat(32));
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('refresh reports partial and total failures while preserving best-effort business behavior', async () => {
  const f = knowledgeFixture();
  try {
    const sources = ['one', 'two'].map((name) => {
      const source = join(f.root, name); mkdirSync(source);
      writeFileSync(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nprivate body`);
      return source;
    });
    await Promise.all(sources.map((source) => f.store.registerSkill(source, null)));
    rmSync(join(sources[0], 'SKILL.md'));
    await f.store.refreshAll();
    assert.equal(f.store.activity.snapshot().find((item) => item.action === 'refresh')?.status, 'partial');
    assert.equal(f.store.listLocal().filter((item) => item.error).length, 1);
    rmSync(join(sources[1], 'SKILL.md'));
    await f.store.refreshAll();
    assert.equal(f.store.activity.snapshot().find((item) => item.action === 'refresh')?.status, 'failed');
    assert(!JSON.stringify(f.store.activity.snapshot()).includes(f.root));
    assert(!JSON.stringify(f.store.activity.snapshot()).includes('private body'));
  } finally { f.close(); }
});

test('model saves and automatic organization produce globally readable activity; background errors remain visible', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = knowledgeFixture();
  try {
    f.store.saveMemory({ name: 'Private name', description: 'private', category: 'Work', body: 'private facts', projectID: null }, 'task:model-task');
    assert(f.store.activity.snapshot().some((item) => item.action === 'save' && item.status === 'completed'));
    t.mock.timers.tick(60_000);
    assert.equal(f.store.organization()?.entries, 1);
    assert(f.store.activity.snapshot().some((item) => item.action === 'organize' && item.status === 'completed'));
    // A regular file blocks the expected index directory, without touching unrelated paths.
    rmSync(join(f.store.root, 'wiki'), { recursive: true });
    writeFileSync(join(f.store.root, 'wiki'), 'blocked');
    f.store.scheduleOrganization(); t.mock.timers.tick(60_000);
    assert(f.store.activity.snapshot().some((item) => item.action === 'organize' && item.status === 'failed'));
    assert(!JSON.stringify(f.store.activity.snapshot()).includes('private'));
  } finally { f.close(); t.mock.timers.reset(); }
});
