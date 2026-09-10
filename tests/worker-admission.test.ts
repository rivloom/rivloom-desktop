import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionOccupancy, isRemoteExecution } from '../server/worker-admission.ts';
import { queueFixture, remoteSource } from './node-queue-fixture.ts';
import type { Task, RemoteTaskInvite } from '../shared/types.ts';

type Sample = Pick<Task, 'id' | 'state' | 'remoteOrigin'>;
const task = (id: string, state: Task['state'] = 'running'): Sample => ({ id, state });
test('source accounting deduplicates reservations and remote executions without charging local tasks', () => {
  const f = queueFixture();
  try {
    const local = Array.from({ length: 12 }, (_, i) => task(`local-${i}`));
    const remote = [task('remote-running'), task('remote-ready', 'ready'), task('remote-unknown', 'interrupted')];
    const rows = remote.map((t) => {
      const entry = f.store.enqueue(remoteSource());
      return { ...entry, localTaskID: t.id, state: 'admitted' as const };
    });
    const input = { tasks: [...local, ...remote], queue: rows, remotes: [], taskState: (id: string) => [...local, ...remote].find((t) => t.id === id)?.state };
    assert.deepEqual(executionOccupancy(input), { localOccupied: 12, localExecuting: 12, remoteOccupied: 3, remoteExecuting: 1 });
    assert(isRemoteExecution(remote[0]!, rows, []));
    assert(!isRemoteExecution(local[0]!, rows, []));
    assert.equal(executionOccupancy({ ...input, excludeTaskID: 'remote-running' }).remoteOccupied, 2);
    remote[1]!.state = 'accepted';
    assert.equal(executionOccupancy(input).remoteOccupied, 2, 'ended work is not counted again by its admitted queue row');
    const missing = { ...f.store.enqueue(remoteSource()), state: 'admitted' as const };
    assert.equal(executionOccupancy({ ...input, queue: [...rows, missing] }).remoteOccupied, 3);
    assert.equal(executionOccupancy({ ...input, queue: [...rows, missing], excludeQueueID: missing.id }).remoteOccupied, 2);
  } finally { f.close(); }
});
test('accepted unbound Brain executions reserve once and later task binding preserves remote provenance', () => {
  const f = queueFixture();
  try {
    const source = remoteSource();
    assert(source.kind === 'remote');
    const accepted = { id: source.remoteTaskID, direction: 'incoming', brainTaskID: 'brain-task', status: 'accepted', localTaskID: null, executionSequence: 0 } as RemoteTaskInvite;
    const input = { tasks: [] as Sample[], queue: [] as ReturnType<typeof f.store.list>, remotes: [accepted], taskState: () => undefined };
    assert.equal(executionOccupancy(input).remoteOccupied, 1);
    const queued = { ...f.store.enqueue(source), state: 'admitted' as const };
    assert.equal(executionOccupancy({ ...input, queue: [queued] }).remoteOccupied, 1);
    const bound = task('bound');
    const remote = { ...accepted, localTaskID: bound.id };
    assert(isRemoteExecution(bound, [], [remote]));
    assert.equal(executionOccupancy({ ...input, tasks: [bound], remotes: [remote] }).remoteOccupied, 1);
  } finally { f.close(); }
});
