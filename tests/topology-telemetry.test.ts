import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeActivitySnapshot } from '../shared/node-activity.ts';
import type { RivloomNode } from '../shared/types.ts';
import { buildTopologyNodeTelemetry } from '../src/topology-telemetry.ts';

const sampledAt = '2026-11-24T10:00:00.000Z';
const now = Date.parse(sampledAt) + 4000;

function makeNode(overrides: Partial<RivloomNode> = {}): RivloomNode {
  return {
    id: 'B'.repeat(32),
    name: 'RenderNode',
    fingerprint: 'fp',
    protocolVersion: 1,
    addresses: ['192.168.1.20'],
    port: 4100,
    online: true,
    local: false,
    trusted: true,
    channelReady: true,
    verified: true,
    lastSeen: sampledAt,
    capabilities: [],
    brains: [],
    nodeQueue: {
      waitingCount: 2,
      paused: false,
      updatedAt: sampledAt,
      sampledAt,
      health: 'normal',
      workload: { occupiedSlots: 1, totalSlots: 4, executingCount: 1 },
    },
    worker: {
      nodeID: 'B'.repeat(32),
      accepting: true,
      projects: [],
      hardware: {
        platform: 'win32',
        release: '10.0',
        architecture: 'x64',
        cpuModel: 'Ryzen 9',
        physicalCores: 8,
        logicalCores: 16,
        memoryBytes: 32 * 1024 ** 3,
        gpus: [],
        diskBytes: null,
        collectedAt: sampledAt,
      },
      load: {
        cpuPercent: 42.4,
        memoryUsedPercent: 61.2,
        memoryAvailableBytes: 12 * 1024 ** 3,
        gpuPercent: null,
        gpuMemoryAvailableBytes: null,
        diskAvailableBytes: null,
        runningTasks: 1,
        availableSlots: 3,
        sampledAt,
      },
    },
    ...overrides,
  };
}

test('buildTopologyNodeTelemetry shows real CPU, memory, slots and local token rates accurately', () => {
  const localNode = makeNode({ id: 'L'.repeat(32), name: 'LocalHost', local: true });
  const activity: NodeActivitySnapshot = {
    models: {
      sampledAt: now - 500,
      inputWindowSeconds: 60,
      outputWindowSeconds: 3,
      inputComplete: true,
      outputComplete: true,
      countsComplete: true,
      limited: false,
      inputTokensPerSecond: 145.2,
      outputTokensPerSecond: 58.6,
      counts: { active: 1, generating: 1, tools: 0, waiting: 0, failed: 0 },
      connections: [],
    },
    knowledge: [],
  };

  const telemetry = buildTopologyNodeTelemetry({
    node: localNode,
    isLocal: true,
    now,
    connected: true,
    activitySnapshot: activity,
  });

  assert.equal(telemetry.cpuText, '42%');
  assert.equal(telemetry.coresText, '16 核');
  assert.equal(telemetry.memoryText, '61%');
  assert.equal(telemetry.memoryTotalText, '32.0 GiB');
  assert.equal(telemetry.localActivity?.outputText, '≈58.6 t/s');
  assert.equal(telemetry.localActivity?.inputText, '145 t/s');
  assert.equal(telemetry.tone, 'active');
  assert.equal(telemetry.svgLoadPercent, 42.4);
  assert.match(telemetry.svgMetricText, /≈58\.6t\/s/);
});

test('missing, stale, or incomplete telemetry renders — and never fabricates 0% or fake token rates', () => {
  const peer = makeNode();
  // Stale load (>30s old)
  const stale = buildTopologyNodeTelemetry({
    node: peer,
    isLocal: false,
    now: Date.parse(sampledAt) + 35_000,
    connected: true,
  });
  assert.equal(stale.cpuPercent, null);
  assert.equal(stale.cpuText, '—');
  assert.equal(stale.memoryText, '—');
  assert.equal(stale.slotsText, '—');
  assert.equal(stale.waitingText, '—');
  assert.equal(stale.svgLoadPercent, null);
  assert.equal(stale.svgMetricText, '—');
  assert.equal(stale.localActivity, null);

  // Local with unavailable / partial activity snapshot must show — for rates
  const localMissing = buildTopologyNodeTelemetry({
    node: makeNode({ local: true, worker: null, nodeQueue: null }),
    isLocal: true,
    now,
    connected: true,
    activitySnapshot: {
      models: {
        sampledAt: now,
        inputWindowSeconds: 60,
        outputWindowSeconds: 3,
        inputComplete: false,
        outputComplete: false,
        countsComplete: false,
        limited: true,
        inputTokensPerSecond: 100,
        outputTokensPerSecond: 50,
        counts: { active: 1, generating: 1, tools: 0, waiting: 0, failed: 0 },
        connections: [],
      },
      knowledge: [],
    },
  });
  assert.equal(localMissing.cpuText, '—');
  assert.equal(localMissing.localActivity?.outputRate, null);
  assert.equal(localMissing.localActivity?.outputText, '—');
  assert.equal(localMissing.localActivity?.inputText, '—');
  assert.equal(localMissing.svgLoadPercent, null);
  assert.equal(localMissing.svgMetricText, '—');
});

test('health anomalies and paused queues surface accurate tones without masking load data', () => {
  const congested = makeNode({
    nodeQueue: { waitingCount: 12, paused: false, updatedAt: sampledAt, sampledAt, health: 'congested' },
  });
  const viewCongested = buildTopologyNodeTelemetry({ node: congested, isLocal: false, now, connected: true });
  assert.equal(viewCongested.tone, 'warning');
  assert.equal(viewCongested.healthCode, 'congested');

  const paused = makeNode({
    nodeQueue: { waitingCount: 1, paused: true, updatedAt: sampledAt, sampledAt, health: 'normal' },
  });
  const viewPaused = buildTopologyNodeTelemetry({ node: paused, isLocal: false, now, connected: true });
  assert.equal(viewPaused.paused, true);
  assert.equal(viewPaused.tone, 'paused');
  assert.match(viewPaused.slotsText, /已暂停/);
});
