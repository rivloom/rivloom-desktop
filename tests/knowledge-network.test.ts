import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { KnowledgeNetwork, type KnowledgeTransport } from '../server/knowledge-network.ts';
import { KnowledgeTools, type KnowledgeTask } from '../server/knowledge-tools.ts';
import type { BrainTopology, RivloomNode } from '../shared/types.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-knowledge-network-'));
  const ids = ['a', 'h', 'b'].map((v) => v.repeat(32)); const brainID = randomUUID();
  const brain = { id: brainID, name: 'Brain', masterNodeID: ids[1], state: 'established', online: true, queueDepth: 0, workers: [] };
  const peers = ids.map((id): RivloomNode => ({ id, name: id[0], online: true, trusted: true, channelReady: true,
    brains: [brain], capabilities: ['collaboration-v1'], local: false, verified: true, lastSeen: new Date().toISOString(),
    fingerprint: '', protocolVersion: 1, addresses: [], port: 0, worker: null } as RivloomNode));
  const calls: string[] = []; const networks: KnowledgeNetwork[] = [];
  const stores = ids.map((id) => new KnowledgeStore(join(root, id), id));
  const transports = ids.map((id, i): KnowledgeTransport => ({
    snapshot: () => ({ local: peers[i], brains: [{ ...brain, hosted: i === 1 } as BrainTopology],
      paired: peers.filter((_p, j) => j !== i && (j === 1 || i === 1)) }),
    trusted: (target) => target !== id && (i === 1 || target === ids[1]) && peers[ids.indexOf(target)]?.trusted,
    request: async (target, operation, payload) => { assert.equal(operation, 'knowledge'); calls.push(`${id[0]}->${target[0]}`); return networks[ids.indexOf(target)].handle(id, payload); },
  }));
  networks.push(...stores.map((s, i) => new KnowledgeNetwork(s, transports[i])));
  return { root, stores, networks, peers, transports, ids, brainID, calls,
    close() { networks.forEach((n) => n.close()); stores.forEach((s) => s.close()); rmSync(root, { recursive: true, force: true }); } };
}
test('A discovers and reads B only through its Brain; private metadata is absent and latest revision is fetched', async () => {
  const f = fixture();
  try {
    const visible = f.stores[2].saveMemory({ name: 'Report skill facts', description: 'Report standards', category: 'Projects/Reports', body: 'current facts', projectID: null }, 'user');
    f.stores[2].saveMemory({ name: 'PRIVATE', description: 'private', category: 'People', body: 'secret-private', projectID: null }, 'user');
    f.stores[2].share(visible.id, [f.brainID], visible.revision);
    const result = await f.networks[0].search({ brainID: f.brainID });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].id, visible.id);
    assert(!JSON.stringify(result).includes('current facts')); assert(!JSON.stringify(result).includes('PRIVATE'));
    assert(f.calls.includes('a->h')); assert(f.calls.includes('h->b')); assert(!f.calls.includes('a->b'));
    const ref = { nodeID: f.ids[2], id: visible.id, brainID: f.brainID };
    const head = await f.networks[0].manifest(ref);
    assert.equal((await f.networks[0].file(ref, head, 'MEMORY.md')).toString(), 'current facts');
    const next = f.stores[2].saveMemory({ id: visible.id, expectedRevision: visible.revision, name: visible.name, description: visible.description,
      category: visible.category, body: 'new facts', projectID: null }, 'user');
    assert.equal((await f.networks[0].manifest(ref)).entry.revision, next.revision);
    await assert.rejects(f.networks[0].file(ref, head, 'MEMORY.md'), /revision_changed/);
    f.stores[2].share(next.id, [], next.revision);
    await assert.rejects(f.networks[0].manifest(ref), /not_shared/);
    assert.equal((await f.networks[0].search({ brainID: f.brainID })).entries.length, 0);
  } finally { f.close(); }
});
test('knowledge relay rejects non-Brain readers, cross-Brain access, revoked trust and offline source', async () => {
  const f = fixture();
  try {
    const entry = f.stores[2].saveMemory({ name: 'Shared', description: '', category: 'Work', body: 'test', projectID: null }, 'user');
    f.stores[2].share(entry.id, [f.brainID], entry.revision);
    const input = { action: 'head', brainID: f.brainID, sourceNodeID: f.ids[2], id: entry.id };
    await assert.rejects(f.networks[2].handle(f.ids[0], input), /not_authorized/);
    await assert.rejects(f.networks[1].handle(f.ids[0], { ...input, brainID: randomUUID() }), /brain_unavailable/);
    f.peers[2].online = false;
    await assert.rejects(f.networks[0].manifest({ nodeID: f.ids[2], brainID: f.brainID, id: entry.id }), /source_unavailable/);
    f.peers[2].online = true; f.peers[0].trusted = false;
    await assert.rejects(f.networks[1].handle(f.ids[0], input), /not_authorized/);
  } finally { f.close(); }
});
test('relay rejects tampered chunks and revocation while an awaited read is returning', async () => {
  const f = fixture();
  try {
    const entry = f.stores[2].saveMemory({ name: 'Shared', description: '', category: 'Work', body: 'original', projectID: null }, 'user');
    f.stores[2].share(entry.id, [f.brainID], entry.revision);
    const ref = { nodeID: f.ids[2], brainID: f.brainID, id: entry.id };
    const manifest = await f.networks[0].manifest(ref);
    const original = f.transports[0].request;
    f.transports[0].request = async (...args) => {
      const result: any = await original(...args);
      if ((args[2] as any).action === 'chunk') result.data = Buffer.from('tampered').toString('base64');
      return result;
    };
    await assert.rejects(f.networks[0].file(ref, manifest, 'MEMORY.md'), /digest_mismatch/);
    f.transports[0].request = async (...args) => {
      const result = await original(...args); f.peers[1].trusted = false; return result;
    };
    await assert.rejects(f.networks[0].manifest(ref), /not_authorized/);
  } finally { f.close(); }
});

