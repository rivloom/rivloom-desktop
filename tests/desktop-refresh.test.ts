import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reuseJson, createRefreshQueue } from '../src/desktop-refresh.ts';

test('equal JSON snapshots retain every reference without mutating either input', () => {
  const previous = {
    tasks: [{ id: 'one', version: 1, messages: [{ text: '原正文 ✅' }] }],
    policy: { enabled: false },
    empty: null,
  };
  const incoming = structuredClone(previous);
  const pristine = structuredClone(incoming);
  const result = reuseJson(previous, incoming);
  assert.equal(result, previous);
  assert.deepEqual(incoming, pristine);
  assert.notEqual(incoming.tasks, previous.tasks);
});

test('network-only changes retain task messages and permissions but publish new presence', () => {
  const previous = {
    tasks: [
      {
        id: 'one',
        messages: [{ text: 'keep' }],
        approvals: [{ id: 'approval', permission: 'read' }],
      },
    ],
    network: { peer: { online: true, sampledAt: 'one' } },
  };
  const incoming = structuredClone(previous);
  incoming.network.peer.sampledAt = 'two';
  const result = reuseJson(previous, incoming);
  assert.notEqual(result, previous);
  assert.equal(result.tasks, previous.tasks);
  assert.equal(result.tasks[0].messages, previous.tasks[0].messages);
  assert.equal(result.network.peer.sampledAt, 'two');
  assert.equal(previous.network.peer.sampledAt, 'one');
  assert.notEqual(incoming.tasks, previous.tasks);
});

test('messages, approvals, queue ordering and removed fields cannot be hidden by an unchanged version', () => {
  const previous = {
    version: 7,
    messages: [{ text: 'before' }],
    approvals: ['one'],
    queue: ['first', 'second'],
    error: 'old',
  };
  const incoming = {
    version: 7,
    messages: [{ text: 'after' }],
    approvals: [],
    queue: ['second', 'first'],
  };
  const result = reuseJson(previous, incoming);
  assert.deepEqual(result, incoming);
  assert.notEqual(result.messages, previous.messages);
  assert(!Object.hasOwn(result, 'error'));
  assert.deepEqual(previous.approvals, ['one']);
  assert.equal(reuseJson(null, incoming), incoming);
  assert.equal(reuseJson(['a'], { '0': 'a' })['0'], 'a');
});

test('snapshot reuse treats own __proto__ keys as data', () => {
  const previous = JSON.parse('{"__proto__":{"flag":false},"stable":{"text":"keep"}}');
  const incoming = JSON.parse('{"__proto__":{"flag":true},"stable":{"text":"keep"}}');
  const result = reuseJson(previous, incoming);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.__proto__.flag, true);
  assert.equal(result.stable, previous.stable);
  assert.equal(({} as Record<string, unknown>).flag, undefined);
});

test('a full refresh queued during a network request is not dropped or downgraded', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((ok) => {
    release = ok;
  });
  const queue = createRefreshQueue(async (scope) => {
    calls.push(scope);
    if (calls.length === 1) await blocked;
  });
  const first = queue('network');
  await Promise.resolve();
  const second = queue('full');
  queue('network');
  assert.equal(first, second);
  release();
  await second;
  assert.deepEqual(calls, ['network', 'full']);
  await queue('network');
  assert.deepEqual(calls, ['network', 'full', 'network']);
});

test('refresh serialization recovers after a rejected request', async () => {
  let calls = 0;
  const queue = createRefreshQueue(async () => {
    if (++calls === 1) throw new Error('offline');
  });
  await assert.rejects(queue('full'), /offline/);
  await queue('full');
  assert.equal(calls, 2);
});
