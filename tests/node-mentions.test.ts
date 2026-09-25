import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RivloomNode } from '../shared/types.ts';
import {
  activeNodeMention,
  isNodeMentionComposing,
  nodeCapabilitySummary,
  nodeDisplayName,
  recentNodeMentions,
  boundNodeMentionMode,
  replaceBoundNodeMention,
} from '../src/node-mentions.ts';

const node = (id: string, extra: Partial<RivloomNode> = {}) =>
  ({
    id: id.repeat(32),
    name: `Node ${id}`,
    fingerprint: id,
    protocolVersion: 1,
    addresses: [],
    port: 0,
    online: true,
    local: false,
    trusted: true,
    channelReady: true,
    verified: true,
    lastSeen: '2026-09-04T08:00:00.000Z',
    capabilities: [],
    brains: [],
    worker: null,
    ...extra,
  }) as RivloomNode;

test('@ detects only the active node query at the caret', () => {
  assert.deepEqual(activeNodeMention('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(activeNodeMention('交给 @设计', 6), { start: 3, end: 6, query: '设计' });
  assert.equal(activeNodeMention('mail@example.com', 16), null);
  assert.equal(activeNodeMention('@设计 后续内容', 8), null);
  assert.equal(activeNodeMention('上一行 @设计\n下一行', 11), null);
});

test('preferred and locked mentions preserve exact names, ignore code and follow manual mode edits', () => {
  const name = 'Studio [B].1';
  assert.equal(activeNodeMention('@@Studio', 8)?.mode, 'locked');
  assert.equal(activeNodeMention('`@@Studio', 9), null);
  assert.equal(activeNodeMention('```\n@@Studio', 12), null);
  assert.equal(activeNodeMention('email@@Studio', 13), null);
  assert.equal(boundNodeMentionMode(`@@${name} edit`, name), 'locked');
  assert.equal(boundNodeMentionMode(`@${name} edit`, name), 'preferred');
  assert.equal(boundNodeMentionMode(`\`@@${name}\``, name), null);
  assert.equal(boundNodeMentionMode(`@${name}2 edit`, name), null);
  assert.equal(replaceBoundNodeMention(`@${name} edit`, name, 'locked'), `@@${name} edit`);
  assert.equal(replaceBoundNodeMention(`@@${name} edit`, name, null), ' edit');
});

test('toolbar selection updates an existing bound mention without inserting text into an ordinary draft', () => {
  const name = 'Studio [B].1';
  assert.equal(replaceBoundNodeMention('整理这份附件。', name, 'preferred', '新设备'), '整理这份附件。');
  assert.equal(replaceBoundNodeMention(`@${name} 整理这份附件。`, name, 'locked', '新设备'), '@@新设备 整理这份附件。');
  assert.equal(replaceBoundNodeMention(`@${name}2 keep`, name, 'locked', '新设备'), `@${name}2 keep`);
});

test('busy mentions remain selectable and use only fresh Node queue counts', () => {
  const at = '2026-09-05T08:00:00.000Z';
  const peer = node('a', {
    worker: {
      nodeID: 'a'.repeat(32),
      projects: [],
      accepting: true,
      hardware: {
        platform: 'win32',
        release: 'test',
        architecture: 'x64',
        physicalCores: 8,
        logicalCores: 16,
        cpuModel: 'Test CPU',
        memoryBytes: 32 * 1024 ** 3,
        diskBytes: null,
        collectedAt: at,
        gpus: [],
      },
      load: {
        availableSlots: 0,
        sampledAt: at,
        cpuPercent: 100,
        gpuPercent: null,
        memoryAvailableBytes: 16 * 1024 ** 3,
        memoryUsedPercent: 50,
        gpuMemoryAvailableBytes: null,
        diskAvailableBytes: null,
        runningTasks: 1,
      },
    },
    nodeQueue: { waitingCount: 7, paused: false, updatedAt: at, sampledAt: at, health: 'normal' },
  });
  const view = nodeCapabilitySummary(peer, Date.parse(at) + 1000);
  assert.equal(view.status, '忙碌 · 可排队');
  assert.equal(view.waiting, 7);
  assert.equal(view.slots, 0);
  assert.match(view.summary, /GPU 未提供/);
  assert.equal(recentNodeMentions([peer])[0].id, peer.id);
  const stale = nodeCapabilitySummary(peer, Date.parse(at) + 31_000);
  assert.equal(stale.waiting, null);
  assert.equal(stale.slots, null);
  assert.match(stale.summary, /未知/);
  assert.equal(nodeCapabilitySummary(peer, Date.parse(at), false).waiting, null);
  assert.match(
    nodeCapabilitySummary({ ...peer, nodeQueue: undefined }, Date.parse(at)).detail,
    /对端未提供队列信息/,
  );
});

test('mention list uses recent order and searches original and local remark names', () => {
  const first = node('a', {
    name: '设计工作站',
    remark: '小林的电脑',
    lastUsedAt: '2026-09-04T08:00:00.000Z',
  });
  const second = node('b', {
    name: '测试节点',
    remark: '实验室',
    lastUsedAt: '2026-09-04T09:00:00.000Z',
  });
  assert.deepEqual(
    recentNodeMentions([first, second]).map((item) => item.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    recentNodeMentions([first, second], '小林').map((item) => item.id),
    [first.id],
  );
  assert.equal(nodeDisplayName(first), '设计工作站（小林的电脑）');
});

test('space names and caret movement retain the active query without parsing routing', () => {
  const peers = [node('a', { name: 'Node West', remark: '设计 工位' })];
  assert.deepEqual(activeNodeMention('@Node W', 7, peers), { start: 0, end: 7, query: 'Node W' });
  assert.deepEqual(activeNodeMention('交给 @设计 工', 8, peers), {
    start: 3,
    end: 8,
    query: '设计 工',
  });
  assert.equal(activeNodeMention('@Node West 后续内容', 15, peers), null);
  assert.deepEqual(activeNodeMention('@Node West 后续内容', 7, peers), {
    start: 0,
    end: 7,
    query: 'Node W',
  });
  assert.equal(activeNodeMention('@Node West ', 11, peers), null);
  assert.equal(activeNodeMention('mail@Node West', 14, peers), null);
});

test('Chinese IME Enter is reserved for composition before either selection or submission', () => {
  assert.equal(isNodeMentionComposing({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isNodeMentionComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isNodeMentionComposing({ isComposing: false, keyCode: 13 }, true), true);
  assert.equal(isNodeMentionComposing({ isComposing: false, keyCode: 13 }), false);
});
