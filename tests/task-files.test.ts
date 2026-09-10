import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { TaskFileStore, TaskFileError } from '../server/task-files.ts';
import {
  taskFileNameError,
  taskFileMaximumBytes,
  taskFileUploadCount,
  taskFileBatchBytes,
  taskFileCapability,
  taskFileLargeCapability,
  supportsTaskFiles,
  taskFileChunkBytes,
  validTaskFileManifest,
  validTaskFileMessage,
  validTaskFileResponse,
  type TaskFileDescriptor,
  type TaskFileRoute,
  type TaskFileMessage,
} from '../shared/task-files.ts';

function root() {
  const value = resolve('.data', 'unit-task-files', randomUUID());
  mkdirSync(value, { recursive: true });
  return value;
}
const file = (body = 'abcdef', name = 'example.txt'): TaskFileDescriptor => ({
  id: randomUUID(),
  name,
  bytes: Buffer.byteLength(body),
  sha256: createHash('sha256').update(body).digest('hex'),
  mime: 'application/octet-stream',
});
const route = (purpose: 'input' | 'result' = 'input'): TaskFileRoute => ({
  scope: 'remote',
  taskID: randomUUID(),
  purpose,
});
const fail = (status: number) => (error: unknown) =>
  error instanceof TaskFileError && error.status === status;
function staged(store: TaskFileStore, body = 'abcdef') {
  const f = file(body);
  store.beginUpload('u', f);
  if (body) store.uploadChunk('u', f.id, 0, Buffer.from(body).toString('base64'));
  return f;
}

test('file links locate a verified original, persisted saved copy, or stable named received file', async () => {
  const folder = root();
  let store = new TaskFileStore(folder);
  try {
    const first = staged(store),
      second = staged(store, 'second');
    const original = join(folder, first.name);
    writeFileSync(original, 'abcdef');
    assert.equal(
      (await store.location(first.id, [{ root: folder, path: original }])).path,
      original,
    );
    writeFileSync(original, 'changed');
    const fallback = (await store.location(first.id, [{ root: folder, path: original }])).path;
    assert.equal(fallback, join(folder, 'task-files', 'received', first.id, first.name));
    assert.equal(readFileSync(fallback, 'utf8'), 'abcdef');
    assert.equal(readFileSync(original, 'utf8'), 'changed');
    assert.equal((await store.location(first.id)).path, fallback);
    assert.notEqual((await store.location(second.id)).path, fallback);
    const saved = join(folder, 'saved.txt');
    store.exportFile(first.id, saved);
    store.close();
    store = new TaskFileStore(folder);
    assert.equal((await store.location(first.id)).path, saved);
    unlinkSync(saved);
    assert.equal((await store.location(first.id)).path, fallback);
    assert(
      !JSON.stringify(store.descriptorFor(first.id)).includes(folder),
      'Local paths stay out of peer descriptors',
    );
  } finally {
    store.close();
  }
});

test('file links reject incomplete files, redirected cache and changed copies without overwrite', async () => {
  const folder = root(),
    store = new TaskFileStore(folder);
  try {
    const incomplete = file();
    store.beginUpload('u', incomplete);
    await assert.rejects(store.location(incomplete.id), fail(409));
    assert(!existsSync(join(folder, 'task-files', 'received')));
    const complete = staged(store);
    const location = (await store.location(complete.id)).path;
    writeFileSync(location, 'modified');
    await assert.rejects(store.location(complete.id), fail(409));
    assert.equal(readFileSync(location, 'utf8'), 'modified');
    const other = staged(store, 'third');
    const outside = join(folder, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(folder, 'task-files', 'received', other.id), 'junction');
    await assert.rejects(store.location(other.id), fail(409));
    assert.deepEqual(readdirSync(outside), []);
    const original = join(outside, other.name);
    writeFileSync(original, 'third');
    const linked = join(folder, 'linked');
    symlinkSync(outside, linked, 'junction');
    await assert.rejects(
      store.location(other.id, [{ root: folder, path: join(linked, other.name) }]),
      fail(409),
    );
  } finally {
    store.close();
  }
});

test('task file names reject traversal, ADS, reserved names, controls and credentials', () => {
  for (const name of [
    '../file',
    'a/b',
    'a\\b',
    'file:stream',
    'CON.txt',
    'LPT1',
    'aux',
    'hello.',
    'a\nb',
    'a\u202eb',
    '.env',
    '.env.local',
    'auth.json',
    'my-credentials.json',
    'id_rsa',
    'key.pem',
  ])
    assert(taskFileNameError(name), name);
  for (const name of ['需求说明.md', 'screenshot.png', 'report.pdf', 'index.ts', 'my file.csv'])
    assert.equal(taskFileNameError(name), null, name);
});
test('task file manifests and encrypted frames are bounded and bind response identity', () => {
  const f = file();
  assert(validTaskFileManifest([f]));
  assert(!validTaskFileManifest([f, f]));
  assert(!validTaskFileManifest([{ ...f, bytes: taskFileMaximumBytes + 1 }]));
  const request: TaskFileMessage = {
    type: 'task-file',
    version: 1,
    requestID: randomUUID(),
    route: route(),
    file: f,
  };
  assert(validTaskFileMessage(request));
  assert(
    !validTaskFileMessage({
      ...request,
      offset: 0,
      data: Buffer.alloc(taskFileChunkBytes + 1).toString('base64'),
    }),
  );
  const response = {
    type: 'task-file-response',
    version: 1,
    requestID: request.requestID,
    route: request.route,
    fileID: f.id,
    sha256: f.sha256,
    receivedBytes: f.bytes,
    state: 'complete',
  };
  assert(validTaskFileResponse(response, request));
  assert(!validTaskFileResponse({ ...response, requestID: randomUUID() }, request));
  assert(!validTaskFileResponse({ ...response, receivedBytes: f.bytes - 1 }, request));
  assert(
    !validTaskFileResponse(
      { ...response, route: { ...request.route, taskID: randomUUID() } },
      request,
    ),
  );
});

