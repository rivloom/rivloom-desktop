import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validResourceEntry, validCatalogPage, validCatalogDelta, validResourceQuery, safeRelativeResourcePath,
  type CatalogHead, type ResourceEntry } from '../shared/resources.ts';
import { validCollaborationRequest, validCollaborationResponse } from '../shared/collaboration.ts';

export function resourceFixture() {
  const head: CatalogHead = { nodeID: 'A'.repeat(32), epoch: randomUUID(), version: 2, workspaceID: randomUUID(),
    workspaceName: 'Media', state: 'ready', count: 1, checkedAt: new Date().toISOString(), error: null, capabilities: [] };
  const entry: ResourceEntry = { nodeID: head.nodeID, workspaceID: head.workspaceID!, id: 'a'.repeat(64), revision: 'b'.repeat(64),
    name: 'abc.md', relativePath: 'docs/abc.md', kind: 'document', bytes: 4, modifiedAt: head.checkedAt, tags: ['md'], operations: ['fetch', 'inspect'] };
  return { head, entry };
}
test('resource metadata rejects traversal, absolute paths, hidden payloads and crossed owners', () => {
  const { head, entry } = resourceFixture();
  assert(validResourceEntry(entry));
  for (const path of ['../x', '/x', 'a//x', 'a/../x', 'C:/x', 'a\\x', './x', 'a/\u0000x']) assert(!safeRelativeResourcePath(path), path);
  for (const invalid of [{ ...entry, absolutePath: 'C:/private' }, { ...entry, bytes: -1 }, { ...entry, revision: '../x' },
    { ...entry, name: 'different' }, { ...entry, operations: ['execute'] }]) assert(!validResourceEntry(invalid));
  const page = { head, offset: 0, entries: [entry], next: null };
  assert(validCatalogPage(page));
  assert(!validCatalogPage({ ...page, entries: [{ ...entry, nodeID: 'B'.repeat(32) }] }));
  assert(!validCatalogPage({ ...page, entries: [{ ...entry, workspaceID: randomUUID() }] }));
  assert(!validCatalogPage({ ...page, next: 1 }));
  assert(!validCatalogPage({ ...page, offset: 1 }));
  assert(!validCatalogPage({ ...page, entries: [] }));
});
test('resource deltas and query protocol stay bounded and require complete exact envelopes', () => {
  const { head, entry } = resourceFixture();
  const delta = { head, fromVersion: 1, upsert: [entry], removed: [] };
  assert(validCatalogDelta(delta));
  assert(!validCatalogDelta({ ...delta, fromVersion: 3 }));
  assert(!validCatalogDelta({ ...delta, removed: [entry.id] }));
  assert(validResourceQuery({ text: 'abc', kinds: ['document'], limit: 10 }));
  assert(!validResourceQuery({ text: 'abc', kinds: [], limit: 5000 }));
  const req = { type: 'collaboration-request', requestID: randomUUID(), operation: 'resource-query', payload: {} };
  assert(validCollaborationRequest(req));
  assert(!validCollaborationRequest({ ...req, operation: 'shell' }));
  assert(!validCollaborationRequest({ ...req, ownerNodeID: 'B'.repeat(32) }));
  assert(!validCollaborationResponse({ type: 'collaboration-response', requestID: req.requestID, ok: false, payload: {}, error: 'failure' }));
});
