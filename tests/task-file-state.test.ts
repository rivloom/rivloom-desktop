import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskFileState, type TaskFileQuery } from '../src/task-file-state.ts';
import type { TaskFileConversation, TaskFileView } from '../shared/task-files.ts';

const route = (taskID = 'one'): TaskFileQuery => ({ scope: 'remote', taskID });
const empty = (): TaskFileConversation => ({ inputs: [], results: [], canPublish: false, canSave: true, canRetry: true });
const file = (state: TaskFileView['state'], receivedBytes = 0): TaskFileView => ({
  id: 'file', name: 'result.txt', bytes: 20, sha256: 'a'.repeat(64), mime: 'application/octet-stream',
  state, receivedBytes, error: state === 'failed' ? 'integrity' : null, updatedAt: '2026-11-04T00:00:00Z', deliveries: [], sourceNodeID: 'peer',
});
const result = (state: TaskFileView['state'], receivedBytes = 0) => ({ ...empty(), results: [file(state, receivedBytes)] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: (value: TaskFileConversation) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TaskFileConversation>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('file queries share a request across consumers and cap independent in-flight requests at four', async t => {
  const calls: { route: TaskFileQuery; response: ReturnType<typeof deferred> }[] = [];
  const store = createTaskFileState({ load: query => { const response = deferred(); calls.push({ route: query, response }); return response.promise; } });
  t.after(() => store.dispose());
  const release = store.subscribe(route(), () => {});
  store.subscribe(route(), () => {});
  for (let i = 0; i < 7; i++) store.subscribe(route(String(i)), () => {});
  assert.equal(calls.length, 4); assert.equal(store.stats().running, 4);
  assert.equal(calls.filter(call => call.route.taskID === 'one').length, 1);
  release(); assert.equal(store.stats().running, 4);
  calls[0].response.resolve(empty()); await tick();
  assert.equal(calls.length, 5); assert.equal(store.stats().running, 4);
  for (let i = 1; i < 8; i++) { calls[i].response.resolve(empty()); await tick(); }
  assert.equal(store.stats().running, 0);
});

test('unsubscribe and renewed subscriptions never reuse an unconfirmed stale response or overlap requests', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  const release = store.subscribe(route(), () => {}); release();
  store.subscribe(route(), () => {});
  assert.equal(responses.length, 1);
  responses[0].resolve(result('complete', 20)); await tick();
  assert.equal(store.snapshot(route()).value, null);
  assert.equal(responses.length, 2);
  responses[1].resolve(result('receiving', 5)); await tick();
  assert.equal(store.snapshot(route()).value?.results[0].receivedBytes, 5);
  assert.equal(store.snapshot(route()).fresh, true);
});

test('identity reset clears cached files and user retrievals immediately and fences old responses', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.subscribe(route(), () => {});
  responses[0].resolve(result('complete', 20)); await tick();
  store.request(route(), 'other');
  store.reset();
  assert.equal(store.snapshot(route()).value, null); assert.deepEqual(store.requested(), []);
  responses[1].resolve(result('complete', 20)); await tick();
  assert.equal(store.snapshot(route()).value, null);
  responses[2].resolve(empty()); await tick();
  assert.deepEqual(store.snapshot(route()).value, empty());
});

test('completed routes stop periodic reads, explicit invalidation finds newly published results, and idle cache is bounded', async t => {
  let calls = 0;
  const store = createTaskFileState({ pollMilliseconds: 5, maxInactive: 3, load: async () => { calls++; return empty(); } });
  t.after(() => store.dispose());
  const release = store.subscribe(route(), () => {}); await tick();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  store.refresh(route()); await tick(); assert.equal(calls, 2);
  release();
  for (let i = 0; i < 100; i++) store.snapshot(route(String(i)));
  assert.ok(store.stats().entries <= 3);
});

test('read errors preserve confirmed bytes but invalidate freshness, and hidden pages abort and suspend reads', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.subscribe(route(), () => {});
  responses[0].resolve(result('receiving', 8)); await tick();
  store.refresh(route()); responses[1].reject(new Error('offline')); await tick();
  assert.equal(store.snapshot(route()).value?.results[0].receivedBytes, 8);
  assert.equal(store.snapshot(route()).fresh, false); assert.equal(store.snapshot(route()).error, 'offline');
  store.refresh(route()); store.setVisible(false);
  responses[2].resolve(result('complete', 20)); await tick();
  assert.equal(store.snapshot(route()).value?.results[0].receivedBytes, 8);
  store.refresh(route()); assert.equal(responses.length, 3);
  store.setVisible(true); assert.equal(responses.length, 4);
  responses[3].resolve(result('complete', 20)); await tick();
  assert.equal(store.snapshot(route()).fresh, true);
});

test('explicit historical retrievals stay observable across panel removal and retain failures until handled', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.setVisible(false);
  store.request(route('history'), 'file');
  store.requestAccepted(route('history'), 'file');
  store.setVisible(true);
  assert.deepEqual(store.requested(), [route('history')]);
  responses[0].resolve(result('failed')); await tick();
  assert.deepEqual(store.requested(), [route('history')]);
  assert.equal(store.stats().pending, 0);
  store.setVisible(false);
  store.request(route('history'), 'file'); store.requestAccepted(route('history'), 'file'); store.setVisible(true);
  responses[1].resolve(result('complete', 20)); await tick();
  assert.deepEqual(store.requested(), []);
  assert.equal(store.snapshot(route()).value, null);
});

