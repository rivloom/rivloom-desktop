import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collaborationCapability, integer, keys, record, uuid } from '../shared/collaboration.ts';
import { entriesMatchHead, resourceFreshMilliseconds, searchResources, validCatalogDelta, validCatalogHead,
  validCatalogPage, validResourceEntry, validResourceQuery, validResourceQueryResult,
  type CatalogHead, type ResourceEntry, type ResourceQuery, type ResourceDiscoveryResult, type ResourceDiscoveryNode } from '../shared/resources.ts';
import type { ResourceCatalog } from './resource-catalog.ts';

type Peer = { id: string; name: string; online: boolean; channelReady: boolean; trusted: boolean; capabilities: string[] };
type Cached = { head: CatalogHead; entries: ResourceEntry[]; confirmedAt: number };
export type ResourceTransport = {
  localName?: () => string;
  peers: () => Peer[]; trusted: (id: string) => boolean;
  request: (peer: string, operation: string, payload: unknown) => Promise<unknown>;
};
export class ResourceNetwork {
  private db: DatabaseSync;
  private cached = new Map<string, Cached>();
  private stages = new Map<string, { head: CatalogHead; offset: number }>();
  private syncing = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();
  private queries = new Map<string, Promise<ResourceDiscoveryResult>>();
  private queryCache = new Map<string, { until: number; result: ResourceDiscoveryResult }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeSyncs = 0;
  private closed = false;
  private transport: ResourceTransport;
  private catalog: ResourceCatalog;
  private changed: () => void;
  private pagesPerSync: number;
  constructor(root: string, catalog: ResourceCatalog, transport: ResourceTransport, changed: () => void = () => {}, limits = { pagesPerSync: 100 }) {
    this.catalog = catalog; this.transport = transport; this.changed = changed;
    if (!integer(limits.pagesPerSync, 100, 1)) throw new Error('invalid_sync_budget');
    this.pagesPerSync = limits.pagesPerSync;
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'resource-directory.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stage_entries (peer TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(peer,id));`);
    for (const row of this.db.prepare('SELECT id,body FROM peers').all()) {
      try {
        const value = JSON.parse(String(row.body)) as Cached;
        if (validCatalogHead(value.head) && value.head.nodeID === row.id && Array.isArray(value.entries) &&
          value.entries.length === value.head.count && value.entries.every(validResourceEntry) && entriesMatchHead(value.entries, value.head))
          this.cached.set(String(row.id), { ...value, confirmedAt: 0 }); // A restart is not a fresh peer observation.
      } catch { /* Invalid discovery cache is discarded, never used as file authority. */ }
    }
    for (const row of this.db.prepare('SELECT id,body FROM stages').all()) {
      try {
        const value = JSON.parse(String(row.body));
        if (validCatalogHead(value.head) && value.head.nodeID === row.id && integer(value.offset, value.head.count) &&
          Number(this.db.prepare('SELECT COUNT(*) AS count FROM stage_entries WHERE peer=?').get(row.id)!.count) === value.offset)
          this.stages.set(String(row.id), value);
      } catch { /* A partial transfer can be restarted without losing the last complete catalog. */ }
    }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.reconcile(), 5000); this.timer.unref();
    this.reconcile();
  }
  reconcile() {
    if (this.closed) return;
    for (const id of new Set([...this.cached.keys(), ...this.stages.keys()])) if (!this.transport.trusted(id)) this.revoke(id);
    for (const peer of this.transport.peers()) {
      if (this.activeSyncs >= 2) break;
      if (!this.reachable(peer) || this.syncing.has(peer.id) || Date.now() - (this.cached.get(peer.id)?.confirmedAt || 0) < 15_000) continue;
      void this.sync(peer.id).catch(() => undefined);
    }
  }
  private reachable(peer: Peer) { return peer.online && peer.channelReady && peer.trusted && this.transport.trusted(peer.id) && peer.capabilities.includes(collaborationCapability); }
  private save(id: string, value: Cached) {
    this.cached.set(id, value);
    this.db.prepare('INSERT INTO peers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(value));
    this.queryCache.clear(); this.changed();
  }
  revoke(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    this.cached.delete(id); this.db.prepare('DELETE FROM peers WHERE id=?').run(id); this.queryCache.clear();
    this.clearStage(id);
    this.changed();
  }
  localChanged() { this.queryCache.clear(); this.changed(); }
  private clearStage(id: string) {
    this.stages.delete(id);
    this.db.prepare('DELETE FROM stages WHERE id=?').run(id);
    this.db.prepare('DELETE FROM stage_entries WHERE peer=?').run(id);
  }
  handle(peer: string, operation: string, payload: unknown): unknown {
    if (!this.transport.trusted(peer)) throw new Error('untrusted_requester');
    if (operation === 'catalog-head') {
      if (!record(payload) || !keys(payload, [])) throw new Error('invalid_head_query');
      return this.catalog.head();
    }
    if (operation === 'catalog-page') {
      if (!record(payload) || !keys(payload, ['epoch', 'version', 'offset']) || !uuid(payload.epoch) ||
        !integer(payload.version, Number.MAX_SAFE_INTEGER) || !integer(payload.offset, 20_000)) throw new Error('invalid_page_query');
      return this.catalog.page(payload.epoch, payload.version, payload.offset);
    }
    if (operation === 'catalog-delta') {
      if (!record(payload) || !keys(payload, ['epoch', 'fromVersion']) || !uuid(payload.epoch) ||
        !integer(payload.fromVersion, Number.MAX_SAFE_INTEGER)) throw new Error('invalid_delta_query');
      return this.catalog.delta(payload.epoch, payload.fromVersion);
    }
    if (operation === 'resource-query' && validResourceQuery(payload)) return this.catalog.query(payload);
    throw new Error('unsupported_resource_query');
  }
  private async boundedRequest(id: string, operation: string, payload: unknown, deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || this.closed) throw new Error('query_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.transport.request(id, operation, payload), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('query_timeout')), remaining); timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async sync(id: string): Promise<void> {
    const pending = this.syncing.get(id); if (pending) return pending;
    if (this.closed || this.activeSyncs >= 2) return;
    this.activeSyncs++;
    const generation = this.generations.get(id) || 0;
    const current = () => !this.closed && (this.generations.get(id) || 0) === generation && this.transport.trusted(id);
    const operation = (async () => {
      const deadline = Date.now() + 15_000;
      const head = await this.boundedRequest(id, 'catalog-head', {}, deadline);
      if (!current() || !validCatalogHead(head) || head.nodeID !== id || Date.parse(head.checkedAt) > Date.now() + 5000) throw new Error('invalid_catalog_owner');
      const old = this.cached.get(id);
      if (old && old.head.epoch === head.epoch && head.version < old.head.version) throw new Error('stale_catalog_version');
      if (old && (old.head.workspaceID !== head.workspaceID || old.head.epoch !== head.epoch)) {
        this.cached.delete(id); this.db.prepare('DELETE FROM peers WHERE id=?').run(id); this.queryCache.clear();
      }
      if (old && old.head.epoch === head.epoch && old.head.version === head.version && old.head.workspaceID === head.workspaceID && old.entries.length === head.count) {
        this.save(id, { ...old, head, confirmedAt: Date.now() }); return;
      }
      if (old && old.head.epoch === head.epoch && old.head.workspaceID === head.workspaceID) {
        const delta = await this.boundedRequest(id, 'catalog-delta', { epoch: head.epoch, fromVersion: old.head.version }, deadline);
        if (!current()) return;
        if (delta !== null) {
          if (!validCatalogDelta(delta) || delta.head.nodeID !== id || delta.head.epoch !== head.epoch ||
            delta.head.version !== head.version || delta.fromVersion !== old.head.version) throw new Error('invalid_catalog_delta');
          const entries = new Map(old.entries.map((entry) => [entry.id, entry]));
          for (const key of delta.removed) entries.delete(key);
          for (const entry of delta.upsert) entries.set(entry.id, entry);
          if (entries.size !== head.count || !entriesMatchHead([...entries.values()], head)) throw new Error('incomplete_catalog_delta');
          this.save(id, { head, entries: [...entries.values()], confirmedAt: Date.now() }); return;
        }
      }
      let stage = this.stages.get(id);
      if (!stage || stage.head.epoch !== head.epoch || stage.head.version !== head.version || stage.head.workspaceID !== head.workspaceID || stage.head.count !== head.count) {
        this.clearStage(id); stage = { head, offset: 0 }; this.stages.set(id, stage);
      }
      let offset = stage.offset;
      let pages = 0;
      do {
        const page = await this.boundedRequest(id, 'catalog-page', { epoch: head.epoch, version: head.version, offset }, deadline);
        if (!current()) return;
        if (!validCatalogPage(page) || page.head.nodeID !== id || page.head.epoch !== head.epoch ||
          page.head.version !== head.version || page.head.count !== head.count || page.offset !== offset) throw new Error('invalid_catalog_page');
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const insert = this.db.prepare('INSERT INTO stage_entries VALUES (?,?,?)');
          for (const entry of page.entries) insert.run(id, entry.id, JSON.stringify(entry));
          offset = page.next ?? head.count;
          this.db.prepare('INSERT INTO stages VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify({ head, offset }));
          this.db.exec('COMMIT'); this.stages.set(id, { head, offset });
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        if (page.next === null) break;
        if (++pages >= this.pagesPerSync) { this.changed(); return; } // Reconcile resumes the durable cursor; tasks retain transport time.
      } while (offset < head.count);
      const entries = this.db.prepare('SELECT body FROM stage_entries WHERE peer=? ORDER BY id').all(id).map((row) => JSON.parse(String(row.body)) as ResourceEntry);
      if (entries.length !== head.count || !entriesMatchHead(entries, head)) throw new Error('incomplete_catalog');
      if (current()) { this.save(id, { head, entries, confirmedAt: Date.now() }); this.clearStage(id); }
    })().finally(() => { this.activeSyncs--; if (this.syncing.get(id) === operation) this.syncing.delete(id); });
    this.syncing.set(id, operation); return operation;
  }
  nodes(): ResourceDiscoveryNode[] {
    const own = this.catalog.head();
    return [{ nodeID: own.nodeID, name: this.transport.localName?.() || 'Local', online: true, head: own,
      status: own.state === 'ready' ? 'current' : 'unknown' }, ...this.transport.peers().filter((peer) => peer.trusted && this.transport.trusted(peer.id)).map((peer): ResourceDiscoveryNode => {
      const value = this.cached.get(peer.id);
      const staging = this.stages.get(peer.id);
      const status = !peer.capabilities.includes(collaborationCapability) ? 'unsupported' : !peer.online || !peer.channelReady ? 'offline' :
        !value ? 'unknown' : staging || Date.now() - value.confirmedAt > resourceFreshMilliseconds ||
          Date.now() - Date.parse(value.head.checkedAt) > resourceFreshMilliseconds || value.head.state !== 'ready' ? 'stale' : 'current';
      return { nodeID: peer.id, name: peer.name, online: peer.online && peer.channelReady,
        head: staging ? { ...staging.head, state: 'scanning' } : value?.head || null, status };
    })];
  }
  async query(query: ResourceQuery): Promise<ResourceDiscoveryResult> {
    if (!validResourceQuery(query)) throw new Error('invalid_resource_query');
    if (this.closed) throw new Error('resource_service_closed');
    const key = JSON.stringify([query, this.nodes().map((node) => [node.nodeID, node.name, node.status, node.head?.epoch, node.head?.version])]);
    const cached = this.queryCache.get(key); if (cached && cached.until > Date.now()) return structuredClone(cached.result);
    const pending = this.queries.get(key); if (pending) return structuredClone(await pending);
    if (this.queries.size >= 4) throw new Error('resource_query_busy');
    const operation = this.performQuery(query).then((result) => {
      this.queryCache.set(key, { until: Date.now() + 5000, result });
      if (this.queryCache.size > 32) this.queryCache.delete(this.queryCache.keys().next().value!);
      return result;
    }).finally(() => { this.queries.delete(key); });
    this.queries.set(key, operation); return structuredClone(await operation);
  }
  private async performQuery(query: ResourceQuery): Promise<ResourceDiscoveryResult> {
    const local = this.catalog.query(query);
    const results = new Map([[local.head.nodeID, local]]);
    const nodes = this.nodes();
    for (const node of nodes) {
      if (node.nodeID === local.head.nodeID) continue;
      const cached = this.cached.get(node.nodeID);
      if (cached) results.set(node.nodeID, searchResources(cached.head, cached.entries, query));
    }
    const found = [...results.values()].some((result) => result.entries.length || result.capabilities.length);
    const peers = this.transport.peers().filter((peer) => this.reachable(peer) &&
      (!found || nodes.find((node) => node.nodeID === peer.id)?.status !== 'current')).slice(0, 32);
    const deadline = Date.now() + 8000;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(peers.length, 3) }, async () => {
      while (index < peers.length && Date.now() < deadline) {
        const peer = peers[index++]; const generation = this.generations.get(peer.id) || 0;
        const node = nodes.find((node) => node.nodeID === peer.id)!;
        try {
          const response = await this.boundedRequest(peer.id, 'resource-query', query, deadline);
          if (!this.transport.trusted(peer.id) || generation !== (this.generations.get(peer.id) || 0)) { results.delete(peer.id); continue; }
          if (!validResourceQueryResult(response) || response.head.nodeID !== peer.id ||
            Date.parse(response.head.checkedAt) > Date.now() + 5000) throw new Error('invalid_query_result');
          const cached = this.cached.get(peer.id);
          if (cached && cached.head.epoch === response.head.epoch && cached.head.version > response.head.version) throw new Error('stale_query_result');
          results.set(peer.id, response); node.head = response.head;
          node.status = response.head.state === 'ready' && Date.now() - Date.parse(response.head.checkedAt) <= resourceFreshMilliseconds ? 'current' : 'stale';
        } catch { node.status = 'timeout'; }
      }
    }));
    for (; index < peers.length; index++) nodes.find((node) => node.nodeID === peers[index].id)!.status = 'timeout';
    const allowed = new Set([local.head.nodeID, ...this.transport.peers().filter((peer) => this.transport.trusted(peer.id)).map((peer) => peer.id)]);
    const safe = [...results.values()].filter((result) => allowed.has(result.head.nodeID));
    const entries = safe.flatMap((result) => result.entries);
    return { entries: entries.slice(0, query.limit), capabilities: safe.flatMap((result) => result.capabilities.map((cap) => ({ ...cap, nodeID: result.head.nodeID }))).slice(0, 40),
      nodes: nodes.filter((node) => allowed.has(node.nodeID)), partial: nodes.some((node) => node.status !== 'current'),
      more: entries.length > query.limit || safe.some((result) => result.more), queriedAt: new Date().toISOString() };
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    // In-flight replies are fenced by closed/current checks; shutdown need not wait for an offline peer.
    this.db.close();
  }
}
