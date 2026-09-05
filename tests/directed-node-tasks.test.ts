import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { CreationRequestStore } from '../server/creation-requests.ts';
import { RemoteTaskStore } from '../server/remote-tasks.ts';
import { BrainTaskStore } from '../server/brain-tasks.ts';

const owner = 'A'.repeat(32);
const target = 'B'.repeat(32);
const content = {
  title: '工作',
  description: '相同的一项工作',
  criteria: '检查结果',
  requirements: {},
};

test('HTTP creation retry preserves task ID across restart and rejects changed target/content', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-create-'));
  const path = join(root, 'requests.sqlite');
  const requestID = randomUUID();
  let db = new DatabaseSync(path);
  let requests = new CreationRequestStore(db);
  const logical = { routing: { kind: 'node', nodeID: target }, ...content };
  const taskID = requests.reserve(owner, requestID, logical);
  assert.equal(
    requests.reserve(owner, requestID, { ...content, routing: logical.routing }),
    taskID,
  );
  assert.throws(
    () => requests.reserve(owner, requestID, { ...logical, title: '另一项工作' }),
    /冲突/,
  );
  assert.throws(
    () => requests.reserve(owner, requestID, { ...logical, routing: { kind: 'local' } }),
    /冲突/,
  );
  db.close();
  db = new DatabaseSync(path);
  requests = new CreationRequestStore(db);
  assert.equal(requests.reserve(owner, requestID, logical), taskID);
  assert.notEqual(requests.reserve('other-actor', requestID, logical), taskID);
  db.close();
});

test('lost HTTP reply and ledger-to-invite crash recovery create exactly one stable invitation', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-directed-'));
  const db = new DatabaseSync(join(root, 'requests.sqlite'));
  const requests = new CreationRequestStore(db);
  const requestID = randomUUID();
  const brainID = randomUUID();
  const taskID = requests.reserve(owner, requestID, { nodeID: target, ...content });
  // Restart after intent persistence, before creating the offer.
  let invites = new RemoteTaskStore(root);
  invites.load();
  const first = invites.create(owner, brainID, target, brainID, content, taskID);
  // The invite was saved but the HTTP response never reached the caller.
  invites = new RemoteTaskStore(root);
  invites.load();
  const retryID = requests.reserve(owner, requestID, { nodeID: target, ...content });
  const retry = invites.create(owner, brainID, target, brainID, content, retryID);
  assert.equal(retry.id, first.id);
  assert.equal(invites.list().length, 1);
  assert.equal(invites.record(taskID)!.idempotencyKey, invites.record(retry.id)!.idempotencyKey);
  assert.throws(
    () => invites.create(owner, brainID, 'C'.repeat(32), brainID, content, taskID),
    /冲突/,
  );
  assert.throws(
    () => invites.create(owner, brainID, target, brainID, { ...content, title: '不同' }, taskID),
    /冲突/,
  );
  db.close();
});

test('automatic creation retry retains the original Brain and Task after placement changes', () => {
  const root = mkdtempSync(join(process.cwd(), '.data/verification/m35-brain-create-'));
  const brainID = randomUUID();
  const taskID = randomUUID();
  const input = { ...content, requestedProjectID: null };
  let tasks = new BrainTaskStore(root);
  tasks.load();
  const first = tasks.create('submitted', owner, brainID, target, input, taskID);
  tasks = new BrainTaskStore(root);
  tasks.load();
  assert.equal(tasks.create('submitted', owner, brainID, target, input, taskID).id, first.id);
  assert.equal(tasks.list().length, 1);
  assert.throws(
    () => tasks.create('submitted', owner, randomUUID(), target, input, taskID),
    /冲突/,
  );
});
