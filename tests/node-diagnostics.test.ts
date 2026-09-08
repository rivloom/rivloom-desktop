import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseLocal, diagnosePeer, diagnosticSummary } from '../shared/node-diagnostics.ts';
import type { Bootstrap, RivloomNode, WorkerRegistration } from '../shared/types.ts';
const now = Date.parse('2026-09-06T08:00:00Z');
const peer = (extra: Partial<RivloomNode> = {}) =>
  ({
    id: 'peer',
    name: 'private-name',
    trusted: true,
    verified: true,
    online: true,
    channelReady: true,
    protocolVersion: 1,
    lastSeen: new Date(now).toISOString(),
    capabilities: ['task-files-v1'],
    worker: {
      accepting: true,
      load: { sampledAt: new Date(now).toISOString(), availableSlots: 0 },
    } as WorkerRegistration,
    ...extra,
  }) as RivloomNode;
test('diagnostics do not mistake saved pairing time or an old report for live contact and capacity', () => {
  const value = diagnosePeer(peer({ online: false, verified: false, channelReady: false }), now);
  assert.equal(value.lastContactAt, null);
  assert.equal(value.checks.find((c) => c.code === 'execution')?.state, 'unknown');
  assert.equal(value.checks.find((c) => c.code === 'trust')?.state, 'ok');
  const stale = peer();
  stale.worker!.load.sampledAt = new Date(now - 21_000).toISOString();
  assert.equal(
    diagnosePeer(stale, now).checks.find((c) => c.code === 'execution')?.state,
    'unknown',
  );
});
test('a busy but available executor stays healthy and missing queue capability remains unknown', () => {
  const value = diagnosePeer(peer(), now);
  assert.equal(value.checks.find((c) => c.code === 'execution')?.state, 'ok');
  assert.match(value.checks.find((c) => c.code === 'execution')!.detail, /原 Node 排队/);
  assert.equal(value.checks.find((c) => c.code === 'queue')?.state, 'unknown');
});
test('protocol, pairing, channel and file compatibility have distinct diagnoses', () => {
  const value = diagnosePeer(
    peer({ protocolVersion: 2, trusted: false, channelReady: false, capabilities: [] }),
    now,
  );
  for (const code of ['protocol', 'trust', 'channel'])
    assert.equal(value.checks.find((c) => c.code === code)?.state, 'blocked');
  assert.equal(
    diagnosePeer(peer({ capabilities: [] }), now).checks.find((c) => c.code === 'files')?.state,
    'warning',
  );
});
test('local readiness points to the missing model and explains the separate receiving policy', () => {
  const data = {
    network: { status: 'online', local: { id: 'local', name: 'Node' } },
    engine: { ready: true, models: [] },
    defaultModel: '',
    executionPolicy: { enabled: false, model: null, projectID: null },
    projects: [],
  } as unknown as Bootstrap;
  const value = diagnoseLocal(data);
  assert.equal(value.checks.find((c) => c.code === 'model')?.action, 'models');
  assert.equal(value.checks.find((c) => c.code === 'execution')?.state, 'warning');
  assert.equal(
    diagnoseLocal(data, false).checks.find((c) => c.code === 'backend')?.state,
    'blocked',
  );
});
test('copied diagnostic summary excludes identity, network paths and task contents', () => {
  const text = diagnosticSummary(
    diagnosePeer(
      peer({
        id: 'secret-node',
        name: 'private-name',
        addresses: ['192.168.1.9'],
        fingerprint: 'private-fingerprint',
      }),
      now,
    ),
    new Date(now).toISOString(),
  );
  for (const secret of ['secret-node', 'private-name', '192.168.1.9', 'private-fingerprint'])
    assert(!text.includes(secret));
});
