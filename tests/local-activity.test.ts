import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalActivityStore } from '../src/local-activity.ts';

test('concurrent file reads and saves settle independently and successful feedback lasts two seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = createLocalActivityStore(); let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const empty = store.getSnapshot(); assert.equal(store.getSnapshot(), empty);
  const read = store.begin('file-read', 'notes.md'), save = store.begin('file-save', 'draft.txt');
  assert.deepEqual(store.getSnapshot().map(item => item.state), ['running', 'running']);
  t.mock.timers.tick(100);
  store.finish(read); const completed = store.getSnapshot();
  assert.equal(completed[0].finishedAt, 1100);
  store.finish(read); store.fail(read, 'office_changed'); assert.equal(store.getSnapshot(), completed);
  store.fail(save, { code: 'office_changed', message: 'Do not store document content' });
  assert.equal(store.getSnapshot()[1].errorCode, 'office_changed');
  t.mock.timers.tick(1999); assert.equal(store.getSnapshot().length, 2);
  t.mock.timers.tick(1); assert.deepEqual(store.getSnapshot().map(item => item.id), [save]);
  t.mock.timers.tick(60_000); assert.equal(store.getSnapshot()[0].state, 'failed');
  assert.equal(notifications, 5); unsubscribe(); store.dismiss(save); assert.equal(notifications, 5);
  assert.equal(store.getSnapshot().length, 0);
});

test('pending work continues after the view unsubscribes and preserves rejection semantics', async () => {
  const store = createLocalActivityStore(); let resolveRead!: (value: string) => void, rejectSave!: (cause: Error) => void;
  const read = store.run('file-read', 'notes.md', () => new Promise<string>(resolve => { resolveRead = resolve; }));
  const save = store.run('file-save', 'draft.txt', () => new Promise<void>((_, reject) => { rejectSave = reject; }));
  let notifications = 0; const unsubscribe = store.subscribe(() => { notifications += 1; }); unsubscribe();
  resolveRead('document result'); assert.equal(await read, 'document result');
  const failure = new Error('office_changed'); const rejected = assert.rejects(save, error => error === failure);
  rejectSave(failure); await rejected;
  assert.deepEqual(store.getSnapshot().map(item => item.state), ['completed', 'failed']);
  assert.equal(notifications, 0); store.clear();
});

test('identity clearing cancels feedback timers and late promises cannot repopulate activity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = createLocalActivityStore();
  const complete = store.begin('file-read'); store.finish(complete);
  let resolveOld!: () => void, rejectOld!: (error: Error) => void;
  const oldRead = store.run('file-read', 'old.md', () => new Promise<void>(resolve => { resolveOld = resolve; }));
  const oldSave = store.run('file-save', 'old.txt', () => new Promise<void>((_, reject) => { rejectOld = reject; }));
  store.clear(); const current = store.begin('file-read', 'new.md');
  const snapshot = store.getSnapshot();
  resolveOld(); await oldRead;
  const rejected = assert.rejects(oldSave, /office_changed/); rejectOld(new Error('office_changed')); await rejected;
  t.mock.timers.tick(5000);
  assert.equal(store.getSnapshot(), snapshot); assert.equal(store.getSnapshot()[0].id, current);
  assert.notEqual(complete, current); store.clear();
  const empty = store.getSnapshot(); store.clear(); assert.equal(store.getSnapshot(), empty);
});

test('activity retains only bounded display names and safe error codes', () => {
  const store = createLocalActivityStore();
  const read = store.begin('file-read', 'C:\\private\\project\\\u202enotes.md\u0000');
  store.fail(read, new Error('permission denied: C:\\private\\secret.txt, token=secret'));
  assert.equal(store.getSnapshot()[0].label, 'notes.md');
  assert.equal(store.getSnapshot()[0].errorCode, 'office_unavailable');
  const long = store.begin('file-save', '/private/' + 'a'.repeat(200));
  assert.equal(store.getSnapshot()[1].label!.length, 80);
  store.fail(long, { code: 'office_evil_secret', message: 'office_changed' });
  assert.equal(store.getSnapshot()[1].errorCode, 'office_unavailable');
  assert.ok(!JSON.stringify(store.getSnapshot()).includes('private'));
  const root = store.begin('file-read', 'C:\\');
  assert.equal(store.getSnapshot().find(item => item.id === root)?.label, undefined); store.clear();
});

test('the bounded queue prefers completed feedback over running or failed records', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = createLocalActivityStore({ limit: 3 });
  const running = store.begin('file-read'), failed = store.begin('file-save'), complete = store.begin('file-read');
  store.fail(failed, 'office_changed'); store.finish(complete);
  const newest = store.begin('file-save');
  assert.deepEqual(store.getSnapshot().map(item => item.id), [running, failed, newest]);
  t.mock.timers.tick(5000); assert.equal(store.getSnapshot().length, 3);
  const next = store.begin('file-save');
  assert.deepEqual(store.getSnapshot().map(item => item.id), [running, newest, next]);
  for (let i = 0; i < 100; i++) store.begin('file-read');
  assert.equal(store.getSnapshot().length, 3);
  const current = store.getSnapshot(); store.finish(running); assert.equal(store.getSnapshot(), current); store.clear();
});

test('dismissed completions never remove other work when their former timer fires', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = createLocalActivityStore();
  const complete = store.begin('file-read'); store.finish(complete); store.dismiss(complete);
  const read = store.begin('file-read'); const snapshot = store.getSnapshot();
  t.mock.timers.tick(2000); assert.equal(store.getSnapshot(), snapshot); assert.equal(snapshot[0].id, read);
  store.clear();
});
