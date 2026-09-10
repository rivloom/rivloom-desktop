import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ResourceCatalog } from '../server/resource-catalog.ts';
import { ResourceNetwork, type ResourceTransport } from '../server/resource-network.ts';
import { ResourceFiles } from '../server/resource-files.ts';
import { TaskFileStore } from '../server/task-files.ts';
import { collaborationCapability } from '../shared/collaboration.ts';

async function pair(pagesPerSync = 100) {
  const base = join(process.cwd(), '.data/verification'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'resource-network-'));
  const roots = [join(root, 'a'), join(root, 'b')];
  for (const path of roots) await mkdir(join(path, 'selected'), { recursive: true });
  const nodes = ['A'.repeat(32), 'B'.repeat(32)];
  let trusted = true; let online = true;
  const calls: string[] = [];
  let intercept: ((op: string, value: unknown) => unknown) | null = null;
  const catalogs = roots.map((path, i) => new ResourceCatalog(path, nodes[i]));
  const networks: ResourceNetwork[] = [];
  const fileStores = roots.map((path) => new TaskFileStore(path));
  const resourceFiles: ResourceFiles[] = [];
  const transports = nodes.map((own, i): ResourceTransport => ({
    peers: () => [{ id: nodes[1 - i], name: 'Peer', online, channelReady: online, trusted, capabilities: [collaborationCapability] }],
    trusted: (id) => trusted && id === nodes[1 - i],
    request: async (id, op, payload) => {
      assert.equal(id, nodes[1 - i]); calls.push(op);
      if (!trusted || !online) throw new Error('offline');
      const response = op.startsWith('resource-') && op !== 'resource-query' ? resourceFiles[1 - i].handle(own, op, payload) : networks[1 - i].handle(own, op, payload);
      return intercept ? intercept(op, response) : response;
    },
  }));
  for (let i = 0; i < 2; i++) {
    networks.push(new ResourceNetwork(roots[i], catalogs[i], transports[i], () => {}, { pagesPerSync }));
    resourceFiles.push(new ResourceFiles(roots[i], catalogs[i], fileStores[i], transports[i]));
  }
  return { root, roots, nodes, catalogs, networks, resourceFiles, fileStores, transports, calls,
    setTrusted: (value: boolean) => { trusted = value; }, setOnline: (value: boolean) => { online = value; },
    intercept: (fn: typeof intercept) => { intercept = fn; },
    configure: async () => { for (let i = 0; i < 2; i++) await catalogs[i].configure({ id: randomUUID(), name: `Workspace ${i}`, directory: join(roots[i], 'selected') }); },
    close: async () => { for (const service of resourceFiles) await service.close(); for (const network of networks) await network.close();
      for (const catalog of catalogs) await catalog.close(); for (const files of fileStores) files.close(); },
  };
}
test('resource directory sync paginates, applies deltas, searches locally and reports offline facts without creating tasks', async () => {
  const f = await pair();
  try {
    for (let i = 0; i < 45; i++) await writeFile(join(f.roots[1], 'selected', `abc-${i}.md`), 'known');
    await f.configure(); await f.networks[0].sync(f.nodes[1]);
    assert.equal(f.calls.filter((call) => call === 'catalog-page').length, 3);
    const before = f.calls.length;
    const result = await f.networks[0].query({ text: 'abc-1.md', kinds: [], limit: 10 });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].nodeID, f.nodes[1]);
    assert.equal(f.calls.length, before, 'fresh indexed match makes no peer call');
    await writeFile(join(f.roots[1], 'selected', 'later.txt'), 'later'); await f.catalogs[1].refresh();
    await f.networks[0].sync(f.nodes[1]); assert(f.calls.includes('catalog-delta'));
    f.setOnline(false);
    const offline = await f.networks[0].query({ text: 'later', kinds: [], limit: 10 });
    assert.equal(offline.entries.length, 1); assert.equal(offline.nodes[1].status, 'offline'); assert(offline.partial);
    assert(!existsSync(join(f.roots[0], 'task-files', 'files.sqlite')));
    assert(f.calls.every((call) => ['catalog-head', 'catalog-page', 'catalog-delta'].includes(call)), 'discovery never dispatches execution');
  } finally { await f.close(); }
});

