import { z } from 'zod';
import type { NodeNetwork as NetworkSnapshot } from '../shared/types.ts';
import { knowledgeRequestSchema, knowledgeManifestSchema, knowledgeMetaSchema, knowledgeRevision, knowledgeLimits,
  knowledgeRefSchema, type KnowledgeRequest, type KnowledgeRef, type KnowledgeManifest, type KnowledgeSearch,
  type KnowledgeMeta } from '../shared/knowledge.ts';
import { KnowledgeStore, knowledgeHash } from './knowledge-store.ts';

export type KnowledgeTransport = {
  snapshot: () => Pick<NetworkSnapshot, 'local' | 'paired' | 'brains'>;
  trusted: (nodeID: string) => boolean;
  request: (nodeID: string, operation: string, payload: unknown) => Promise<unknown>;
};
const pageSchema = z.object({ entries: z.array(knowledgeMetaSchema).max(knowledgeLimits.page),
  next: z.number().int().min(1).max(knowledgeLimits.entries).nullable(), generation: knowledgeRevision,
  unavailable: z.array(z.object({ nodeID: z.string(), reason: z.string() }).strict()).max(64).optional() }).strict();
const chunkSchema = z.object({ id: z.string(), revision: knowledgeRevision, path: z.string(), offset: z.number().int().min(0),
  data: z.string().max(knowledgeLimits.chunkBytes * 2).regex(/^[A-Za-z0-9+/]*={0,2}$/), next: z.number().int().min(1).nullable() }).strict();
