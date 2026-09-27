import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { installNodeActivityAPI } from '../server/node-activity-api.ts';
import { OperationActivityRegistry } from '../server/operation-activity.ts';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';
import type { User } from '../shared/types.ts';

function snapshot(): NodeActivitySnapshot {
  return { models: { sampledAt: Date.now(), inputWindowSeconds: 60, outputWindowSeconds: 3,
    inputTokensPerSecond: null, outputTokensPerSecond: null, inputComplete: false, outputComplete: false, countsComplete: true, limited: false,
    counts: { active: 0, generating: 0, tools: 0, waiting: 0, failed: 0 }, connections: [] }, knowledge: [] };
}
async function fixture(read: () => NodeActivitySnapshot, dismiss: (id: string) => boolean) {
  const app = express(); app.use(express.json());
  installNodeActivityAPI(app, (req) => ({ owner: req.get('x-test-owner') === 'yes' } as User), read, dismiss);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/node-activity`;
  return { url, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
const post = (body: unknown, owner = true): RequestInit => ({ method: 'POST', headers: {
  'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': 'yes' } : {}) }, body: JSON.stringify(body) });

test('Node activity is owner-only and never invokes data or dismissal callbacks for participants', async () => {
  let read = 0; let dismissed = 0;
  const f = await fixture(() => { read++; return snapshot(); }, () => { dismissed++; return true; });
  try {
    for (const response of [await fetch(f.url), await fetch(`${f.url}/knowledge/dismiss`, post({ id: randomUUID() }, false))]) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'node_activity_owner_only' });
    }
    assert.equal(read, 0); assert.equal(dismissed, 0);
    const response = await fetch(f.url, { headers: { 'x-test-owner': 'yes' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).knowledge, []); assert.equal(read, 1);
  } finally { await f.close(); }
});

test('dismiss validates an exact UUID body, clears only terminal records and is idempotent', async () => {
  const activity = new OperationActivityRegistry();
  activity.begin('read').finish({ status: 'failed', error: 'knowledge_source_unavailable' });
  const failure = activity.snapshot()[0];
  const running = activity.begin('refresh');
  const runningID = activity.snapshot().find((item) => item.status === 'running')!.id;
  let calls = 0;
  const f = await fixture(() => ({ ...snapshot(), knowledge: activity.snapshot() }), (id) => { calls++; return activity.dismiss(id); });
  try {
    for (const body of [{}, { id: null }, { id: 1 }, { id: '../secret' }, { id: 'x'.repeat(200) }, { id: failure.id, all: true }, []]) {
      const response = await fetch(`${f.url}/knowledge/dismiss`, post(body));
      assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'node_activity_invalid_request' });
    }
    assert.equal(calls, 0);
    for (const [id, dismissed] of [[runningID, false], [failure.id, true], [failure.id, false]] as const) {
      const response = await fetch(`${f.url}/knowledge/dismiss`, post({ id }));
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { dismissed });
    }
    assert.equal(activity.snapshot().length, 1);
    assert.equal(activity.snapshot()[0].status, 'running');
  } finally { running.finish(); await f.close(); }
});

test('activity read and dismissal failures use fixed safe errors without exposing callback details', async () => {
  const fail = () => { throw new Error('private-token-and-path'); };
  const f = await fixture(fail, fail);
  try {
    for (const response of [await fetch(f.url, { headers: { 'x-test-owner': 'yes' } }),
      await fetch(`${f.url}/knowledge/dismiss`, post({ id: randomUUID() }))]) {
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'node_activity_unavailable' });
    }
  } finally { await f.close(); }
});
