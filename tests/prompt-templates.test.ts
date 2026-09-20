import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { PromptTemplateError, PromptTemplateStore } from '../server/prompt-templates.ts';
import { installPromptTemplateAPI } from '../server/prompt-template-api.ts';
import { listenHttp } from '../server/http-ports.ts';
import { filterPromptTemplates, maximumPromptTemplates, validPromptTemplateInput, type PromptTemplateInput } from '../shared/prompt-templates.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  let tick = 0;
  const store = new PromptTemplateStore(db, () => new Date(1_800_000_000_000 + tick++ * 1000).toISOString());
  return { db, store };
}
const content = { title: 'Review a change', text: '  Check errors and describe evidence.\n\nKeep source details.  ' };
const code = (expected: string) => (error: unknown) => error instanceof PromptTemplateError && error.code === expected;

test('templates keep exact body text, return only public fields and survive store reconstruction', () => {
  const { db, store } = fixture();
  try {
    const created = store.create('owner', { ...content, title: '  Review a change  ' });
    assert.equal(created.title, content.title); assert.equal(created.text, content.text); assert.equal(created.revision, 1);
    assert.deepEqual(Object.keys(created).sort(), ['id', 'revision', 'text', 'title', 'updatedAt']);
    const updated = store.update('owner', created.id, 1, { title: 'Updated', text: 'New request' });
    assert.equal(updated.revision, 2); assert(updated.updatedAt > created.updatedAt);
    assert.deepEqual(new PromptTemplateStore(db).list('owner'), [updated]);
    store.delete('owner', created.id, 2); assert.deepEqual(store.list('owner'), []);
  } finally { db.close(); }
});

test('templates are scoped to the authenticated owner for list, read, update and deletion', () => {
  const { db, store } = fixture();
  try {
    const privateTemplate = store.create('alice', content);
    assert.deepEqual(store.list('bob'), []);
    assert.throws(() => store.get('bob', privateTemplate.id), code('prompt_template_missing'));
    assert.throws(() => store.update('bob', privateTemplate.id, 1, { title: 'Hijack', text: 'Changed' }), code('prompt_template_missing'));
    assert.throws(() => store.delete('bob', privateTemplate.id, 1), code('prompt_template_missing'));
    const separate = store.create('bob', { title: 'Bob only', text: 'Different content' }, privateTemplate.id);
    assert.deepEqual(store.get('alice', privateTemplate.id), privateTemplate);
    assert.deepEqual(store.list('bob'), [separate]);
    const literalUser = "' OR 1=1 --";
    store.create(literalUser, { title: 'Literal user', text: "'; DROP TABLE prompt_templates; --" });
    assert.equal(store.list(literalUser).length, 1); assert.equal(store.list('alice').length, 1);
  } finally { db.close(); }
});

test('stale updates and deletions cannot overwrite a newer revision held by another store', () => {
  const { db, store } = fixture(), other = new PromptTemplateStore(db);
  try {
    const initial = store.create('owner', content), stale = other.get('owner', initial.id);
    const latest = store.update('owner', initial.id, initial.revision, { title: 'Newest', text: 'Keep newer content' });
    assert.throws(() => other.update('owner', stale.id, stale.revision, content), code('prompt_template_conflict'));
    assert.throws(() => other.delete('owner', stale.id, stale.revision), code('prompt_template_conflict'));
    assert.deepEqual(store.get('owner', initial.id), latest);
    other.delete('owner', latest.id, latest.revision);
    assert.throws(() => store.update('owner', latest.id, latest.revision, content), code('prompt_template_missing'));
  } finally { db.close(); }
});

test('the per-user limit is atomic and does not block other accounts or safe creation retries', () => {
  const { db, store } = fixture(), other = new PromptTemplateStore(db);
  try {
    const first = store.create('owner', content);
    for (let index = 1; index < maximumPromptTemplates - 1; index++) store.create('owner', { title: `Template ${index}`, text: 'Request' });
    const final = other.create('owner', { title: 'Last available slot', text: 'Request' });
    assert.equal(store.list('owner').length, maximumPromptTemplates);
    assert.throws(() => store.create('owner', content), code('prompt_template_limit'));
    assert.deepEqual(store.create('owner', content, first.id), first);
    assert.throws(() => store.create('owner', { ...content, text: 'Not the original request' }, first.id), code('prompt_template_conflict'));
    assert.equal(store.create('another-user', content).revision, 1);
    store.delete('owner', final.id, final.revision);
    store.create('owner', { title: 'Reclaimed slot', text: 'Request' });
    assert.equal(store.list('owner').length, maximumPromptTemplates);
  } finally { db.close(); }
});

