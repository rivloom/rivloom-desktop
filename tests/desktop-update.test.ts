import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPrepareUpdate, updateBlockers, UpdateMaintenance, type UpdateReadiness } from '../server/update-maintenance.ts';
import { shouldPromptForUpdate, updateDownloadPercent, updateIsBusy, type DesktopUpdateSnapshot } from '../shared/desktop-update.ts';
import { DatabaseSync } from 'node:sqlite';
import { assertReadableWorkspaceDatabase } from '../server/data-format.ts';

const idle = (): UpdateReadiness => ({ tasks: [], queues: [], workflows: [], remoteTasks: [], brainTasks: [], transfers: 0, operations: 0, modelChecks: 0 });

test('an incompatible future database is rejected before its format marker or content changes', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec("CREATE TABLE future_state(value TEXT); INSERT INTO future_state VALUES ('keep'); PRAGMA user_version=5;");
    assert.throws(() => assertReadableWorkspaceDatabase(database), /更高版本/);
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 5);
    assert.equal(database.prepare('SELECT value FROM future_state').get()?.value, 'keep');
    database.exec('PRAGMA user_version=3');
    assert.equal(assertReadableWorkspaceDatabase(database), 3);
  } finally { database.close(); }
});

test('updates preserve active, waiting, uncertain and independent collaborative work', () => {
  for (const state of ['running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted', 'review'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), tasks: [{ state }] })), false, state);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), tasks: [{ state: 'accepted' }, { state: 'failed' }, { state: 'stopped' }, { state: 'open' }] })), true);
  for (const state of ['waiting', 'held', 'admitted'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), queues: [{ state }] })), false, state);
  for (const state of ['planning', 'running', 'paused', 'stopping'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), workflows: [{ state }] })), false, state);
  for (const field of ['transfers', 'operations', 'modelChecks'] as const)
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), [field]: 1 })), false, field);
});

test('updates wait for remote controls, delivery acknowledgements and Brain results', () => {
  const done = { status: 'accepted' as const, executionState: 'accepted' as const, controlPending: false, deliveryPending: false };
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), remoteTasks: [done] })), true);
  for (const delta of [{ controlPending: true }, { deliveryPending: true }, { executionState: 'interrupted' as const }, { status: 'pending' as const }])
    assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), remoteTasks: [{ ...done, ...delta }] })), false);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), brainTasks: [{ status: 'completed', deliveryPending: true }] })), false);
  assert.equal(canPrepareUpdate(updateBlockers({ ...idle(), brainTasks: [{ status: 'queued', deliveryPending: false }] })), false);
});

test('maintenance atomically fences intake, tracks in-flight writes and recovers from a lost caller', () => {
  let clock = 1000;
  const gate = new UpdateMaintenance(() => clock);
  const finish = gate.enterOperation()!;
  assert.equal(gate.pending, 1);
  assert.equal(gate.acquire(), true);
  assert.equal(gate.acquire(), false);
  assert.equal(gate.enterOperation(), null);
  finish(); finish();
  assert.equal(gate.pending, 0);
  gate.release();
  const second = gate.enterOperation()!; second();
  assert.equal(gate.acquire(), true);
  clock += 120_001;
  assert.equal(gate.active, false);
  assert.equal(gate.acquire(), true);
  assert.equal(gate.commit(), true);
  assert.equal(gate.commit(), false);
  gate.release(); clock += 120_001;
  assert.equal(gate.active, true, 'A committed shutdown cannot be cancelled or expire');
  assert.equal(gate.enterOperation(), null);
});

const snapshot = (): DesktopUpdateSnapshot => ({ phase: 'available', currentVersion: '0.1.4', release: { version: '0.1.5', notes: '', publishedAt: null },
  skippedVersion: null, lastCheckedAt: null, downloadedBytes: 0, totalBytes: null, error: null, blockers: null, revision: 1 });

test('only the selected skipped version is quiet and progress cannot exceed its bounds', () => {
  const value = snapshot();
  assert.equal(shouldPromptForUpdate(value), true);
  value.skippedVersion = '0.1.5';
  assert.equal(shouldPromptForUpdate(value), false);
  value.release!.version = '0.1.6';
  assert.equal(shouldPromptForUpdate(value), true);
  value.phase = 'downloading';
  assert.equal(shouldPromptForUpdate(value), false);
  assert.equal(updateDownloadPercent(value), null);
  value.totalBytes = 100; value.downloadedBytes = 60;
  assert.equal(updateDownloadPercent(value), 60);
  value.downloadedBytes = 150;
  assert.equal(updateDownloadPercent(value), 100);
  assert.equal(updateIsBusy('ready'), false);
  assert.equal(updateIsBusy('preparing'), true);
});
