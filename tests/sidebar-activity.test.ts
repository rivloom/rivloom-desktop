import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeModelActivitySnapshot } from '../shared/node-model-activity.ts';
import { activityFresh, activityRate, activityRateText, attentionAdded, knowledgeActivityVersion, modelActivityState, visibleModelRates } from '../src/sidebar-activity.ts';

const snapshot = (patch: Partial<NodeModelActivitySnapshot> = {}): NodeModelActivitySnapshot => ({
  sampledAt: 1000, inputWindowSeconds: 60, outputWindowSeconds: 3, inputComplete: true, outputComplete: true, countsComplete: true, limited: false,
  inputTokensPerSecond: 0, outputTokensPerSecond: 45,
  counts: { active: 3, generating: 2, tools: 1, waiting: 0, failed: 1 }, connections: [], ...patch,
});

test('missing, partial or stale observations cannot become apparently complete zeroes', () => {
  assert.deepEqual(visibleModelRates(null), { inputTokensPerSecond: null, outputTokensPerSecond: null });
  assert.deepEqual(visibleModelRates(snapshot({ inputComplete: false })), { inputTokensPerSecond: null, outputTokensPerSecond: 45 });
  assert.deepEqual(visibleModelRates(snapshot({ outputComplete: false })), { inputTokensPerSecond: 0, outputTokensPerSecond: null });
  assert.deepEqual(visibleModelRates(snapshot({ limited: true })), { inputTokensPerSecond: null, outputTokensPerSecond: null });
  for (const invalid of [NaN, Infinity, -1, null, undefined]) assert.equal(activityRate(invalid), null);
  assert.equal(activityRate(0), 0);
  assert.equal(activityFresh(1000, 5999, true, true), true);
  for (const [now, connected, visible] of [[6000, true, true], [500, true, true], [1000, false, true], [1000, true, false]] as const)
    assert.equal(activityFresh(1000, now, connected, visible), false);
});

test('model activity distinguishes empty, pending, unavailable and incomplete observations', () => {
  assert.equal(modelActivityState(null, true), 'loading');
  assert.equal(modelActivityState(null, false), 'unavailable');
  const idle = snapshot({ inputComplete: false, outputComplete: false, inputTokensPerSecond: null, outputTokensPerSecond: null,
    counts: { active: 0, generating: 0, tools: 0, waiting: 0, failed: 0 } });
  assert.equal(modelActivityState(idle, false), 'idle');
  assert.equal(modelActivityState({ ...idle, counts: { ...idle.counts, active: 1 } }, false), 'waiting');
  assert.equal(modelActivityState({ ...idle, countsComplete: false }, false), 'partial');
  assert.equal(modelActivityState(snapshot({ limited: true }), false), 'partial');
  assert.equal(modelActivityState(snapshot(), false), 'active');
  assert.equal(modelActivityState({ ...idle, outputComplete: true, outputTokensPerSecond: 2 }, false), 'recent');
  assert.equal(modelActivityState({ ...idle, outputComplete: true, outputTokensPerSecond: 0 }, false), 'idle');
});

test('the todo badge animates once on new items with a larger count, never on polling', () => {
  const a = [{ key: 'a' }], b = [{ key: 'a' }, { key: 'b' }];
  assert.equal(attentionAdded(null, b), false);
  assert.equal(attentionAdded(a, a), false);
  assert.equal(attentionAdded(a, b), true);
  assert.equal(attentionAdded(b, b.map(item => ({ ...item }))), false);
  assert.equal(attentionAdded(a, [{ key: 'b' }]), false);
  assert.equal(attentionAdded(b, a), false);
});

test('coalesced new knowledge failures have a new dismiss version', () => {
  const original = { id: 'one', updatedAt: 100, occurrences: 1 };
  assert.notEqual(knowledgeActivityVersion(original), knowledgeActivityVersion({ ...original, occurrences: 2 }));
  assert.notEqual(knowledgeActivityVersion(original), knowledgeActivityVersion({ ...original, updatedAt: 101 }));
  assert.equal(activityRateText(0), '0.0');
  assert.equal(activityRateText(1200), '1.2k');
});
