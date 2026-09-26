import assert from 'node:assert/strict';
import test from 'node:test';
import { activeQueueCount, railExpanded, toggledRailPreference } from '../src/rail-visibility.ts';

test('idle rail stays collapsed until the queue has live work', () => {
  assert.equal(activeQueueCount(null), 0);
  assert.equal(activeQueueCount([{ state: 'ended' }, { state: 'ended' }]), 0);
  assert.equal(activeQueueCount([{ state: 'waiting' }, { state: 'admitted' }, { state: 'ended' }, { state: 'held' }]), 3);
  assert.equal(railExpanded(true, 'auto', 0), false);
  assert.equal(railExpanded(true, 'auto', 2), true);
});

test('explicit choices win over the automatic state', () => {
  assert.equal(railExpanded(true, 'open', 0), true);
  assert.equal(railExpanded(true, 'closed', 5), false);
  assert.equal(toggledRailPreference(true), 'closed');
  assert.equal(toggledRailPreference(false), 'open');
});

test('rail never shows when no paired machine can use it', () => {
  assert.equal(railExpanded(false, 'open', 3), false);
  assert.equal(railExpanded(false, 'auto', 3), false);
});
