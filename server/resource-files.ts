import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { integer, keys, record, uuid } from '../shared/collaboration.ts';
import { validResourceReference, type ResourceReference } from '../shared/resources.ts';
import { taskFileChunkBytes, taskFileMime, validTaskFileDescriptor, sameTaskFile, type TaskFileDescriptor } from '../shared/task-files.ts';
import type { ResourceCatalog } from './resource-catalog.ts';
import type { ResourceTransport } from './resource-network.ts';
import type { TaskFileStore } from './task-files.ts';

type Grant = {
  key: string; peer: string; workflowID: string; reference: ResourceReference;
  state: 'preparing' | 'ready' | 'failed'; file: TaskFileDescriptor | null; error: string | null;
  bytes: number;
};
type PrepareResponse = { state: Grant['state']; file: TaskFileDescriptor | null; error: string | null };
function stableFileID(key: string) {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Only versioned, explicitly discoverable files can become task-scoped material. No path-based export API. */
export class ResourceFiles {
  private db: DatabaseSync;
  private catalog: ResourceCatalog;
  private files: TaskFileStore;
  private transport: ResourceTransport;
  private jobs = new Map<string, Promise<void>>();
  private fetching = new Map<string, Promise<TaskFileDescriptor>>();
  private closed = false;
  constructor(root: string, catalog: ResourceCatalog, files: TaskFileStore, transport: ResourceTransport) {
    this.catalog = catalog; this.files = files; this.transport = transport;
    mkdirSync(root, { recursive: true }); this.db = new DatabaseSync(join(root, 'resource-transfers.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS grants (key TEXT PRIMARY KEY, peer TEXT NOT NULL, workflow_id TEXT NOT NULL, body TEXT NOT NULL)');
  }
  private key(peer: string, workflowID: string, reference: ResourceReference) {
    return [peer, workflowID, reference.nodeID, reference.workspaceID, reference.id, reference.revision].join(':');
  }
  private read(key: string): Grant | null {
    const row = this.db.prepare('SELECT body FROM grants WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private save(value: Grant) {
    this.db.prepare('INSERT INTO grants VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(value.key, value.peer, value.workflowID, JSON.stringify(value));
  }
  private allowed(peer: string, reference: ResourceReference) {
    return !this.closed && (peer === this.catalog.head().nodeID || this.transport.trusted(peer)) &&
      this.catalog.head().workspaceID === reference.workspaceID && this.catalog.head().nodeID === reference.nodeID &&
      !!this.catalog.entry(reference)?.operations.includes('fetch');
  }
  handle(peer: string, operation: string, payload: unknown): unknown {
    if (!record(payload) || !keys(payload, ['workflowID', 'reference'], operation === 'resource-chunk' ? ['offset'] : []) ||
      !uuid(payload.workflowID) || !validResourceReference(payload.reference) || !this.allowed(peer, payload.reference)) throw new Error('resource_not_authorized');
    const workflowID = payload.workflowID; const reference = payload.reference;
    const key = this.key(peer, workflowID, reference);
    let grant = this.read(key);
    if (operation === 'resource-prepare') {
      if (!grant) {
        const bytes = this.catalog.entry(reference)!.bytes;
        const previous = this.db.prepare('SELECT body FROM grants WHERE peer=? AND workflow_id=?').all(peer, workflowID);
        if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM grants WHERE peer=? AND workflow_id=?').get(peer, workflowID)!.count) >= 10 ||
          previous.reduce((sum, row) => sum + (JSON.parse(String(row.body)) as Grant).bytes, 0) + bytes > 1000 * 1024 * 1024 ||
          Number(this.db.prepare('SELECT COUNT(*) AS count FROM grants').get()!.count) >= 4096) throw new Error('resource_transfer_quota');
        grant = { key, peer, workflowID, reference, bytes, state: 'preparing', file: null, error: null }; this.save(grant);
      }
      if (grant.state === 'preparing' && !this.jobs.has(key)) {
        if (this.jobs.size >= 2) return { state: 'preparing', file: null, error: null };
        const job = this.prepare(grant).finally(() => { this.jobs.delete(key); }); this.jobs.set(key, job);
      }
      return { state: grant.state, file: grant.file, error: grant.error } satisfies PrepareResponse;
    }
    if (operation !== 'resource-chunk' || !grant || grant.state !== 'ready' || !grant.file ||
      !integer(payload.offset, grant.file.bytes - 1)) throw new Error('resource_chunk_unavailable');
    return { fileID: grant.file.id, offset: payload.offset, data: this.files.readChunk(grant.file.id, payload.offset) };
  }
  private async prepare(grant: Grant) {
    let opened: Awaited<ReturnType<ResourceCatalog['openResource']>> | null = null;
    try {
      opened = await this.catalog.openResource(grant.reference);
      const { handle, entry } = opened;
      const buffer = Buffer.alloc(taskFileChunkBytes);
      const hash = createHash('sha256');
      for (let position = 0; position < entry.bytes;) {
        if (!this.allowed(grant.peer, grant.reference)) throw new Error('resource_revoked');
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, entry.bytes - position), position);
        if (!bytesRead) throw new Error('resource_changed');
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        await yieldLoop();
      }
      await opened.verify();
      const file = { id: stableFileID(grant.key), name: entry.name, bytes: entry.bytes, sha256: hash.digest('hex'), mime: taskFileMime(entry.name) };
      if (!validTaskFileDescriptor(file)) throw new Error('invalid_resource_file');
      const origin = `resource-export:${grant.peer}:${grant.workflowID}`;
      let view = this.files.beginUpload(origin, file);
      while (view.receivedBytes < file.bytes) {
        if (!this.allowed(grant.peer, grant.reference)) throw new Error('resource_revoked');
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.bytes - view.receivedBytes), view.receivedBytes);
        if (!bytesRead) throw new Error('resource_changed');
        view = this.files.uploadChunk(origin, file.id, view.receivedBytes, buffer.subarray(0, bytesRead).toString('base64'));
        await yieldLoop();
      }
      await opened.verify();
      if (!this.allowed(grant.peer, grant.reference)) throw new Error('resource_revoked');
      this.save({ ...grant, state: 'ready', file, error: null });
    } catch {
      if (!this.closed) this.save({ ...grant, state: 'failed', error: 'Resource changed or could not be prepared. Select its current version.', file: null });
    } finally { await opened?.handle.close(); }
  }
  /** The workflow coordinator is the only caller; regular lookup never invokes this method. */
  async fetch(workflowID: string, reference: ResourceReference): Promise<TaskFileDescriptor> {
    if (!uuid(workflowID) || !validResourceReference(reference) || this.closed) throw new Error('invalid_resource_material_request');
    const key = this.key(this.catalog.head().nodeID, workflowID, reference);
    const previous = this.fetching.get(key); if (previous) return previous;
    const operation = this.fetchMaterial(workflowID, reference).finally(() => { this.fetching.delete(key); });
    this.fetching.set(key, operation); return operation;
  }
  private async fetchMaterial(workflowID: string, reference: ResourceReference) {
    const local = reference.nodeID === this.catalog.head().nodeID;
    const ownNodeID = this.catalog.head().nodeID;
    const request = (operation: string, payload: unknown) => local ? Promise.resolve(this.handle(ownNodeID, operation, payload)) :
      this.transport.request(reference.nodeID, operation, payload);
    const deadline = Date.now() + 10 * 60_000;
    let file: TaskFileDescriptor | null = null;
    while (!this.closed && Date.now() < deadline) {
      if (!local && !this.transport.trusted(reference.nodeID)) throw new Error('resource_revoked');
      const response = await request('resource-prepare', { workflowID, reference });
      if (!record(response) || !keys(response, ['state', 'file', 'error']) || !['ready', 'preparing', 'failed'].includes(String(response.state))) throw new Error('invalid_resource_prepare_reply');
      if (response.state === 'failed') throw new Error('resource_prepare_failed');
      if (response.state === 'ready') {
        if (!validTaskFileDescriptor(response.file)) throw new Error('invalid_resource_file');
        file = response.file; break;
      }
      await delay(100);
    }
    if (!file || this.closed) throw new Error('resource_prepare_timeout');
    if (local) return file;
    const origin = `resource-import:${reference.nodeID}:${workflowID}`;
    let view = this.files.beginUpload(origin, file);
    if (!sameTaskFile(view, file)) throw new Error('resource_identity_changed');
    while (view.state !== 'complete' && !this.closed && Date.now() < deadline) {
      if (!this.transport.trusted(reference.nodeID)) throw new Error('resource_revoked');
      const response = await request('resource-chunk', { workflowID, reference, offset: view.receivedBytes });
      if (this.closed) throw new Error('resource_service_closed');
      if (!record(response) || !keys(response, ['fileID', 'offset', 'data']) || response.fileID !== file.id ||
        response.offset !== view.receivedBytes || typeof response.data !== 'string' || response.data.length > 44_000) throw new Error('invalid_resource_chunk');
      view = this.files.uploadChunk(origin, file.id, view.receivedBytes, response.data);
      await yieldLoop();
    }
    if (view.state !== 'complete') throw new Error('resource_transfer_incomplete');
    return file;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.jobs.values()); this.db.close();
  }
}