test('content boundaries match composer UTF-16 lengths and reject hidden fields and invalid revisions', () => {
  const { db, store } = fixture();
  try {
    const exact = { title: '名'.repeat(80), text: '🙂'.repeat(6000) };
    assert(validPromptTemplateInput(exact)); store.create('owner', exact);
    const invalid: unknown[] = [null, [], {}, { ...content, userID: 'bob' }, { ...content, title: '' }, { ...content, title: '  ' },
      { ...content, title: 'a'.repeat(81) }, { ...content, title: 'a\nb' }, { ...content, title: 'a\u2028b' },
      { ...content, text: '  \n ' }, { ...content, text: 'x'.repeat(12001) }, { ...content, text: 'a\u0000b' }];
    for (const value of invalid) {
      assert.equal(validPromptTemplateInput(value), false);
      assert.throws(() => store.create('owner', value as PromptTemplateInput), code('prompt_template_invalid'));
    }
    const created = store.create('owner', content);
    for (const revision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.update('owner', created.id, revision, content), code('prompt_template_invalid'));
      assert.throws(() => store.delete('owner', created.id, revision), code('prompt_template_invalid'));
    }
    assert.throws(() => store.list(''), code('prompt_template_invalid'));
    assert.throws(() => store.get('owner', '../someone'), code('prompt_template_invalid'));
    assert.deepEqual(store.get('owner', created.id), created);
  } finally { db.close(); }
});

test('literal title and body search retains all original templates without regex interpretation', () => {
  const { db, store } = fixture();
  try {
    const first = store.create('owner', { title: 'Review [API]', text: 'Check SQLite changes' });
    const second = store.create('owner', { title: 'Plan', text: 'Write a schedule' });
    const templates = [first, second], original = structuredClone(templates);
    assert.deepEqual(filterPromptTemplates(templates, ' SQLITE '), [first]);
    assert.deepEqual(filterPromptTemplates(templates, '[API]'), [first]);
    assert.deepEqual(filterPromptTemplates(templates, '.*'), []);
    assert.deepEqual(filterPromptTemplates(templates, ''), templates); assert.deepEqual(templates, original);
  } finally { db.close(); }
});

test('HTTP template API uses only authenticated identity, rejects forged fields, and enforces revisions', async () => {
  const { db, store } = fixture(), app = express(); app.use(express.json());
  // The installer relies on the application's existing authentication gate.
  app.use((req, res, next) => { if (!req.headers['x-test-user']) { res.status(401).json({ error: 'unauthorized' }); return; } next(); });
  installPromptTemplateAPI(app, req => ({ id: String(req.headers['x-test-user']) }), store);
  const server = createServer(app);
  try {
    await listenHttp(server, '127.0.0.1');
    const address = server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/prompt-templates`;
    async function request(user: string, suffix = '', body?: unknown) {
      const response = await fetch(base + suffix, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(user ? { 'x-test-user': user } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request('')).status, 401);
    const id = randomUUID(), created = await request('alice', '', { id, ...content });
    assert.equal(created.status, 201); assert.equal(created.body.revision, 1);
    assert.equal((await request('alice', '', { id, ...content })).body.id, id);
    assert.equal((await request('bob', '?userID=alice')).body.templates.length, 0);
    assert.equal((await request('bob', `/${id}`)).status, 404);
    assert.equal((await request('bob', `/${id}`, { revision: 1, ...content })).status, 404);
    assert.equal((await request('bob', `/${id}/delete`, { revision: 1 })).status, 404);
    assert.equal((await request('bob', '', { id: randomUUID(), ...content, userID: 'alice' })).status, 400);
    assert.equal((await request('alice', `/${id}`, { revision: 1, title: 'New title', text: 'New body' })).body.revision, 2);
    assert.deepEqual(await request('alice', `/${id}`, { revision: 1, ...content }), { status: 409, body: { error: 'prompt_template_conflict' } });
    assert.equal((await request('alice', `/${id}/delete`, { revision: 1 })).status, 409);
    assert.equal((await request('alice', `/${id}/delete`, { revision: 2, userID: 'bob' })).status, 400);
    assert.equal((await request('alice', `/${id}`)).body.text, 'New body');
    assert.equal((await request('alice', `/${id}/delete`, { revision: 2 })).body.deleted, true);
    assert.deepEqual((await request('alice')).body, { templates: [], limit: maximumPromptTemplates });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close();
  }
});
