import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTodoRevision, inactiveTelemetry, normalizeTodos, sessionUsage } from '../shared/task-telemetry.ts';

function assistant(id: string, cost: unknown = 0.12, input: unknown = 100) {
  return { info: { id, role: 'assistant', cost, time: { created: 110 },
    tokens: { input, output: 20, reasoning: 5, cache: { read: 30, write: 10 }, total: 165 } },
  parts: [{ type: 'step-finish', cost: 100, tokens: { input: 100_000 } }] };
}

test('session usage replaces snapshots, deduplicates message IDs and never double counts step parts', () => {
  const messages = [assistant('a'), assistant('b'), assistant('a', 0.15, 120),
    { info: { id: 'user', role: 'user', cost: 999 } }];
  const expected = { scope: 'session', assistantMessages: 2, cost: 0.27,
    tokens: { input: 220, output: 40, reasoning: 10, cacheRead: 60, cacheWrite: 20, total: 330 } };
  assert.deepEqual(sessionUsage(messages), expected);
  assert.deepEqual(sessionUsage(messages), expected, 'polling is not an accumulator');
  assert.equal(sessionUsage([assistant('a')])?.cost, 0.12, 'smaller official snapshots replace totals');
});

test('missing usage remains unknown while an explicit engine zero remains zero', () => {
  assert.equal(sessionUsage(undefined), null);
  assert.equal(sessionUsage([]), null);
  const known = assistant('a', 0, 0);
  assert.equal(sessionUsage([known])?.cost, 0);
  assert.equal(sessionUsage([known])?.tokens.input, 0);
  const unknown = { info: { id: 'missing', role: 'assistant' }, parts: [] };
  const partial = sessionUsage([known, unknown])!;
  assert.equal(partial.assistantMessages, 2);
  assert.equal(partial.cost, null);
  assert(Object.values(partial.tokens).every(value => value === null));
  const noTotal = structuredClone(known) as Record<string, any>;
  delete noTotal.info.tokens.total;
  assert.equal(sessionUsage([noTotal])?.tokens.total, null, 'never invent totals by summing potentially overlapping fields');
  assert.equal(sessionUsage([noTotal])?.tokens.output, 20);
});

test('usage rejects invalid or overflowing counters and preserves small upstream cost units', () => {
  for (const invalid of [-1, NaN, Infinity, 0.5, '100', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(sessionUsage([assistant('a', 0, invalid)])?.tokens.input, null);
  for (const invalid of [-1, NaN, Infinity, '0.12']) assert.equal(sessionUsage([assistant('a', invalid)])?.cost, null);
  assert.equal(sessionUsage([assistant('a', 0, Number.MAX_SAFE_INTEGER), assistant('b', 0, 1)])?.tokens.input, null);
  assert.equal(sessionUsage([assistant('a', 0.00000000001)])?.cost, 0.00000000001);
});

function todoMessage(created: number, ended: number, status = 'completed') {
  return { info: { id: `m${created}`, role: 'assistant', time: { created } },
    parts: [{ id: `p${ended}`, type: 'tool', tool: 'todowrite', state: { status, time: { end: ended } } }] };
}
test('todo revisions require a completed official write in the current run', () => {
  assert.equal(currentTodoRevision([todoMessage(50, 70)], 100), null);
  assert.equal(currentTodoRevision([todoMessage(110, 120, 'running')], 100), null);
  assert.equal(currentTodoRevision([{ ...todoMessage(110, 120), info: { id: 'user', role: 'user', time: { created: 110 } } }], 100), null);
  assert.equal(currentTodoRevision([todoMessage(110, 120)], 0), null);
  assert.equal(currentTodoRevision([todoMessage(110, 120), todoMessage(130, 150)], 100), 'm130:p150:150');
  assert.equal(currentTodoRevision([todoMessage(110, 120)], 130), null, 'reused sessions do not inherit the previous run plan');
});

test('todo normalization keeps explicit states, bounds content and never invents completion', () => {
  assert.deepEqual(normalizeTodos([{ content: 'Test', status: 'new-state', priority: 'urgent' }]),
    { items: [{ content: 'Test', status: 'unknown', priority: 'unknown' }], truncated: false });
  assert.equal(normalizeTodos([{ content: '', status: 'completed', priority: 'high' }]), null);
  assert.equal(normalizeTodos({ todos: [] }), null);
  assert.deepEqual(normalizeTodos([]), { items: [], truncated: false });
  const long = normalizeTodos(Array.from({ length: 201 }, () => ({ content: 'x'.repeat(4001), status: 'pending', priority: 'low' })))!;
  assert.equal(long.items.length, 200);
  assert.equal(long.items[0].content.length, 4000);
  assert(long.truncated);
  assert.equal(inactiveTelemetry(undefined), undefined, 'old records remain compatible');
});
