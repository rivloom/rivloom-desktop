import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { filePreviewType, filePreviewTextBytes, previewRange } from '../shared/file-preview.ts';
import { taskFileChunkBytes } from '../shared/task-files.ts';
import { TaskFileStore } from '../server/task-files.ts';
import { installTaskFileAPI } from '../server/task-file-api.ts';
import type { NodeNetwork } from '../server/node-network.ts';
import type { Task, User } from '../shared/types.ts';

test('preview classification treats active documents as literal text and bounds all media ranges', () => {
  for (const name of ['page.HTML', 'image.svg', 'code.tsx']) assert.equal(filePreviewType(name).kind, 'text');
  assert.equal(filePreviewType('photo.PNG').kind, 'image'); assert.equal(filePreviewType('film.mp4').kind, 'video');
  assert.equal(filePreviewType('document.pdf').kind, 'unsupported');
  assert.deepEqual(previewRange('bytes=5-9', 100), { start: 5, end: 9 });
  assert.deepEqual(previewRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(previewRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(previewRange(undefined, 100), { start: 0, end: 99 });
  assert.equal(previewRange('bytes=0-', 20_000_000)!.end, 4 * 1024 * 1024 - 1);
  for (const range of ['bytes=100-', 'bytes=5-3', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=-', 'bytes=NaN-3']) assert.equal(previewRange(range, 100), null, range);
});

test('file previews enforce upload ownership and task membership, isolate HTML, truncate text and serve exact media ranges', async () => {
  const files = new TaskFileStore(resolve('.data', 'unit-file-preview', randomUUID()));
  const upload = (name: string, bytes: Buffer) => {
    const descriptor = { id: randomUUID(), name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'application/octet-stream' };
    files.beginUpload('owner', descriptor);
    for (let offset = 0; offset < bytes.length; offset += taskFileChunkBytes)
      files.uploadChunk('owner', descriptor.id, offset, bytes.subarray(offset, offset + taskFileChunkBytes).toString('base64'));
    return descriptor;
  };
  const html = upload('page.html', Buffer.from('<script>window.bad = true</script><p>hello</p>'));
  const long = upload('notes.txt', Buffer.alloc(filePreviewTextBytes + 20, 97));
  const media = upload('clip.mp4', Buffer.from('0123456789abcdef'));
  const taskID = randomUUID(), anotherID = randomUUID();
  const tasks = [taskID, anotherID].map((id) => ({ id, creatorID: 'owner', assigneeID: 'owner', approverID: 'reviewer', reviewerID: 'reviewer', state: 'accepted' }) as Task);
  files.bindUploaded({ scope: 'local', taskID, purpose: 'input' }, 'owner', [html.id]);
  const app = express(); app.use(express.json());
  const network = { files, snapshot: () => ({ remoteTasks: [], brainTasks: [] }) } as unknown as NodeNetwork;
  installTaskFileAPI(app, network, (req) => ({ id: String(req.headers['x-test-user'] || 'owner'), owner: false }) as User, () => tasks, () => {}, undefined, (id) => id === long.id);
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/task-files`;
  try {
    const draft = await fetch(`${base}/uploads/${html.id}/preview`);
    assert.equal(draft.status, 200); assert.match(draft.headers.get('content-type')!, /^text\/plain/);
    assert.match(draft.headers.get('content-security-policy')!, /sandbox/); assert.equal(draft.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await draft.text(), /<script>/);
    assert.equal((await fetch(`${base}/uploads/${html.id}/preview`, { headers: { 'x-test-user': 'other' } })).status, 403);
    assert.equal((await fetch(`${base}/local/${anotherID}/${html.id}/preview`)).status, 403);
    assert.equal((await fetch(`${base}/local/${taskID}/${html.id}/preview`, { headers: { 'x-test-user': 'other' } })).status, 403);
    assert.equal((await fetch(`${base}/local/${taskID}/${html.id}/preview`, { headers: { 'x-test-user': 'reviewer' } })).status, 200);
    const large = await fetch(`${base}/uploads/${long.id}/preview`); assert.equal((await large.arrayBuffer()).byteLength, filePreviewTextBytes);
    assert.equal(large.headers.get('x-preview-truncated'), 'true');
    const range = await fetch(`${base}/uploads/${media.id}/preview`, { headers: { Range: 'bytes=3-7' } });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 3-7/16'); assert.equal(await range.text(), '34567');
    assert.equal((await fetch(`${base}/uploads/${media.id}/preview`, { headers: { Range: 'bytes=100-' } })).status, 416);
    const discard = await fetch(`${base}/uploads/${long.id}/discard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(discard.status, 200); assert.equal((await discard.json()).retained, true); assert.equal(files.view(long.id).state, 'complete');
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); files.close(); }
});
