import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowContexts } from '../server/workflow-contexts.ts';
import type { WorkflowExecutionContext } from '../shared/workflows.ts';
import type { RemoteTaskInvite } from '../shared/types.ts';
import { validWorkflowOutcomeReply } from '../shared/workflow-channel.ts';

const A = 'A'.repeat(32); const B = 'B'.repeat(32);
test('remote execution metadata persists before offers, binds one owner and cannot retrofit or retarget execution', () => {
  const db = new DatabaseSync(':memory:'); const remotes = new Map<string, RemoteTaskInvite>();
  try {
    let store = new WorkflowContexts(db, () => B, (id) => remotes.get(id) || null);
    const context: WorkflowExecutionContext = { workflowID: randomUUID(), stepID: 'edit', attempt: 2, role: 'executor',
      target: { mode: 'locked', nodeID: B }, instructions: 'Edit the movie', evidence: '', priorContext: 'Script ready' };
    const payload = { executionID: randomUUID(), context, inputFiles: [] };
    const ack = store.receive(A, payload); assert.equal(remotes.size, 0);
    store = new WorkflowContexts(db, () => B, (id) => remotes.get(id) || null);
    assert.deepEqual(store.receive(A, payload), ack);
    assert.throws(() => store.receive(B, payload), /metadata_conflict/);
    assert.throws(() => store.receive(A, { ...payload, context: { ...context, instructions: 'different' } }), /metadata_conflict/);
    assert.throws(() => store.receive(A, { ...payload, executionID: randomUUID(), context: { ...context, target: { mode: 'locked', nodeID: A } } }), /locked_target/);
    const localTaskID = randomUUID();
    const remote = { id: payload.executionID, direction: 'incoming', ownerNodeID: A, targetNodeID: B, inputFiles: [] } as unknown as RemoteTaskInvite;
    remotes.set(remote.id, remote);
    assert.deepEqual(store.bind(remote, localTaskID), context);
    assert.throws(() => store.bind(remote, randomUUID()), /binding_conflict/);
    assert.throws(() => store.bind({ ...remote, ownerNodeID: B }, localTaskID), /binding_conflict/);
    assert.equal(store.owned(A, { executionID: payload.executionID, digest: ack.digest }).localTaskID, localTaskID);
    assert.throws(() => store.owned(B, { executionID: payload.executionID, digest: ack.digest }), /not_authorized/);
    assert.throws(() => store.owned(A, { executionID: payload.executionID, digest: '0'.repeat(64) }), /not_authorized/);
    const oldID = randomUUID(); remotes.set(oldID, { ...remote, id: oldID });
    assert.throws(() => store.receive(A, { ...payload, executionID: oldID }), /already_exists/);
  } finally { db.close(); }
});
test('remote completion replies require a bound session, generation and exact bounded file manifest', () => {
  const reply = { executionID: randomUUID(), digest: 'a'.repeat(64), sessionID: 'ses_fixture', attempt: 2, runAfter: 1700000000000,
    phase: 'completed', summary: 'done', error: null, outcome: { kind: 'completed', summary: 'done', files: [] }, outputFiles: [], safeToTransfer: true };
  assert(validWorkflowOutcomeReply(reply));
  assert(!validWorkflowOutcomeReply({ ...reply, sessionID: null }));
  assert(!validWorkflowOutcomeReply({ ...reply, runAfter: 0 }));
  assert(!validWorkflowOutcomeReply({ ...reply, attempt: 17 }));
  assert(!validWorkflowOutcomeReply({ ...reply, outputFiles: [{ name: '../secret' }] }));
  assert(!validWorkflowOutcomeReply({ ...reply, outcome: null }));
  assert(!validWorkflowOutcomeReply({ ...reply, rootToken: 'extra' }));
});