export class KnowledgeNetwork {
  readonly store: KnowledgeStore;
  private transport: KnowledgeTransport;
  private active = 0;
  private closed = false;
  constructor(store: KnowledgeStore, transport: KnowledgeTransport) { this.store = store; this.transport = transport; }
  brains() { return this.transport.snapshot().brains.map((b) => ({ id: b.id, name: b.name, masterNodeID: b.masterNodeID, online: b.online })); }
  private brain(brainID: string) {
    const value = this.transport.snapshot().brains.find((b) => b.id === brainID);
    if (!value) throw new Error('knowledge_brain_unavailable'); return value;
  }
  private member(id: string, brainID: string, reachable = true) {
    const brain = this.brain(brainID);
    if (id === this.store.nodeID) return true;
    const peer = this.transport.snapshot().paired?.find((p) => p.id === id);
    return !!peer && this.transport.trusted(id) && peer.trusted && (!reachable || peer.online && peer.channelReady) &&
      peer.brains.some((b) => b.id === brainID && b.masterNodeID === brain.masterNodeID);
  }
  private authorize(peer: string, request: KnowledgeRequest) {
    if (this.closed) throw new Error('knowledge_closed');
    const brain = this.brain(request.brainID);
    if (peer !== this.store.nodeID && !this.member(peer, brain.id)) throw new Error('knowledge_not_authorized');
    if (request.sourceNodeID === this.store.nodeID && peer === brain.masterNodeID) return;
    if (brain.masterNodeID !== this.store.nodeID || !brain.hosted) throw new Error('knowledge_not_brain_host');
    if (request.sourceNodeID && !this.member(request.sourceNodeID, brain.id)) throw new Error('knowledge_source_unavailable');
  }
  private async request(peer: string, payload: KnowledgeRequest) {
    if (this.closed || this.active >= 8) throw new Error('knowledge_network_busy');
    this.active++; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([this.transport.request(peer, 'knowledge', payload), new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('knowledge_network_timeout')), 12_000); timer.unref();
      })]);
      if (this.closed || !this.member(peer, payload.brainID)) throw new Error('knowledge_not_authorized');
      if (Buffer.byteLength(JSON.stringify(result)) > 58_000) throw new Error('knowledge_response_too_large');
      return result;
    } finally { this.active--; if (timer) clearTimeout(timer); }
  }
  async handle(peer: string, raw: unknown): Promise<unknown> {
    const input = knowledgeRequestSchema.parse(raw); this.authorize(peer, input);
    const result = input.sourceNodeID && input.sourceNodeID !== this.store.nodeID
      ? await this.request(input.sourceNodeID, input)
      : input.sourceNodeID === this.store.nodeID ? await this.source(input) : await this.catalog(input);
    this.authorize(peer, input); return result;
  }
  private async source(input: KnowledgeRequest) {
    if (input.action === 'catalog') {
      if ((input.offset || 0) === 0) await this.store.refreshAll();
      return this.store.listShared(input.brainID, input.offset || 0, input.generation);
    }
    if (!input.id) throw new Error('knowledge_invalid_request');
    if (input.action === 'head') return this.store.refreshManifest(input.id, input.brainID);
    if (!input.revision || !input.path) throw new Error('knowledge_invalid_request');
    return this.store.chunk(input.id, input.revision, input.path, input.offset || 0, input.brainID);
  }
  private async sourceCatalog(id: string, brainID: string) {
    const entries: KnowledgeMeta[] = []; let offset: number | null = 0; let generation: string | undefined;
    do {
      const request: KnowledgeRequest = { action: 'catalog', brainID, sourceNodeID: id, offset,
        ...(generation ? { generation } : {}) };
      const page = pageSchema.parse(id === this.store.nodeID ? await this.source(request) : await this.request(id, request));
      if (page.entries.some((v) => v.nodeID !== id) || generation && generation !== page.generation ||
        page.next !== null && (page.next !== offset + page.entries.length || !page.entries.length)) throw new Error('knowledge_invalid_catalog');
      entries.push(...page.entries); generation = page.generation; offset = page.next;
      if (entries.length > knowledgeLimits.entries) throw new Error('knowledge_catalog_full');
    } while (offset !== null);
    if (new Set(entries.map((v) => v.id)).size !== entries.length) throw new Error('knowledge_invalid_catalog');
    return entries;
  }
  private async catalog(input: KnowledgeRequest) {
    if (input.action !== 'catalog' || this.brain(input.brainID).masterNodeID !== this.store.nodeID) throw new Error('knowledge_invalid_request');
    const peers = (this.transport.snapshot().paired || []).filter((p) => this.member(p.id, input.brainID, false)).slice(0, 63);
    const entries: KnowledgeMeta[] = []; const unavailable: { nodeID: string; reason: string }[] = [];
    for (const id of [this.store.nodeID, ...peers.map((p) => p.id)]) {
      if (!this.member(id, input.brainID)) { unavailable.push({ nodeID: id, reason: 'knowledge_source_offline' }); continue; }
      try { entries.push(...await this.sourceCatalog(id, input.brainID)); }
      catch { unavailable.push({ nodeID: id, reason: 'knowledge_source_unavailable' }); }
      if (entries.length > knowledgeLimits.entries) throw new Error('knowledge_catalog_full');
    }
    entries.sort((a, b) => a.nodeID.localeCompare(b.nodeID) || a.id.localeCompare(b.id));
    const generation = knowledgeHash(JSON.stringify(entries));
    if (input.generation && generation !== input.generation) throw new Error('knowledge_catalog_changed');
    const offset = input.offset || 0;
    if (offset > entries.length) throw new Error('knowledge_invalid_offset');
    return { entries: entries.slice(offset, offset + knowledgeLimits.page), generation,
      next: offset + knowledgeLimits.page < entries.length ? offset + knowledgeLimits.page : null, unavailable };
  }
  async search(options: { brainID?: string | null; text?: string; kind?: 'skill' | 'memory'; category?: string;
    projectID?: string | null; privateLocal?: boolean; offset?: number; allowedBrainIDs?: string[] } = {}): Promise<KnowledgeSearch> {
    if (this.closed) throw new Error('knowledge_closed');
    const entries: KnowledgeSearch['entries'] = []; const unavailable: KnowledgeSearch['unavailable'] = [];
    const snap = this.transport.snapshot();
    if (options.brainID === undefined || options.brainID === null) {
      if (options.privateLocal !== false) entries.push(...this.store.listLocal(options.projectID).filter((v) => !v.error).map((v) => {
        const { id, nodeID, kind, name, description, category, revision, updatedAt } = v;
        return { id, nodeID, kind, name, description, category, revision, updatedAt, brainID: null, nodeName: snap.local?.name || nodeID };
      }));
    }
    const brains = options.brainID === null ? [] : snap.brains.filter((b) => (options.brainID === undefined || b.id === options.brainID) &&
      (options.allowedBrainIDs === undefined || options.allowedBrainIDs.includes(b.id)));
    if (options.brainID && !brains.length) throw new Error('knowledge_brain_unavailable');
    for (const brain of brains) {
      let offset: number | null = 0; let generation: string | undefined;
      const collected: KnowledgeSearch['entries'] = [];
      try {
        do {
          const payload: KnowledgeRequest = { action: 'catalog', brainID: brain.id, offset, ...(generation ? { generation } : {}) };
          const page = pageSchema.parse(brain.masterNodeID === this.store.nodeID ? await this.handle(this.store.nodeID, payload) : await this.request(brain.masterNodeID, payload));
          if (generation && generation !== page.generation || page.next !== null && page.next !== offset + page.entries.length) throw new Error('knowledge_invalid_catalog');
          generation = page.generation; offset = page.next;
          collected.push(...page.entries.map((v) => ({ ...v, brainID: brain.id,
            nodeName: snap.local?.id === v.nodeID ? snap.local.name : snap.paired?.find((p) => p.id === v.nodeID)?.name || v.nodeID })));
          if (collected.length > knowledgeLimits.entries) throw new Error('knowledge_catalog_full');
          if (page.unavailable) unavailable.push(...page.unavailable);
        } while (offset !== null);
        entries.push(...collected);
      } catch { unavailable.push({ nodeID: brain.masterNodeID, reason: 'knowledge_brain_unavailable' }); }
    }
    const unique = [...new Map(entries.map((v) => [`${v.brainID}:${v.nodeID}:${v.id}`, v])).values()];
    const query = (options.text || '').toLocaleLowerCase(); const prefix = options.category || '';
    const matches = unique.filter((v) => (!options.kind || v.kind === options.kind) &&
      (!prefix || v.category === prefix || v.category.startsWith(`${prefix}/`)) &&
      `${v.name}\n${v.description}\n${v.category}`.toLocaleLowerCase().includes(query));
    const offset = options.offset || 0;
    return { entries: matches.slice(offset, offset + knowledgeLimits.page), next: offset + knowledgeLimits.page < matches.length ? offset + knowledgeLimits.page : null,
      unavailable: [...new Map(unavailable.map((v) => [v.nodeID, v])).values()] };
  }
  private async fetch(ref: KnowledgeRef, payload: Pick<KnowledgeRequest, 'action' | 'revision' | 'path' | 'offset'>) {
    knowledgeRefSchema.parse(ref);
    if (ref.brainID === null) {
      if (ref.nodeID !== this.store.nodeID) throw new Error('knowledge_not_authorized');
      return payload.action === 'head' ? this.store.refreshManifest(ref.id) : this.store.chunk(ref.id, payload.revision!, payload.path!, payload.offset || 0);
    }
    const brain = this.brain(ref.brainID);
    const input: KnowledgeRequest = { ...payload, brainID: ref.brainID, sourceNodeID: ref.nodeID, id: ref.id };
    return brain.masterNodeID === this.store.nodeID ? this.handle(this.store.nodeID, input) : this.request(brain.masterNodeID, input);
  }
  async manifest(ref: KnowledgeRef): Promise<KnowledgeManifest> {
    const result = knowledgeManifestSchema.parse(await this.fetch(ref, { action: 'head' }));
    if (result.entry.id !== ref.id || result.entry.nodeID !== ref.nodeID) throw new Error('knowledge_wrong_source'); return result;
  }
  async file(ref: KnowledgeRef, manifest: KnowledgeManifest, path: string): Promise<Buffer> {
    const file = manifest.files.find((v) => v.path === path); if (!file) throw new Error('knowledge_file_not_found');
    const chunks: Buffer[] = []; let offset = 0;
    do {
      const value = chunkSchema.parse(await this.fetch(ref, { action: 'chunk', revision: manifest.entry.revision, path, offset }));
      if (value.id !== ref.id || value.revision !== manifest.entry.revision || value.path !== path || value.offset !== offset) throw new Error('knowledge_invalid_chunk');
      const bytes = Buffer.from(value.data, 'base64');
      if (bytes.length > knowledgeLimits.chunkBytes || bytes.toString('base64') !== value.data || offset + bytes.length > file.bytes ||
        value.next !== (offset + bytes.length < file.bytes ? offset + bytes.length : null) || bytes.length === 0 && offset < file.bytes) throw new Error('knowledge_invalid_chunk');
      chunks.push(bytes); offset += bytes.length;
      if (value.next === null) break;
    } while (offset < file.bytes);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== file.bytes || knowledgeHash(bytes) !== file.sha256) throw new Error('knowledge_digest_mismatch');
    // Re-check grant/latest after the last awaited chunk, including a zero-byte file.
    if ((await this.manifest(ref)).entry.revision !== manifest.entry.revision) throw new Error('knowledge_revision_changed');
    return bytes;
  }
  close() { this.closed = true; }
}