test('shared Wiki pages retain exact source identity and withdrawal denies later reads without exposing private entries', async () => {
  const f = fixture();
  const task: KnowledgeTask = { id: randomUUID(), sessionID: 'ses_shared_knowledge', directory: f.root, projectID: randomUUID(),
    privateLocal: false, brainIDs: [f.brainID], canWriteMemory: false };
  const tools = new KnowledgeTools(f.stores[0], f.networks[0], () => task);
  try {
    const entry = f.stores[2].saveMemory({ name: 'Shared long', description: '', category: 'Work', body: '跨节点知识'.repeat(6400), projectID: null }, 'user');
    const privateEntry = f.stores[2].saveMemory({ name: 'Private', description: '', category: 'Work', body: 'PRIVATE-UNSHARED', projectID: null }, 'user');
    f.stores[2].share(entry.id, [f.brainID], entry.revision);
    const ref = { brainID: f.brainID, nodeID: f.ids[2], id: entry.id, revision: entry.revision };
    const first = await tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', ref) as { content: string; nextOffset: number };
    assert(Buffer.byteLength(JSON.stringify(first)) <= 32 * 1024); assert(first.nextOffset > 0);
    const usage = tools.usage(task.id); assert.equal(usage.total, 1); assert.equal(usage.entries[0].reference.nodeID, f.ids[2]);
    assert.equal(usage.entries[0].revision, entry.revision);
    await assert.rejects(tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', { ...ref, id: privateEntry.id, revision: privateEntry.revision }), /not_shared/);
    await assert.rejects(tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', { ...ref, brainID: null }), /not_authorized/);
    f.stores[2].withdrawMemory(entry.id, entry.revision);
    await assert.rejects(tools.call(task.sessionID, task.directory, 'rivloom_knowledge_read', { ...ref, offset: first.nextOffset }), /memory_withdrawn/);
    assert.equal(tools.usage(task.id).total, 1);
    assert.equal((await f.networks[0].search({ brainID: f.brainID })).entries.length, 0);
    assert(!JSON.stringify(usage).includes('PRIVATE-UNSHARED'));
  } finally { tools.close(); f.close(); }
});