test('200 MiB files and five-file batches fit the new budget while legacy histories and small peers stay compatible', () => {
  assert.equal(taskFileMaximumBytes, 200 * 1024 ** 2);
  assert.equal(taskFileUploadCount, 5);
  assert.equal(taskFileBatchBytes, 1000 * 1024 ** 2);
  const batch = Array.from({ length: 5 }, () => ({ ...file(), bytes: taskFileMaximumBytes }));
  assert(validTaskFileManifest(batch));
  assert(!validTaskFileManifest([...batch, { ...file(), bytes: 1 }]));
  assert(
    validTaskFileManifest(Array.from({ length: 10 }, () => file())),
    'Persisted legacy histories still decode',
  );
  assert(supportsTaskFiles([taskFileCapability], [file()]));
  assert(!supportsTaskFiles([taskFileCapability], batch));
  assert(supportsTaskFiles([taskFileCapability, taskFileLargeCapability], batch));
  assert(!supportsTaskFiles([taskFileLargeCapability], batch));
  const oldSized = Array.from({ length: 3 }, () => ({ ...file(), bytes: 20 * 1024 ** 2 }));
  assert(
    !supportsTaskFiles([taskFileCapability], oldSized),
    'Legacy batch limit is also negotiated',
  );
  const store = new TaskFileStore(root());
  try {
    assert.throws(
      () =>
        store.uploaded(
          'u',
          Array.from({ length: 6 }, () => randomUUID()),
        ),
      fail(400),
    );
  } finally {
    store.close();
  }
});
test('staged uploads enforce operator ownership and complete byte verification before task binding', () => {
  const store = new TaskFileStore(root());
  const f = file();
  const r = route();
  store.beginUpload('u', f);
  assert.throws(() => store.uploadChunk('other', f.id, 0, 'YWJj'), fail(403));
  assert.throws(() => store.bindUploaded(r, 'u', [f.id]), fail(409));
  store.uploadChunk('u', f.id, 0, 'YWJj');
  store.uploadChunk('u', f.id, 3, 'ZGVm');
  assert.deepEqual(store.uploaded('u', [f.id]), [f]);
  store.bindUploaded(r, 'u', [f.id]);
  assert(store.complete(r, [f]));
  assert.throws(() => store.discardUpload('u', f.id), fail(409));
  store.close();
});
test('partial transfer resumes after restart; duplicate blocks are idempotent and conflicts do not alter content', () => {
  const directory = root();
  let store = new TaskFileStore(directory);
  const f = file();
  const r = route();
  store.expectIncoming(r, [f], 'peer');
  store.receive(r, 'peer', f, 0, 'YWJj');
  store.close();
  store = new TaskFileStore(directory);
  assert.equal(store.receive(r, 'peer', f).receivedBytes, 3);
  assert.equal(store.receive(r, 'peer', f, 0, 'YWJj').receivedBytes, 3);
  assert.throws(() => store.receive(r, 'peer', f, 0, 'eHl6'), fail(409));
  assert.throws(() => store.receive(r, 'peer', f, 4, 'ZWY='), fail(409));
  store.receive(r, 'peer', f, 3, 'ZGVm');
  assert.equal(store.content(f.id).toString(), 'abcdef');
  assert.equal(store.receive(r, 'peer', f, 3, 'ZGVm').state, 'complete');
  store.close();
});
test('a crash after blob write but before progress persistence safely replays the original block', () => {
  const directory = root();
  const store = new TaskFileStore(directory);
  const f = file();
  const r = route();
  store.expectIncoming(r, [f], 'peer');
  store.receive(r, 'peer', f);
  writeFileSync(join(directory, 'task-files', 'blobs', `${f.id}.blob`), 'abc');
  assert.equal(store.receive(r, 'peer', f).receivedBytes, 0);
  store.receive(r, 'peer', f, 0, 'YWJj');
  store.receive(r, 'peer', f, 3, 'ZGVm');
  assert.equal(store.content(f.id).toString(), 'abcdef');
  store.close();
});
test('file hash failure is durable and cannot be reported as a received attachment', () => {
  const directory = root();
  let store = new TaskFileStore(directory);
  const f = file();
  const r = route();
  store.expectIncoming(r, [f], 'peer');
  assert.throws(() => store.receive(r, 'peer', f, 0, 'eHh4eHh4'), fail(409));
  assert.equal(store.view(f.id).state, 'failed');
  assert(!store.complete(r, [f]));
  store.close();
  store = new TaskFileStore(directory);
  assert.throws(() => store.receive(r, 'peer', f), fail(409));
  store.close();
});
test('empty files finalize and a file cannot be rebound to another upload owner or peer provenance', () => {
  const store = new TaskFileStore(root());
  const f = file('');
  const r = route();
  assert.equal(store.beginUpload('u', f).state, 'complete');
  assert.throws(() => store.beginUpload('other', f), fail(409));
  assert.throws(() => store.expectIncoming(r, [f], 'peer'), fail(409));
  store.bindUploaded(r, 'u', [f.id]);
  assert(store.complete(r, [f]));
  store.close();
});
test('incoming batches reserve quota atomically and descriptor property order does not change identity', () => {
  const store = new TaskFileStore(root(), 9);
  const a = file();
  const b = file();
  const r = route();
  assert.throws(() => store.expectIncoming(r, [a, b], 'peer'), fail(409));
  assert.deepEqual(store.manifest(r), []);
  store.expectIncoming(r, [a], 'peer');
  const reordered = { mime: a.mime, sha256: a.sha256, bytes: a.bytes, name: a.name, id: a.id };
  store.expectIncoming(r, [reordered], 'peer');
  assert.equal(store.receive(r, 'peer', reordered, 0, 'YWJjZGVm').state, 'complete');
  store.close();
});
test('input materialization stays in a task directory, supports replay and refuses differing files', () => {
  const directory = root();
  const store = new TaskFileStore(directory);
  const f = staged(store);
  const r = { ...route(), scope: 'local' as const };
  store.bindUploaded(r, 'u', [f.id]);
  const project = join(directory, 'project');
  mkdirSync(project);
  const paths = store.materialize(r, [f], project);
  assert.equal(paths.length, 1);
  assert(paths[0].startsWith(`.rivloom-inputs/${r.taskID}/`));
  assert.deepEqual(store.materialize(r, [f], project), paths);
  assert.equal(readFileSync(join(project, paths[0]), 'utf8'), 'abcdef');
  writeFileSync(join(project, paths[0]), 'user edit');
  assert.throws(() => store.materialize(r, [f], project), fail(409));
  assert.equal(readFileSync(join(project, paths[0]), 'utf8'), 'user edit');
  store.close();
});
test('input materialization rejects a junction instead of writing outside the selected project', () => {
  const directory = root();
  const store = new TaskFileStore(directory);
  const f = staged(store);
  const r = route();
  store.bindUploaded(r, 'u', [f.id]);
  const project = join(directory, 'project');
  const outside = join(directory, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  symlinkSync(outside, join(project, '.rivloom-inputs'), 'junction');
  assert.throws(() => store.materialize(r, [f], project), fail(409));
  assert.deepEqual(readdirSync(outside), []);
  store.close();
});
test('file export verifies bytes and never overwrites an existing file or writes a credential filename', () => {
  const directory = root();
  const store = new TaskFileStore(directory);
  const f = staged(store);
  const path = join(directory, 'saved.txt');
  assert.equal(store.exportFile(f.id, path).bytes, f.bytes);
  assert.equal(readFileSync(path, 'utf8'), 'abcdef');
  assert.throws(() => store.exportFile(f.id, path), fail(409));
  assert.throws(() => store.exportFile(f.id, join(directory, '.env')), fail(400));
  assert(!existsSync(join(directory, '.env')));
  store.close();
});
test('declared image types require matching file signatures and failed drafts can be explicitly discarded', () => {
  const store = new TaskFileStore(root());
  const f = { ...file('not an image', 'screenshot.png'), mime: 'image/png' };
  store.beginUpload('u', f);
  assert.throws(
    () => store.uploadChunk('u', f.id, 0, Buffer.from('not an image').toString('base64')),
    fail(400),
  );
  assert.equal(store.view(f.id).state, 'failed');
  store.discardUpload('u', f.id);
  assert.throws(() => store.view(f.id), fail(404));
  store.close();
});
test('delivery progress belongs to each task route and survives restart without changing the task', () => {
  const directory = root();
  let store = new TaskFileStore(directory);
  const f = staged(store);
  const a = route(),
    b = route();
  store.bindUploaded(a, 'u', [f.id]);
  store.bindUploaded(b, 'u', [f.id]);
  store.queueDelivery(a, f.id, 'peer');
  store.queueDelivery(b, f.id, 'peer');
  store.deliveryState(a, f.id, 'peer', 'complete', f.bytes);
  store.close();
  store = new TaskFileStore(directory);
  assert.equal(store.views(a)[0].deliveries[0].state, 'complete');
  assert.equal(store.views(b)[0].deliveries[0].state, 'waiting');
  assert.equal(store.deliveries().length, 1);
  store.close();
});
