import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TaskQueries, decodeTask, taskQuerySQL } from '../server/task-queries.ts';
import type { Task } from '../shared/types.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE tasks(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,project_id TEXT NOT NULL,body TEXT NOT NULL)',
  );
  const put = (value: Task) =>
    db
      .prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(value.id, value.number, value.projectID, JSON.stringify(value));
  const task = (id: string, number: number, more: Partial<Task> = {}) =>
    ({
      id,
      number,
      projectID: 'project',
      state: 'accepted',
      approvalMode: 'ask',
      version: 1,
      messages: [
        { id: 'message', role: 'assistant', text: '历史正文 中文 ✅\n'.repeat(100), tools: [] },
      ],
      approvals: [],
      questions: [],
      sessionID: `session-${id}`,
      ...more,
    }) as Task;
  return { db, put, task };
}

test('runtime indexes upgrade existing tasks without rewriting history and remain idempotent', () => {
  const { db, put, task } = fixture();
  try {
    put(task('old', 1));
    put(task('active', 2, { state: 'running' }));
    put(task('review', 3, { state: 'review' }));
    const before = db.prepare('SELECT * FROM tasks ORDER BY number').all();
    const reads = new TaskQueries(db);
    new TaskQueries(db);
    assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY number').all(), before);
    assert.deepEqual(
      reads.inStates(['running', 'review']).map((t) => t.id),
      ['review', 'active'],
    );
    assert.deepEqual(reads.inStates([]), []);
    assert.deepEqual(reads.inStates(['waiting_input']), []);
  } finally {
    db.close();
  }
});

test('stream routing reads only identity and state and ignores missing or invalid session IDs', () => {
  const { db, put, task } = fixture();
  try {
    put(task('one', 1, { state: 'running' }));
    const reads = new TaskQueries(db);
    assert.deepEqual(reads.routeForSession('session-one'), { id: 'one', state: 'running' });
    for (const value of [undefined, null, '', 1, {}, "' OR 1=1 --", 'unknown'])
      assert.equal(reads.routeForSession(value), undefined);
    assert.equal(reads.forRemote("' OR 1=1 --"), undefined);
  } finally {
    db.close();
  }
});

test('same-version changes, transactions and rollback immediately update all indexed reads', () => {
  const { db, put, task } = fixture();
  try {
    const original = task('one', 1, { state: 'running' });
    put(original);
    const reads = new TaskQueries(db);
    const changed = {
      ...original,
      state: 'waiting_input',
      sessionID: 'rebound',
      remoteOrigin: { remoteTaskID: 'remote-one', ownerNodeID: 'peer', ownerBrainID: 'brain' },
    } as Task;
    db.exec('BEGIN');
    put(changed);
    assert.equal(reads.routeForSession(original.sessionID), undefined);
    assert.deepEqual(reads.routeForSession('rebound'), { id: original.id, state: 'waiting_input' });
    assert.deepEqual(reads.forRemote('remote-one'), changed);
    assert.equal(reads.stateForID('one'), 'waiting_input');
    assert.deepEqual(reads.inStates(['running']), []);
    db.exec('ROLLBACK');
    assert.equal(reads.routeForSession('rebound'), undefined);
    assert.equal(reads.forRemote('remote-one'), undefined);
    assert.equal(reads.stateForID('one'), 'running');
    assert.deepEqual(reads.inStates(['running']), [original]);
  } finally {
    db.close();
  }
});

test('duplicate references keep the previous newest-number lookup order and return fresh objects', () => {
  const { db, put, task } = fixture();
  try {
    const origin = { remoteTaskID: 'remote', ownerNodeID: 'peer', ownerBrainID: 'brain' };
    put(task('older', 2, { sessionID: 'shared', remoteOrigin: origin }));
    put(task('newer', 7, { sessionID: 'shared', remoteOrigin: origin, state: 'review' }));
    const reads = new TaskQueries(db);
    assert.equal(reads.routeForSession('shared')?.id, 'newer');
    const first = reads.forRemote('remote')!;
    assert.equal(first.id, 'newer');
    first.messages[0].text = 'local caller mutation';
    assert.notEqual(reads.forRemote('remote')!.messages[0].text, first.messages[0].text);
    db.prepare('DELETE FROM tasks WHERE id=?').run('newer');
    assert.equal(reads.routeForSession('shared')?.id, 'older');
    assert.equal(reads.stateForID('newer'), undefined);
  } finally {
    db.close();
  }
});

test('state lookup keeps completed queued tasks distinguishable from missing tasks and preserves numbering', () => {
  const { db, put, task } = fixture();
  try {
    const reads = new TaskQueries(db);
    assert.equal(reads.nextNumber(), 1);
    put(task('completed', 8));
    put(task('reserved', 12, { state: 'ready' }));
    assert.equal(reads.stateForID('completed'), 'accepted');
    assert.equal(reads.stateForID('reserved'), 'ready');
    assert.equal(reads.stateForID('missing'), undefined);
    assert.equal(reads.nextNumber(), 13);
    const legacy = task('legacy', 13, { approvalMode: undefined });
    put(legacy);
    assert.equal(reads.inStates(['accepted'])[0].approvalMode, 'ask');
    assert.deepEqual(reads.inStates(['accepted'])[0], decodeTask(JSON.stringify(legacy)));
  } finally {
    db.close();
  }
});

test('SQLite uses indexed searches for polling, stream events and remote bindings', () => {
  const { db, put, task } = fixture();
  try {
    for (let index = 1; index <= 100; index++) put(task(String(index), index));
    new TaskQueries(db);
    for (const [sql, parameter, index] of [
      [taskQuerySQL.states(1), 'running', 'tasks_runtime_state'],
      [taskQuerySQL.session, 'session-1', 'tasks_runtime_session'],
      [taskQuerySQL.remote, 'remote-1', 'tasks_runtime_remote'],
    ]) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(parameter)
        .map((row) => String(row.detail))
        .join('\n');
      assert.match(plan, new RegExp(`SEARCH tasks USING (?:COVERING )?INDEX ${index}`));
      if (sql === taskQuerySQL.session) assert.match(plan, /USING COVERING INDEX/);
      assert.doesNotMatch(plan, /SCAN tasks/);
    }
  } finally {
    db.close();
  }
});
