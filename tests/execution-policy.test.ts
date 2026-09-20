import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionPolicyStore } from '../server/execution-policy.ts';
import { validRemoteConcurrency } from '../shared/execution-concurrency.ts';

const fixture = () => {
  mkdirSync('.data/verification', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.data/verification/concurrency-policy-'));
  return { root, path: join(root, 'execution-policy.json'), store: new ExecutionPolicyStore(root) };
};

test('node thinking defaults persist without affecting admitted work or surviving a model change', () => {
  const f = fixture();
  const input = { enabled: true, projectID: '2e54f03f-4346-4dca-814c-c09ec34e9551', model: 'provider/model', approvalMode: 'ask' as const };
  const admitted = f.store.save({ ...input, reasoningEffort: 'high' });
  assert.equal(new ExecutionPolicyStore(f.root).load().reasoningEffort, 'high');
  assert.equal(f.store.saveConcurrency(4).reasoningEffort, 'high');
  assert.equal(f.store.save(input).reasoningEffort, 'high', 'Older callers retain an unchanged model policy');
  assert.equal(f.store.save({ ...input, reasoningEffort: null }).reasoningEffort, null);
  assert.equal(admitted.reasoningEffort, 'high', 'Previously admitted task configuration remains a snapshot');
  f.store.save({ ...input, reasoningEffort: 'high' });
  assert.equal(f.store.save({ ...input, model: 'other/model' }).reasoningEffort, null);
  const before = readFileSync(f.path, 'utf8');
  assert.throws(() => f.store.save({ ...input, reasoningEffort: 'not a level' }));
  assert.equal(readFileSync(f.path, 'utf8'), before);
});
test('remote concurrency defaults to three, validates integer bounds and persists without enabling execution', () => {
  const f = fixture();
  assert.equal(f.store.load().maxConcurrent, 3);
  const before = f.store.snapshot();
  for (const value of [1, 10, 3]) {
    assert(validRemoteConcurrency(value));
    assert.equal(f.store.saveConcurrency(value).maxConcurrent, value);
    assert.deepEqual(f.store.snapshot(), { ...before, maxConcurrent: value, updatedAt: f.store.snapshot().updatedAt });
    assert.equal(new ExecutionPolicyStore(f.root).load().maxConcurrent, value);
  }
  for (const value of [0, 11, 1.5, NaN, null, undefined, '3', false]) {
    assert(!validRemoteConcurrency(value));
    assert.throws(() => f.store.saveConcurrency(value as unknown as number));
  }
});
test('v2 fixed single slot migrates to three while preserving execution permission, project and model', () => {
  const f = fixture();
  const policy = { enabled: true, approvalMode: 'full', projectID: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', model: 'fixture/model', maxConcurrent: 1, updatedAt: null };
  writeFileSync(f.path, JSON.stringify({ version: 2, policy }));
  assert.deepEqual(f.store.load(), { ...policy, maxConcurrent: 3 });
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).version, 3);
  f.store.saveConcurrency(8);
  const { maxConcurrent: _, updatedAt: __, ...basic } = f.store.snapshot();
  assert.equal(f.store.save(basic).maxConcurrent, 8, 'older settings forms preserve the new concurrency');
});
test('failed persistence leaves effective concurrency and permissions unchanged', () => {
  const f = fixture();
  f.store.saveConcurrency(4);
  const previous = f.store.snapshot();
  renameSync(f.path, `${f.path}.saved`);
  mkdirSync(f.path);
  assert.throws(() => f.store.saveConcurrency(7));
  assert.deepEqual(f.store.snapshot(), previous);
  assert.throws(() => f.store.save({ enabled: false, approvalMode: 'auto', projectID: null, model: null, maxConcurrent: 9 }));
  assert.deepEqual(f.store.snapshot(), previous);
});