test('an unconfirmed retrieval remains visibly uncertain despite a successful metadata read', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.request(route(), 'file');
  store.requestFailed(route(), 'file', 'request unconfirmed');
  responses[0].resolve(result('remote')); await tick();
  assert.equal(store.snapshot(route()).fresh, false);
  assert.equal(store.snapshot(route()).error, 'request unconfirmed');
  // The explicit invalidation during the first request rechecks without overlapping it.
  responses[1].resolve(result('receiving', 4)); await tick();
  assert.equal(store.snapshot(route()).fresh, true);
  assert.equal(store.snapshot(route()).error, null);
  assert.equal(store.stats().pending, 1);
  store.refresh(route()); responses[2].resolve(result('failed')); await tick();
  assert.equal(store.stats().pending, 0);
  assert.equal(store.snapshot(route()).value?.results[0].state, 'failed');
});

test('user-requested retrieval retention is bounded without silently dropping existing failures', t => {
  const store = createTaskFileState({ load: async () => result('failed') });
  t.after(() => store.dispose()); store.setVisible(false);
  for (let i = 0; i < 64; i++) assert.equal(store.request(route(String(i)), 'file'), true);
  assert.equal(store.request(route('excess'), 'file'), false);
  assert.equal(store.requested().length, 64);
  assert.equal(store.request(route('1'), 'file'), true);
  store.forgetRequest(route('1'), 'file');
  assert.equal(store.request(route('excess'), 'file'), true);
});

test('64 network-unknown requests retain their slots but definitive rejections release capacity', async t => {
  const store = createTaskFileState({ load: async () => result('remote') });
  t.after(() => store.dispose()); store.setVisible(false);
  for (let i = 0; i < 64; i++) {
    assert.equal(store.request(route(String(i)), 'file'), true);
    store.requestFailed(route(String(i)), 'file', 'network outcome unknown');
  }
  assert.equal(store.stats().pending, 64);
  assert.equal(store.request(route('new'), 'file'), false);
  for (let i = 0; i < 64; i++) store.requestFailed(route(String(i)), 'file', 'permission denied', true);
  assert.equal(store.stats().pending, 0);
  assert.equal(store.snapshot(route('0')).error, 'permission denied');
  assert.equal(store.request(route('new'), 'file'), true);
  assert.equal(store.stats().pending, 1);
});

test('a pre-POST metadata failure cannot settle a new retrieval, and retry must reacquire a slot', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.request(route(), 'file');
  store.requestAccepted(route(), 'file');
  responses[0].resolve(result('failed')); await tick();
  assert.equal(store.stats().pending, 1, 'old failure does not settle the newly accepted POST');
  responses[1].resolve(result('failed')); await tick();
  assert.equal(store.stats().pending, 0);
  assert.deepEqual(store.requested(), [route()]);
  store.setVisible(false);
  for (let i = 0; i < 64; i++) assert.equal(store.request(route(String(i)), 'file'), true);
  assert.equal(store.request(route(), 'file'), false, 'a retained failure is not an already-held live slot');
  store.requestFailed(route('0'), 'file', 'not found', true);
  assert.equal(store.request(route(), 'file'), true);
  assert.equal(store.stats().pending, 64);
});

test('an old failed snapshot cannot resolve an unknown POST until fresh receiving evidence arrives', async t => {
  const responses: ReturnType<typeof deferred>[] = [];
  const store = createTaskFileState({ load: () => { const response = deferred(); responses.push(response); return response.promise; } });
  t.after(() => store.dispose());
  store.request(route(), 'file'); store.requestFailed(route(), 'file', 'unconfirmed');
  responses[0].resolve(result('failed')); await tick();
  responses[1].resolve(result('failed')); await tick();
  assert.equal(store.stats().pending, 1);
  assert.equal(store.snapshot(route()).fresh, false);
  assert.equal(store.snapshot(route()).error, 'unconfirmed');
  store.refresh(route()); responses[2].resolve(result('receiving', 4)); await tick();
  assert.equal(store.snapshot(route()).fresh, true);
  assert.equal(store.stats().pending, 1);
  store.refresh(route()); responses[3].resolve(result('complete', 20)); await tick();
  assert.equal(store.stats().pending, 0);
  assert.deepEqual(store.requested(), []);
});

test('inactive terminal failures have a bounded cache while subscribed errors are retained', async t => {
  const store = createTaskFileState({ maxInactive: 2, load: async () => result('remote') });
  t.after(() => store.dispose()); store.setVisible(false);
  const release = store.subscribe(route('visible'), () => {});
  store.request(route('visible'), 'file'); store.requestFailed(route('visible'), 'file', 'visible denial', true);
  for (let i = 0; i < 30; i++) {
    store.request(route(String(i)), 'file'); store.requestFailed(route(String(i)), 'file', `denial ${i}`, true);
  }
  await tick();
  assert.equal(store.stats().pending, 0);
  assert.ok(store.stats().entries <= 3);
  assert.ok(store.requested().length <= 3);
  assert.equal(store.snapshot(route('visible')).error, 'visible denial');
  release();
});

test('a burst of message revisions does not turn file revalidation into per-token network requests', async t => {
  let calls = 0;
  const store = createTaskFileState({ pollMilliseconds: 10_000, load: async () => { calls++; return empty(); } });
  t.after(() => store.dispose()); store.subscribe(route(), () => {}); await tick();
  for (let i = 0; i < 1000; i++) store.revalidate(route());
  await tick(); assert.equal(calls, 1);
  store.refresh(route()); await tick(); assert.equal(calls, 2);
});
