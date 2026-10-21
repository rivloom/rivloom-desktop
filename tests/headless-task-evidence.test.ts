import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { readTaskSessionEvidence, summarizeTaskContextEvidence } from '../scripts/headless-task-check.ts';
import { modelFixture } from '../scripts/m34-fixtures.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-task-evidence-'));
  const directory = join(root, 'engine', 'data', 'opencode');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'opencode.db');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT)');
  const message = (id: string, session: string, data: unknown) => database.prepare('INSERT INTO message VALUES(?,?,1,?)').run(id, session, JSON.stringify(data));
  const part = (id: string, session: string, data: unknown) => database.prepare('INSERT INTO part VALUES(?,?,1,?)').run(id, session, JSON.stringify(data));
  return { root, path, database, message, part, cleanup() {
    try { database.close(); } catch { /* Already closed before the read-only observation. */ }
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert(!lstatSync(root).isSymbolicLink()); rmSync(root, { recursive: true, force: true });
  } };
}

test('core session evidence reads only fixed metadata for the requested session and never changes the database', () => {
  const f = fixture(), secret = 'PRIVATE_TOKEN_PROVIDER_PATH';
  try {
    f.database.prepare('INSERT INTO session VALUES(?)').run(secret);
    f.message('u', secret, { role: 'user', text: secret });
    f.message('a', secret, { role: 'assistant', time: { completed: 1 }, error: { name: secret, message: secret } });
    f.message('b', secret, { role: 'assistant', time: {} });
    f.message('foreign', 'other-session', { role: 'assistant', time: { completed: 1 } });
    f.database.prepare('INSERT INTO message VALUES(?,?,1,?)').run('broken', secret, 'not-json-PRIVATE');
    f.part('t', secret, { type: 'text', text: secret });
    f.part('p', secret, { type: 'tool', state: { status: 'pending', input: { secret }, output: secret } });
    f.part('r', secret, { type: 'tool', state: { status: 'running' } });
    f.part('s', secret, { type: 'step-start' });
    f.part('foreign', 'other-session', { type: 'tool', state: { status: 'completed' } });
    f.database.close();
    const hash = () => createHash('sha256').update(readFileSync(f.path)).digest('hex');
    const before = hash(), result = readTaskSessionEvidence(f.root, secret);
    assert.deepEqual(result, { status: 'read', sessionPresent: true,
      messages: { sampled: 4, truncated: false, user: 1, assistant: 2, unknown: 1, assistantCompleted: 1, assistantError: 1 },
      parts: { sampled: 4, truncated: false, text: 1, reasoning: 0, tool: 2, stepStart: 1, stepFinish: 0,
        toolPending: 1, toolRunning: 1, toolCompleted: 0, toolError: 0 } });
    assert.equal(hash(), before);
    assert(!JSON.stringify(result).includes(secret));
    assert.equal(readTaskSessionEvidence(f.root, 'absent').sessionPresent, false);
  } finally { f.cleanup(); }
});

test('core observation bounds row samples and rejects invalid roots without creating databases', () => {
  const f = fixture();
  try {
    f.database.exec('BEGIN');
    for (let index = 0; index < 300; index++) {
      f.message(String(index), 's', { role: 'user' }); f.part(String(index), 's', { type: 'text' });
    }
    f.database.exec('COMMIT'); f.database.close();
    const result = readTaskSessionEvidence(f.root, 's');
    assert.equal(result.status, 'read');
    assert.equal(result.messages!.sampled, 256); assert.equal(result.messages!.truncated, true);
    assert.equal(result.parts!.sampled, 256); assert.equal(result.parts!.truncated, true);
    assert.deepEqual(readTaskSessionEvidence('relative', 's'), { status: 'rejected' });
    assert.deepEqual(readTaskSessionEvidence(f.root, null), { status: 'not-applicable' });
    assert.deepEqual(readTaskSessionEvidence(join(f.root, 'missing'), 's'), { status: 'unavailable' });
  } finally { f.cleanup(); }
});

test('context evidence selects the current run and exposes only bounded fixed enum counts', () => {
  const secret = 'PRIVATE_TOKEN_PROVIDER_PATH';
  const input = { records: [
    { sessionID: secret, runAfter: 1, observationCount: 99, observations: [] },
    { sessionID: 'other', runAfter: 2, observationCount: 99, observations: [] },
    { sessionID: secret, runAfter: 2, observationCount: 3, observations: [
      { kind: 'execution', system: 'matched', model: secret, agent: secret },
      { kind: 'execution', system: 'restored', messageID: secret },
      { kind: 'compaction', system: 'not_applicable', token: secret },
    ] },
  ] };
  const result = summarizeTaskContextEvidence(input, secret, 2);
  assert.deepEqual(result, { status: 'read', recordPresent: true, observationCount: 3, truncated: false,
    observations: { execution: 2, compaction: 1, matched: 1, restored: 1, mismatch: 0, notApplicable: 1 } });
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(summarizeTaskContextEvidence(input, secret, 3).recordPresent, false);
  const bounded = summarizeTaskContextEvidence({ records: [{ sessionID: 's', runAfter: 1, observationCount: 51,
    observations: Array.from({ length: 51 }, () => ({ kind: 'execution', system: 'mismatch' })) }] }, 's', 1);
  assert.equal(bounded.truncated, true); assert.equal(bounded.observations!.execution, 50);
  assert.deepEqual(summarizeTaskContextEvidence({ records: secret }, 's', 1), { status: 'invalid-response' });
});

test('model transport evidence distinguishes bare connections, incomplete bodies and unknown routes', async () => {
  const f = fixture(), model = await modelFixture();
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 2000;
    while (!condition()) { assert(Date.now() < end); await delay(5); }
  };
  let bare: ReturnType<typeof createConnection> | undefined;
  try {
    model.configure(f.root); model.release();
    const config = JSON.parse(readFileSync(join(f.root, 'engine/config/opencode/opencode.json'), 'utf8'));
    const base = new URL(config.provider.fixture.options.baseURL);
    bare = createConnection({ host: '127.0.0.1', port: Number(base.port) });
    await new Promise<void>((done, reject) => { bare!.once('connect', done); bare!.once('error', reject); });
    await waitFor(() => model.transport.connections === 1);
    assert.deepEqual(model.transport, { connections: 1, httpRequests: 0, bodyCompleted: 0, unknownRoute: 0 });
    bare.end();
    const response = new Promise<number>((done, reject) => {
      const child = request(new URL('/v1/chat/completions', base), { method: 'POST' }, incoming => {
        incoming.resume(); incoming.once('end', () => done(incoming.statusCode!));
      });
      child.once('error', reject); child.write('{');
      void (async () => {
        await waitFor(() => model.transport.httpRequests === 1);
        assert.equal(model.transport.bodyCompleted, 0); assert.equal(model.requests, 0);
        child.end('"model":"fixture","stream":false}');
      })().catch(reject);
    });
    assert.equal(await response, 200); assert.equal(model.requests, 1);
    assert.equal((await fetch(new URL('/PRIVATE_UNKNOWN_ROUTE', base))).status, 404);
    assert.deepEqual({ ...model.transport, connections: 0 }, { connections: 0, httpRequests: 2, bodyCompleted: 2, unknownRoute: 1 });
    const copy = model.transport; copy.httpRequests = 999;
    assert.equal(model.transport.httpRequests, 2);
  } finally { bare?.destroy(); await model.close(); f.cleanup(); }
});
