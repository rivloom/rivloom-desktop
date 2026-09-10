import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { publishSignedUpdate, type UpdaterServices } from './ci-updater.ts';
import { parseSignedUpdate } from './updater-manifest.ts';
import type { ObjectRequest } from './ci-r2-storage.ts';
const fixture = new URL('../tests/fixtures/updater/', import.meta.url);
const key = readFileSync(new URL('public.pub', fixture), 'utf8');
const manifest = (suffix = '') => JSON.parse(readFileSync(new URL(`manifest${suffix}.json`, fixture), 'utf8'));
const artifact = (suffix = '') => readFileSync(new URL(`artifact${suffix}.txt`, fixture));
const latest = 'updates/stable/latest.json';

function harness() {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const writes: ObjectRequest[] = [];
  let nextTag = 1;
  let collide = false;
  let corruptPublic = false;
  let unavailable = false;
  const put = (path: string, bytes: Buffer) => objects.set(path, { bytes, etag: `"etag-${nextTag++}"` });
  for (const suffix of ['', '-next']) {
    const metadata = parseSignedUpdate(manifest(suffix), key).metadata;
    put(new URL(metadata.url).pathname.slice(1), artifact(suffix));
  }
  const services: UpdaterServices = {
    storage: async (request) => {
      const existing = objects.get(request.key);
      if (request.method === 'GET') return existing ? new Response(new Uint8Array(existing.bytes), { headers: { etag: existing.etag } }) : new Response(null, { status: 404 });
      writes.push(request);
      if (collide && request.key === latest) { collide = false; put(latest, Buffer.from(JSON.stringify(manifest('-next')))); return new Response(null, { status: 412 }); }
      if (request.condition && 'absent' in request.condition && existing || request.condition && 'etag' in request.condition && request.condition.etag !== existing?.etag)
        return new Response(null, { status: 412 });
      assert(request.payload?.body);
      put(request.key, Buffer.from(request.payload.body));
      return new Response(null, { status: 200 });
    },
    publicRead: async (path) => {
      if (unavailable) return new Response(null, { status: 404 });
      const existing = objects.get(path);
      if (!existing) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(corruptPublic && path.endsWith('.exe') ? Buffer.from('wrong bytes') : existing.bytes));
    },
  };
  return { services, objects, writes, put, collide: () => { collide = true; }, corrupt: () => { corruptPublic = true; }, unavailable: () => { unavailable = true; } };
}

test('publishing verifies public bytes, writes an immutable version, then conditionally promotes no-store latest', async () => {
  const test = harness();
  assert.equal((await publishSignedUpdate(manifest(), key, test.services)).status, 'published');
  assert.deepEqual(test.writes.map((r) => r.key), ['updates/stable/0.1.5.json', latest]);
  assert.equal(test.writes[0].cacheControl, 'public, max-age=31536000, immutable');
  assert.equal(test.writes[1].cacheControl, 'no-store');
  assert.deepEqual(test.writes[1].condition, { absent: true });
  test.writes.length = 0;
  assert.equal((await publishSignedUpdate(manifest(), key, test.services)).status, 'reused');
  assert.equal(test.writes.length, 0);
  assert.equal((await publishSignedUpdate(manifest('-next'), key, test.services)).status, 'published');
  assert('etag' in test.writes.at(-1)!.condition!);
});

test('bad signatures or unavailable and corrupt installers never change the channel', async () => {
  for (const corrupt of [false, true]) {
    const test = harness(); if (corrupt) test.corrupt(); else test.unavailable();
    await assert.rejects(publishSignedUpdate(manifest(), key, test.services));
    assert.equal(test.writes.length, 0);
  }
  const test = harness(); const tampered = manifest(); tampered.version = '99.0.0';
  await assert.rejects(publishSignedUpdate(tampered, key, test.services));
  assert.equal(test.writes.length, 0);
});

test('higher versions cannot be replaced by older jobs, including a lost CAS race', async () => {
  const test = harness(); test.collide();
  const result = await publishSignedUpdate(manifest(), key, test.services);
  assert.equal(result.status, 'superseded');
  assert.equal(JSON.parse(test.objects.get(latest)!.bytes.toString()).version, '0.1.6');
  assert.equal(test.writes.filter((r) => r.key === latest).length, 1);
});

test('the same update version cannot be republished with different signed bytes', async () => {
  const test = harness();
  await publishSignedUpdate(manifest(), key, test.services);
  const conflict = manifest('-conflict');
  const metadata = parseSignedUpdate(conflict, key).metadata;
  test.put(new URL(metadata.url).pathname.slice(1), artifact('-conflict'));
  await assert.rejects(publishSignedUpdate(conflict, key, test.services), /different content/);
  assert.equal(JSON.parse(test.objects.get(latest)!.bytes.toString()).rivloom.payload, manifest().rivloom.payload);
});
