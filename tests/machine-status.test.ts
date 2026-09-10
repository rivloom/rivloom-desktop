import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RivloomNode, RemoteTaskInvite } from '../shared/types.ts';
import type { Conversation } from '../src/conversations.ts';
import { machineStatus, groupMachines, machineConversations } from '../src/machine-status.ts';

const at = '2026-09-08T12:00:00.000Z',
  now = Date.parse(at);
function peer(): RivloomNode {
  return {
    id: 'A'.repeat(32),
    name: 'Example',
    fingerprint: '',
    protocolVersion: 1,
    addresses: [],
    port: 1,
    online: true,
    local: false,
    trusted: true,
    channelReady: true,
    verified: true,
    lastSeen: at,
    capabilities: [],
    brains: [],
    nodeQueue: {
      waitingCount: 3,
      paused: false,
      updatedAt: at,
      sampledAt: at,
      health: 'normal',
      workload: { occupiedSlots: 1, totalSlots: 1, executingCount: 0 },
    },
    worker: {
      nodeID: 'A'.repeat(32),
      projects: [],
      accepting: true,
      hardware: {
        platform: 'win32',
        release: 'test',
        architecture: 'x64',
        cpuModel: 'Test CPU',
        physicalCores: 8,
        logicalCores: 16,
        memoryBytes: 32 * 1024 ** 3,
        gpus: [],
        diskBytes: null,
        collectedAt: at,
      },
      load: {
        cpuPercent: 23,
        memoryUsedPercent: 62,
        gpuPercent: null,
        memoryAvailableBytes: 16 * 1024 ** 3,
        gpuMemoryAvailableBytes: null,
        diskAvailableBytes: null,
        runningTasks: 1,
        availableSlots: 0,
        sampledAt: at,
      },
    },
  };
}

test('machine capacity separates occupied reservations from actual execution and preserves over-capacity counts', () => {
  const node = peer(),
    held = machineStatus(node, now);
  assert.equal(held.fill, 100);
  assert.equal(held.executing, 0);
  assert.equal(held.queueThreshold, 10);
  assert.equal(held.queueCount, node.nodeQueue!.waitingCount + 1);
  assert.equal(held.label, '等待继续');
  node.nodeQueue!.workload = { occupiedSlots: 2, totalSlots: 1, executingCount: 1 };
  const running = machineStatus(node, now);
  assert.equal(running.occupied, 2);
  assert.equal(running.fill, 100);
  assert.equal(running.label, '执行中 1');
  node.nodeQueue!.waitingCount = 14;
  assert.equal(machineStatus(node, now).queueCount, 16);
  assert.equal(machineStatus(node, now).queueFill, 100);
  node.nodeQueue!.workload = { occupiedSlots: 0, totalSlots: 0, executingCount: 0 };
  assert.equal(machineStatus(node, now).fill, null);
});

test('origin split shows local unlimited and configured incoming limit independently of busy counts', () => {
  const node = peer();
  node.nodeQueue!.concurrency = { localOccupied: 12, localExecuting: 11, remoteOccupied: 3, remoteExecuting: 3, remoteLimit: 1 };
  const view = machineStatus(node, now);
  assert.equal(view.occupied, 15);
  assert.equal(view.executing, 14);
  assert.equal(view.total, null);
  assert.equal(view.fill, null);
  assert.equal(view.concurrency?.remoteLimit, 1);
  assert.equal(view.queueCount, 18);
  assert.equal(machineStatus(node, now + 31_000).concurrency, null);
});

test('legacy machine reports never mislabel occupied slots as running or paused capacity as total', () => {
  const node = peer();
  delete node.nodeQueue!.workload;
  const legacy = machineStatus(node, now);
  assert.equal(legacy.occupied, 1);
  assert.equal(legacy.total, 1);
  assert.equal(legacy.executing, null);
  assert.equal(legacy.label, '已占用 1');
  node.worker!.accepting = false;
  const paused = machineStatus(node, now);
  assert.equal(paused.total, null);
  assert.equal(paused.fill, null);
  node.nodeQueue!.workload = { occupiedSlots: 1, totalSlots: 4, executingCount: 0 };
  assert.equal(machineStatus(node, now).fill, 25);
});

test('hardware bottleneck excludes unavailable metrics and all stale or unreachable telemetry stays unknown', () => {
  const node = peer();
  const view = machineStatus(node, now);
  assert.equal(view.hardware, 62);
  assert.equal(view.partial, true);
  assert.equal(view.gpu, null);
  node.worker!.load.gpuPercent = 97;
  assert.equal(machineStatus(node, now).hardware, 97);
  node.worker!.load.cpuPercent = NaN;
  node.worker!.load.memoryUsedPercent = -1;
  node.worker!.load.gpuPercent = null;
  assert.equal(machineStatus(node, now).hardware, null);
  for (const view of [
    machineStatus(peer(), now + 30_000),
    machineStatus(peer(), now - 1001),
    machineStatus(peer(), now, false),
    machineStatus({ ...peer(), online: false }, now),
    machineStatus({ ...peer(), channelReady: false }, now),
  ]) {
    assert.equal(view.occupied, null);
    assert.equal(view.fill, null);
    assert.equal(view.executing, null);
    assert.equal(view.hardware, null);
    assert.equal(view.waiting, null);
    assert.equal(view.queueCount, null);
  }
  const staleQueue = peer();
  staleQueue.nodeQueue!.sampledAt = new Date(now - 30_000).toISOString();
  assert.equal(machineStatus(staleQueue, now).executing, null);
  assert.equal(machineStatus(staleQueue, now).hardware, 62);
});

test('machine grouping requires a ready channel and related titles follow the current target only', () => {
  const online = peer(),
    offline = { ...peer(), id: 'offline', online: false },
    pending = { ...peer(), id: 'pending', channelReady: false };
  assert.deepEqual(groupMachines([offline, online, pending]), {
    connected: [online],
    offline: [offline, pending],
  });
  const item = (key: string, target: string, status = 'running'): Conversation => ({
    key,
    title: key,
    description: '',
    updatedAt: at,
    createdAt: at,
    sourceNodeID: online.id,
    incoming: false,
    attempts: [],
    remote: {
      targetNodeID: target,
      status: 'accepted',
      executionState: status,
    } as RemoteTaskInvite,
  });
  const current = item('current', online.id);
  const fromPeer = item('source-only', 'local');
  fromPeer.attempts = [current.remote!];
  assert.deepEqual(
    machineConversations(online.id, [current, fromPeer, item('done', online.id, 'accepted')]),
    [current],
  );
});
