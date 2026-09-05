import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProfileStore } from '../server/node-profile.ts';
import {
  validNodeProfile,
  validNodeRemark,
  maximumNodeIconLength,
} from '../shared/node-profile.ts';

test('profile saves persist independently, preserve only allowed fields and do not create identity or trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-profile-'));
  const profiles = new NodeProfileStore(root);
  const nodeID = 'a'.repeat(32);
  assert.equal(profiles.local(nodeID).icon, 'monitor');
  profiles.saveLocal({ name: ' 我的工作站 ', icon: 'laptop', trusted: true } as never);
  assert.deepEqual(new NodeProfileStore(root).local(nodeID), {
    name: '我的工作站',
    icon: 'laptop',
  });
  assert.deepEqual(readdirSync(root), ['node-profiles.json']);
  assert(!readFileSync(join(root, 'node-profiles.json'), 'utf8').includes('trusted'));
  profiles.remember('b'.repeat(32), 'fingerprint-one', { name: '另一台电脑', icon: 'terminal' });
  profiles.saveRemark(
    'b'.repeat(32),
    'fingerprint-one',
    { name: '另一台电脑', icon: 'terminal' },
    '设计组工作站',
  );
  profiles.markUsed(
    'b'.repeat(32),
    'fingerprint-one',
    { name: '另一台电脑', icon: 'terminal' },
    '2026-09-04T08:00:00.000Z',
  );
  profiles.remember('b'.repeat(32), 'fingerprint-one', {
    name: '设计工作站',
    icon: 'laptop',
  });
  const restarted = new NodeProfileStore(root);
  assert.deepEqual(restarted.peer('b'.repeat(32), 'fingerprint-one'), {
    name: '设计工作站',
    icon: 'laptop',
    fingerprint: 'fingerprint-one',
    remark: '设计组工作站',
    lastUsedAt: '2026-09-04T08:00:00.000Z',
  });
  assert.equal(restarted.peer('b'.repeat(32), 'fingerprint-two'), null);
});
test('invalid names, oversized images, external URLs and active image formats are rejected', () => {
  for (const name of ['', '  ', 'a'.repeat(81), 'hello\nworld'])
    assert.equal(validNodeProfile({ name, icon: 'bot' }), false);
  for (const icon of [
    'https://example.com/avatar.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'unknown',
    'data:image/png;base64,' + 'a'.repeat(maximumNodeIconLength),
  ])
    assert.equal(validNodeProfile({ name: 'Node', icon }), false);
  assert.equal(validNodeProfile({ name: 'Node', icon: 'data:image/webp;base64,AAAA' }), true);
  assert.equal(validNodeProfile({ name: 'Node', icon: 'spark' }), true);
  for (const remark of ['', '  ', 'a'.repeat(81), 'hello\nworld'])
    assert.equal(validNodeRemark(remark), false);
  assert.equal(validNodeRemark('设计组工作站'), true);
});
