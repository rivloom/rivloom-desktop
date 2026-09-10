import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rename, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceCatalog } from '../server/resource-catalog.ts';
import { validCatalogDelta, validCatalogPage } from '../shared/resources.ts';

async function fixture(options: ConstructorParameters<typeof ResourceCatalog>[2] = {}) {
  const base = join(process.cwd(), '.data/verification'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'resource-catalog-'));
  const directory = join(root, 'selected'); await mkdir(directory);
  const scope = { id: randomUUID(), name: 'Selected', directory };
  const catalog = new ResourceCatalog(root, 'A'.repeat(32), options);
  return { root, directory, scope, catalog };
}
test('catalog only indexes configured scope and produces add/change/remove deltas with stable references', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'abc.md'), 'one');
    assert.equal(f.catalog.head().state, 'unconfigured');
    assert.equal(f.catalog.entries().length, 0);
    await f.catalog.configure(f.scope);
    const first = f.catalog.head(); const original = f.catalog.entries()[0];
    assert.equal(first.count, 1); assert.equal(first.state, 'ready');
    assert(!JSON.stringify(f.catalog.head()).includes(f.directory));
    assert(validCatalogPage(f.catalog.page(first.epoch, first.version, 0)));
    await f.catalog.refresh(); assert.equal(f.catalog.head().version, first.version, 'unchanged scans do not bump catalog version');
    await writeFile(join(f.directory, 'abc.md'), 'changed contents');
    await writeFile(join(f.directory, 'music.wav'), 'wave'); await f.catalog.refresh();
    const delta = f.catalog.delta(first.epoch, first.version)!;
    assert(validCatalogDelta(delta)); assert.equal(delta.upsert.length, 2);
    assert.equal(delta.upsert.find((entry) => entry.name === 'abc.md')?.id, original.id);
    assert.notEqual(delta.upsert.find((entry) => entry.name === 'abc.md')?.revision, original.revision);
    await assert.rejects(f.catalog.openResource(original), /resource_unavailable/);
    const updated = f.catalog.entries().find((entry) => entry.name === 'abc.md')!;
    const opened = await f.catalog.openResource(updated); assert.equal(await opened.handle.readFile('utf8'), 'changed contents'); await opened.handle.close();
    const second = f.catalog.head(); await rename(join(f.directory, 'abc.md'), join(f.directory, 'script.md'));
    await unlink(join(f.directory, 'music.wav')); await f.catalog.refresh();
    const renamed = f.catalog.delta(second.epoch, second.version)!;
    assert.equal(renamed.removed.length, 2); assert.equal(renamed.upsert[0].name, 'script.md');
    assert.throws(() => f.catalog.page(first.epoch, first.version, 0), /version_changed/);
    await f.catalog.configure(null); assert.equal(f.catalog.head().count, 0); assert.equal(f.catalog.head().state, 'unconfigured');
    await assert.rejects(f.catalog.openResource(updated));
  } finally { await f.catalog.close(); }
});
test('catalog excludes secret/dependency/link paths, bounds traversal and persists truthful incomplete metadata', async () => {
  const f = await fixture({ limit: 3, batch: 1 });
  try {
    for (const name of ['.env', 'credentials.json', 'private.key', 'safe1.txt', 'safe2.txt', 'safe3.txt', 'safe4.txt']) await writeFile(join(f.directory, name), 'data');
    await mkdir(join(f.directory, 'node_modules')); await writeFile(join(f.directory, 'node_modules', 'hidden.md'), 'private');
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.md'), 'private');
    await symlink(outside, join(f.directory, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.catalog.configure(f.scope);
    assert.equal(f.catalog.head().state, 'partial'); assert.equal(f.catalog.head().count, 3);
    assert(f.catalog.entries().every((entry) => entry.name.startsWith('safe')));
    const saved = f.catalog.head(); await f.catalog.close();
    const restarted = new ResourceCatalog(f.root, 'A'.repeat(32));
    try {
      assert.equal(restarted.head().version, saved.version);
      await assert.rejects(restarted.openResource(restarted.entries()[0]), /unavailable/, 'restart does not activate a saved directory without current configuration');
      await restarted.configure(null); assert.equal(restarted.head().count, 0);
    } finally { await restarted.close(); }
  } finally { /* This test closes before reopening its database. */ }
});
test('directory changes cancel scans/probes and reject stale file identity without losing responsiveness', async () => {
  let release!: () => void; let signal!: () => void;
  const reached = new Promise<void>((r) => { signal = r; });
  const blocked = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const f = await fixture({ batch: 1, capabilities: async () => { if (++calls === 1) { signal(); await blocked; } return []; } });
  try {
    await writeFile(join(f.directory, 'old.md'), 'old');
    const pending = f.catalog.configure(f.scope); await reached;
    await f.catalog.configure(null); assert.equal(f.catalog.head().state, 'unconfigured');
    release(); await pending; assert.equal(f.catalog.head().count, 0);
    await f.catalog.configure(f.scope);
    const entry = f.catalog.entries()[0]; await writeFile(join(f.directory, 'old.md'), 'edited after index');
    await assert.rejects(f.catalog.openResource(entry), /version_changed/);
    let ticked = false; setImmediate(() => { ticked = true; });
    await f.catalog.refresh(); assert(ticked, 'scan yielded to the event loop');
  } finally { release(); await f.catalog.close(); }
});
