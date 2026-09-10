import { digest, integer, jsonBytes, keys, nodeID, record, text, timestamp, uniqueStrings, uuid } from './collaboration.ts';

export const resourcePageSize = 20;
export const resourceCatalogLimit = 20_000;
export const resourceFreshMilliseconds = 120_000;
export type ResourceKind = 'document' | 'image' | 'audio' | 'video' | 'code' | 'model' | 'file';
export type ResourceReference = { nodeID: string; workspaceID: string; id: string; revision: string };
export type ResourceEntry = ResourceReference & {
  name: string; relativePath: string; kind: ResourceKind; bytes: number; modifiedAt: string;
  tags: string[]; operations: ('fetch' | 'inspect')[];
};
export type SoftwareEvidence = {
  id: string; name: string; kind: 'software' | 'model'; status: 'available' | 'unavailable' | 'unknown';
  version: string | null; checkedAt: string;
};
export type CatalogHead = {
  nodeID: string; epoch: string; version: number; workspaceID: string | null; workspaceName: string | null;
  state: 'unconfigured' | 'scanning' | 'ready' | 'partial' | 'error';
  count: number; checkedAt: string; error: string | null; capabilities: SoftwareEvidence[];
};
export type CatalogPage = { head: CatalogHead; offset: number; entries: ResourceEntry[]; next: number | null };
export type CatalogDelta = {
  head: CatalogHead; fromVersion: number; upsert: ResourceEntry[]; removed: string[];
};
export type ResourceQuery = { text: string; kinds: ResourceKind[]; limit: number };
export type ResourceQueryResult = {
  head: CatalogHead; entries: ResourceEntry[]; capabilities: SoftwareEvidence[]; more: boolean;
};
export type ResourceDiscoveryNode = {
  head: CatalogHead | null; nodeID: string; name: string; online: boolean;
  status: 'current' | 'stale' | 'offline' | 'unsupported' | 'unknown' | 'timeout';
};
export type ResourceDiscoveryResult = {
  entries: ResourceEntry[]; capabilities: (SoftwareEvidence & { nodeID: string })[];
  nodes: ResourceDiscoveryNode[]; partial: boolean; more: boolean; queriedAt: string;
};
const kinds: ResourceKind[] = ['document', 'image', 'audio', 'video', 'code', 'model', 'file'];
export function safeRelativeResourcePath(value: unknown): value is string {
  return text(value, 512) && !/[\\:\u0000-\u001f]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..');
}
export function validResourceReference(value: unknown): value is ResourceReference {
  return record(value) && keys(value, ['nodeID', 'workspaceID', 'id', 'revision']) &&
    nodeID(value.nodeID) && uuid(value.workspaceID) && digest(value.id) && digest(value.revision);
}
export function validResourceEntry(value: unknown): value is ResourceEntry {
  if (!record(value) || !keys(value, ['nodeID', 'workspaceID', 'id', 'revision', 'name',
    'relativePath', 'kind', 'bytes', 'modifiedAt', 'tags', 'operations'])) return false;
  return nodeID(value.nodeID) && uuid(value.workspaceID) && digest(value.id) && digest(value.revision) &&
    text(value.name, 255) && safeRelativeResourcePath(value.relativePath) &&
    value.name === value.relativePath.split('/').at(-1) && kinds.includes(value.kind as ResourceKind) &&
    integer(value.bytes, Number.MAX_SAFE_INTEGER) && timestamp(value.modifiedAt) &&
    uniqueStrings(value.tags, 8, 40) && uniqueStrings(value.operations, 2, 7) &&
    value.operations.every((op) => op === 'fetch' || op === 'inspect') && jsonBytes(value) <= 2048;
}
export function validSoftwareEvidence(value: unknown): value is SoftwareEvidence {
  return record(value) && keys(value, ['id', 'name', 'kind', 'status', 'version', 'checkedAt']) &&
    text(value.id, 200) && text(value.name, 120) && ['software', 'model'].includes(String(value.kind)) &&
    ['available', 'unavailable', 'unknown'].includes(String(value.status)) &&
    (value.version === null || text(value.version, 160)) && timestamp(value.checkedAt);
}
export function validCatalogHead(value: unknown): value is CatalogHead {
  return record(value) && keys(value, ['nodeID', 'epoch', 'version', 'workspaceID', 'workspaceName',
    'state', 'count', 'checkedAt', 'error', 'capabilities']) &&
    nodeID(value.nodeID) && uuid(value.epoch) && integer(value.version, Number.MAX_SAFE_INTEGER) &&
    (value.workspaceID === null ? value.workspaceName === null && value.count === 0 && value.state === 'unconfigured' :
      uuid(value.workspaceID) && text(value.workspaceName, 200) && value.state !== 'unconfigured') &&
    ['unconfigured', 'scanning', 'ready', 'partial', 'error'].includes(String(value.state)) &&
    integer(value.count, resourceCatalogLimit) && timestamp(value.checkedAt) &&
    (value.error === null || text(value.error, 300)) && Array.isArray(value.capabilities) &&
    value.capabilities.length <= 40 && value.capabilities.every(validSoftwareEvidence) && jsonBytes(value) <= 12_000;
}
export function entriesMatchHead(entries: ResourceEntry[], head: CatalogHead) {
  return entries.every((entry) => entry.nodeID === head.nodeID && entry.workspaceID === head.workspaceID) &&
    new Set(entries.map((entry) => entry.id)).size === entries.length;
}
export function validCatalogPage(value: unknown): value is CatalogPage {
  if (!record(value) || !keys(value, ['head', 'offset', 'entries', 'next']) || !validCatalogHead(value.head) ||
    !integer(value.offset, value.head.count) || !Array.isArray(value.entries) || value.entries.length > resourcePageSize ||
    !value.entries.every(validResourceEntry) || !entriesMatchHead(value.entries, value.head)) return false;
  const end = value.offset + value.entries.length;
  return end <= value.head.count && (end === value.head.count ? value.next === null :
    value.entries.length > 0 && value.next === end);
}
export function validCatalogDelta(value: unknown): value is CatalogDelta {
  return record(value) && keys(value, ['head', 'fromVersion', 'upsert', 'removed']) && validCatalogHead(value.head) &&
    integer(value.fromVersion, value.head.version) && Array.isArray(value.upsert) && value.upsert.length <= resourcePageSize &&
    value.upsert.every(validResourceEntry) && entriesMatchHead(value.upsert, value.head) &&
    uniqueStrings(value.removed, resourcePageSize, 64) && value.removed.every(digest) &&
    !value.upsert.some((entry) => (value.removed as string[]).includes(entry.id));
}
export function validResourceQuery(value: unknown): value is ResourceQuery {
  return record(value) && keys(value, ['text', 'kinds', 'limit']) && text(value.text, 200, 0) &&
    uniqueStrings(value.kinds, kinds.length, 10) && value.kinds.every((kind) => kinds.includes(kind as ResourceKind)) &&
    integer(value.limit, resourcePageSize, 1);
}
export function validResourceQueryResult(value: unknown): value is ResourceQueryResult {
  return record(value) && keys(value, ['head', 'entries', 'capabilities', 'more']) && validCatalogHead(value.head) &&
    Array.isArray(value.entries) && value.entries.length <= resourcePageSize && value.entries.every(validResourceEntry) &&
    entriesMatchHead(value.entries, value.head) && Array.isArray(value.capabilities) && value.capabilities.length <= 40 &&
    value.capabilities.every(validSoftwareEvidence) && typeof value.more === 'boolean' && jsonBytes(value) <= 60 * 1024;
}
export function searchResources(head: CatalogHead, entries: ResourceEntry[], query: ResourceQuery): ResourceQueryResult {
  const words = query.text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = entries.filter((entry) => (!query.kinds.length || query.kinds.includes(entry.kind)) &&
    words.every((word) => `${entry.relativePath} ${entry.tags.join(' ')}`.toLocaleLowerCase().includes(word)));
  const result = { head, entries: found.slice(0, query.limit), more: found.length > query.limit,
    capabilities: head.capabilities.filter((cap) => words.every((word) => `${cap.id} ${cap.name}`.toLocaleLowerCase().includes(word))) };
  while (jsonBytes(result) > 60 * 1024 && result.entries.length) { result.entries.pop(); result.more = true; }
  return result;
}
