import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeHealthMonitor } from '../server/node-health.ts';
import { queueFixture, localSource } from './node-queue-fixture.ts';

test('full slot, pause and a single resource spike still accept directed work', () => {
  const f = queueFixture();
  try {
    f.store.enqueue(localSource());
    const monitor = new NodeHealthMonitor({ clock: () => f.now });
    monitor.observeResource({
      sampledAt: new Date(f.now).toISOString(),
      cpuPercent: 100,
      gpuPercent: null,
    });
    const input = {
      queue: f.store.snapshot(),
      availableSlots: 0,
      executionPaused: false,
      lastDispatchProgressAt: null,
    };
    assert.equal(monitor.assess(input).state, 'normal');
    assert.equal(monitor.assess({ ...input, executionPaused: true }).accepting, true);
    f.advance(600_000);
    assert.equal(monitor.assess(input).state, 'unknown');
    assert.equal(monitor.assess(input).accepting, true);
  } finally {
    f.close();
  }
});

test('continuous fresh anomaly warns but never silently rejects; stale or missing metrics are unknown', () => {
  const f = queueFixture();
  try {
    const monitor = new NodeHealthMonitor({
      clock: () => f.now,
      thresholds: { sustainedLoadMilliseconds: 30_000, maximumSampleGapMilliseconds: 10_000 },
    });
    const input = {
      queue: f.store.snapshot(),
      availableSlots: 1,
      executionPaused: false,
      lastDispatchProgressAt: null,
    };
    assert.equal(monitor.assess(input).state, 'unknown');
    for (let i = 0; i < 4; i++) {
      monitor.observeResource({
        sampledAt: new Date(f.now).toISOString(),
        cpuPercent: 99,
        gpuPercent: null,
      });
      if (i < 3) f.advance(10_000);
    }
    assert.equal(monitor.assess(input).state, 'resource_anomaly');
    assert.equal(monitor.assess(input).accepting, true);
    f.advance(21_000);
    assert.equal(monitor.assess(input).state, 'unknown');
    monitor.observeResource({
      sampledAt: new Date(f.now).toISOString(),
      cpuPercent: null,
      gpuPercent: null,
    });
    assert.equal(monitor.assess(input).state, 'unknown');
  } finally {
    f.close();
  }
});

test('stall excludes paused, busy, model-blocked and manual-wait work; heartbeat is not progress', () => {
  const f = queueFixture();
  try {
    const entry = f.store.enqueue(localSource());
    const monitor = new NodeHealthMonitor({
      clock: () => f.now,
      thresholds: { stalledMilliseconds: 1000 },
    });
    f.advance(2000);
    monitor.observeResource({
      sampledAt: new Date(f.now).toISOString(),
      cpuPercent: 2,
      gpuPercent: null,
    });
    const assess = (availableSlots: number, executionPaused = false) =>
      monitor.assess({
        queue: f.store.snapshot(),
        availableSlots,
        executionPaused,
        lastDispatchProgressAt: null,
      });
    assert.equal(assess(1).state, 'stalled');
    assert.equal(assess(0).state, 'normal');
    assert.equal(assess(1, true).state, 'normal');
    f.store.setBlockReason(entry.id, { code: 'model_unavailable' });
    assert.equal(assess(1).state, 'normal');
    f.store.setBlockReason(entry.id, { code: 'queue' });
    assert.equal(assess(1).state, 'stalled');
  } finally {
    f.close();
  }
});

test('congestion needs actual count and age; only explicit capacity/receiving policy rejects', () => {
  const f = queueFixture();
  try {
    const monitor = new NodeHealthMonitor({
      clock: () => f.now,
      thresholds: {
        congestionWaiting: 2,
        congestionAgeMilliseconds: 1000,
        maximumWaiting: 3,
      },
    });
    f.store.enqueue(localSource());
    f.store.enqueue(localSource());
    const assess = () =>
      monitor.assess({
        queue: f.store.snapshot(),
        availableSlots: 0,
        executionPaused: false,
        lastDispatchProgressAt: null,
      });
    assert.notEqual(assess().state, 'congested');
    f.advance(1001);
    assert.equal(assess().state, 'congested');
    assert.equal(assess().accepting, true);
    f.store.enqueue(localSource());
    assert.equal(assess().reason, 'capacity_reached');
    assert.equal(assess().accepting, false);
  } finally {
    f.close();
  }
});