test('local discovery uses the current Node name independently of the selected workspace and cached queries', async () => {
  const f = await pair();
  try {
    await f.configure(); let name = 'Studio Node'; f.transports[0].localName = () => name;
    const query = { text: '', kinds: [], limit: 1 };
    const first = await f.networks[0].query(query);
    assert.equal(first.nodes[0].name, name); assert.equal(first.nodes[0].head?.workspaceName, 'Workspace 0');
    name = 'Renamed Node';
    assert.equal((await f.networks[0].query(query)).nodes[0].name, name);
  } finally { await f.close(); }
});
test('catalog acceptance rejects crossed owners, stale versions and late results after revocation', async () => {
  const f = await pair();
  try {
    await f.configure(); await f.networks[0].sync(f.nodes[1]);
    const old = f.catalogs[1].head();
    await writeFile(join(f.roots[1], 'selected', 'new.txt'), 'new'); await f.catalogs[1].refresh(); await f.networks[0].sync(f.nodes[1]);
    f.intercept((op, response) => op === 'catalog-head' ? old : response);
    await assert.rejects(f.networks[0].sync(f.nodes[1]), /stale_catalog/);
    f.intercept((op, response) => op === 'catalog-head' ? { ...f.catalogs[1].head(), nodeID: f.nodes[0] } : response);
    await assert.rejects(f.networks[0].sync(f.nodes[1]), /owner/);
    let release!: (value: unknown) => void;
    f.intercept((op, response) => op === 'catalog-head' ? new Promise((resolve) => { release = () => resolve(response); }) : response);
    const sync = f.networks[0].sync(f.nodes[1]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.setTrusted(false); f.networks[0].revoke(f.nodes[1]); release(null);
    await assert.rejects(sync); assert.equal(f.networks[0].nodes().length, 1);
    assert.throws(() => f.networks[1].handle(f.nodes[0], 'resource-query', { text: '', kinds: [], limit: 10 }), /untrusted/);
  } finally { await f.close(); }
});
test('large catalog synchronization resumes a persisted page cursor after coordinator restart', async () => {
  const f = await pair(1);
  try {
    for (let i = 0; i < 45; i++) await writeFile(join(f.roots[1], 'selected', `item-${i}.md`), 'metadata');
    await f.configure();
    const offsets: number[] = [];
    f.intercept((op, response) => { if (op === 'catalog-page') offsets.push((response as { offset: number }).offset); return response; });
    await f.networks[0].sync(f.nodes[1]);
    assert.equal(f.networks[0].nodes()[1].head?.state, 'scanning');
    await f.networks[0].close();
    f.networks[0] = new ResourceNetwork(f.roots[0], f.catalogs[0], f.transports[0], () => {}, { pagesPerSync: 1 });
    await f.networks[0].sync(f.nodes[1]); await f.networks[0].sync(f.nodes[1]);
    assert.deepEqual(offsets, [0, 20, 40]);
    assert.equal(f.networks[0].nodes()[1].head?.state, 'ready');
    const result = await f.networks[0].query({ text: 'item', kinds: [], limit: 20 });
    assert.equal(result.entries.length, 20); assert(result.more);
  } finally { await f.close(); }
});
test('query deduplication uses bounded data fanout and preserves unknown results distinctly from no match', async () => {
  const f = await pair();
  try {
    await f.configure();
    const query = { text: 'missing', kinds: [], limit: 10 };
    const [a, b] = await Promise.all([f.networks[0].query(query), f.networks[0].query(query)]);
    assert.deepEqual(a, b); assert.equal(f.calls.filter((call) => call === 'resource-query').length, 1);
    assert.equal(a.entries.length, 0); assert.equal(a.nodes[1].status, 'current');
    f.intercept(() => { throw new Error('lost reply'); });
    const unknown = await f.networks[0].query({ ...query, text: 'different' });
    assert.equal(unknown.nodes[1].status, 'timeout'); assert(unknown.partial);
  } finally { await f.close(); }
});
test('task-scoped materials resume durable chunks after lost replies and reject revoked or changed resource references', async () => {
  const f = await pair();
  try {
    const contents = Buffer.alloc(180_000, 17);
    await writeFile(join(f.roots[1], 'selected', 'material.bin'), contents); await f.configure();
    const reference = (({ nodeID, workspaceID, id, revision }) => ({ nodeID, workspaceID, id, revision }))(f.catalogs[1].entries()[0]);
    const workflowID = randomUUID(); let chunks = 0;
    f.intercept((op, response) => { if (op === 'resource-chunk' && ++chunks === 2) throw new Error('lost reply'); return response; });
    await assert.rejects(f.resourceFiles[0].fetch(workflowID, reference), /lost reply/);
    f.intercept(null);
    const file = await f.resourceFiles[0].fetch(workflowID, reference);
    assert.equal(file.sha256, createHash('sha256').update(contents).digest('hex'));
    assert(f.fileStores[0].content(file.id).equals(contents));
    assert.equal((await f.resourceFiles[0].fetch(workflowID, reference)).id, file.id, 'retry reuses material identity');
    f.setTrusted(false);
    assert.throws(() => f.resourceFiles[1].handle(f.nodes[0], 'resource-chunk', { workflowID, reference, offset: 0 }), /authorized/);
    f.setTrusted(true); await f.catalogs[1].configure(null);
    await assert.rejects(f.resourceFiles[0].fetch(randomUUID(), reference), /authorized/);
    assert.throws(() => f.resourceFiles[1].handle(f.nodes[0], 'resource-prepare', { workflowID, reference: { ...reference, path: '../outside' } }), /authorized/);
  } finally { await f.close(); }
});
