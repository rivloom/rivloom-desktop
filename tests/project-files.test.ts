import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Project, User } from '../shared/types.ts';
import { listProjectFiles, readProjectFile, saveProjectText } from '../server/project-files.ts';
import { installProjectFilesAPI } from '../server/project-files-api.ts';

test('project browsing excludes secrets and links, limits scope and preserves originals on save conflicts', async () => {
  const root = resolve('.data/unit-office-projects', randomUUID()); await mkdir(`${root}/资料`, { recursive: true });
  await writeFile(`${root}/资料/说明.md`, '# 原文\n'); await writeFile(`${root}/.env`, 'synthetic secret');
  const listing = await listProjectFiles(root, '', '说明'); assert.deepEqual(listing.entries.map(entry => entry.path), ['资料/说明.md']);
  assert.ok(!(await listProjectFiles(root)).entries.some(entry => entry.name === '.env'));
  for (const path of ['../outside.txt', '/outside.txt', '.env', '资料/../.env', '资料/说明.md:stream']) await assert.rejects(readProjectFile(root, path));
  const before = await readProjectFile(root, '资料/说明.md');
  await writeFile(`${root}/资料/说明.md`, '另一个程序');
  await assert.rejects(saveProjectText(root, '资料/说明.md', before.revision, '我的修改'), /office_changed/);
  assert.equal(await readFile(`${root}/资料/说明.md`, 'utf8'), '另一个程序');
  const current = await readProjectFile(root, '资料/说明.md');
  await saveProjectText(root, '资料/说明.md', current.revision, '保存成功');
  assert.equal(await readFile(`${root}/资料/说明.md`, 'utf8'), '保存成功');
  await symlink(resolve(root, '..'), `${root}/redirect`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readProjectFile(root, 'redirect/outside.txt'), /office_path/);
});
test('project file APIs enforce ownership, preserve file revision, support empty text and reject writes to office files', async () => {
  const root = resolve('.data/unit-office-api', randomUUID()); await mkdir(root, { recursive: true });
  await writeFile(`${root}/notes.txt`, 'original'); await writeFile(`${root}/empty.md`, '');
  const id = randomUUID(), app = express(); app.use(express.json());
  installProjectFilesAPI(app, req => ({ id: 'owner', owner: req.headers['x-member'] !== 'true' }) as User,
    () => [{ id, name: 'fixture', directory: root }] as Project[]);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${id}`;
  try {
    assert.equal((await fetch(`${base}/files`, { headers: { 'x-member': 'true' } })).status, 403);
    assert.equal((await fetch(`${base}/file/notes.txt/document`, { headers: { 'x-member': 'true' } })).status, 403);
    const document = await (await fetch(`${base}/file/notes.txt/document`)).json(); assert.equal(document.text, 'original');
    const wrong = await fetch(`${base}/file/notes.txt/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'overwrite', expectedRevision: '0'.repeat(64) }) });
    assert.equal(wrong.status, 409); assert.equal(await readFile(`${root}/notes.txt`, 'utf8'), 'original');
    const saved = await fetch(`${base}/file/notes.txt/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '', expectedRevision: document.revision }) });
    assert.equal(saved.status, 200); assert.equal(await readFile(`${root}/notes.txt`, 'utf8'), '');
    assert.equal((await (await fetch(`${base}/file/empty.md/document`)).json()).editable, true);
    const exportBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destination: `${root}/new-copy.txt` }) };
    assert.equal((await fetch(`${base}/file/empty.md/export`, exportBody)).status, 200);
    assert.equal((await fetch(`${base}/file/empty.md/export`, exportBody)).status, 409);
    assert.equal((await fetch(`${base}/file/empty.md/export`, { ...exportBody, headers: { ...exportBody.headers, 'x-member': 'true' } })).status, 403);
    assert.equal((await fetch(`${base}/file/${encodeURIComponent('../outside.txt')}/document`)).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
