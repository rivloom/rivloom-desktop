import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForServiceExit, type ServiceExitProof, type ServiceProcess } from '../scripts/service-exit-proof.ts';

const processRow = { pid: 100, parentPid: 50, created: '638900000000000001' };
const proof: ServiceExitProof = { serviceURL: 'http://127.0.0.1:20001', engineURL: 'http://127.0.0.1:20002', processes: [processRow] };
const stopped = () => ({ exitCode: 0, signalCode: null });
function clock() {
  let elapsed = 0;
  return { now: () => elapsed, wait: async (milliseconds: number) => { elapsed += milliseconds; } };
}

test('fixture database barrier waits for the Runtime tree after its service and listeners exit', async () => {
  const time = clock(); let observations = 0;
  const result = await waitForServiceExit(proof, stopped, { ...time, listening: async () => false,
    snapshot: async () => ++observations < 3 ? [processRow] : [] });
  assert.equal(observations, 3); assert.equal(result.durationMs, 200); assert.equal(result.treeExited, true);
});

test('fixture database barrier still waits for the recorded Runtime listener', async () => {
  const time = clock();
  const result = await waitForServiceExit(proof, stopped, { ...time,
    listening: async url => url === proof.engineURL && time.now() < 200, snapshot: async () => [] });
  assert.equal(result.durationMs, 200);
});

test('fixture database barrier rejects a Runtime tree that does not exit within its deadline', async () => {
  const time = clock();
  await assert.rejects(waitForServiceExit(proof, stopped, { ...time, timeoutMs: 250,
    listening: async () => false, snapshot: async () => [processRow] }), /deadline/);
  assert.equal(time.now(), 250);
});

test('fixture database barrier rejects nonzero and signalled service exits without querying', async () => {
  for (const status of [{ exitCode: 1, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' as const }]) {
    let queried = false;
    await assert.rejects(waitForServiceExit(proof, () => status, { listening: async () => { queried = true; return false; } }),
      /shutdown failed|ended by a signal/);
    assert.equal(queried, false);
  }
});

test('fixture database barrier rejects late snapshots and does not retry failed process queries', async () => {
  const time = clock();
  await assert.rejects(waitForServiceExit(proof, stopped, { ...time, timeoutMs: 100, listening: async () => false,
    snapshot: async () => { await time.wait(100); return []; } }), /deadline/);
  let queries = 0;
  await assert.rejects(waitForServiceExit(proof, stopped, { ...clock(), listening: async () => false,
    snapshot: async (): Promise<ServiceProcess[]> => { queries++; throw new Error('inventory unavailable'); } }), /inventory unavailable/);
  assert.equal(queries, 1);
});
