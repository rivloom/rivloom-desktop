// Isolated complete services and official OpenCode; every model response stays on loopback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { setTimeout as wait } from 'node:timers/promises';
import { modelFixture, ServiceClient, pairServices, until } from './m34-fixtures.ts';
import type { Task, NodeNetwork } from '../shared/types.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';

const root = resolve('.data', 'origin-concurrency', String(Date.now())); mkdirSync(root, { recursive: true });
const assertions: string[] = [];
const pass = (message: string) => { assertions.push(message); console.log('PASS', message); };
const entered = new Map<string, { at: number; releasedAt?: number }>();
const release = new Map<string, () => void>();
const fixture = await modelFixture(600_000, async (input) => {
  const content = (role: string) => (input.messages || []).filter((m: any) => m.role === role).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const label = /CONCURRENCY_(?:LOCAL|REMOTE)_\d+/.exec(content('user'))?.[0];
  if (label && content('system').includes('The current task uses permission mode')) {
    const interval = { at: Date.now(), releasedAt: undefined as number | undefined }; entered.set(label, interval);
    await new Promise<void>((ok) => release.set(label, ok)); interval.releasedAt = Date.now(); release.delete(label);
  }
  return { content: 'Verified concurrency fixture completion.' };
});
fixture.release();
const clients = [new ServiceClient(join(root, 'sender')), new ServiceClient(join(root, 'receiver'))];
const [sender, receiver] = clients;
const socket = createSocket('udp4'); await new Promise<void>((ok) => socket.bind(0, '127.0.0.1', ok));
const discovery = { port: socket.address().port, mdns: false }; await new Promise<void>((ok) => socket.close(() => ok()));
let status = 'failed', failure = '';
try {
  for (const client of clients) { fixture.configure(client.root); loadNodeIdentity(client.root); }
  await Promise.all(clients.map((client, i) => client.start({ discovery, logPath: join(root, `service-${i}.log`) })));
  const initial = await receiver.bootstrap(); assert.equal(initial.executionPolicy.maxConcurrent, 3);
  for (const value of [1, 10, 3]) {
    const saved = await receiver.call('/network/execution-concurrency', { maxConcurrent: value });
    assert.deepEqual(saved, { ...initial.executionPolicy, maxConcurrent: value, updatedAt: saved.updatedAt });
  }
  for (const value of [0, 11, 1.5, false, null, '3']) await receiver.call('/network/execution-concurrency', { maxConcurrent: value }, 400);
  const invitation = await receiver.call('/invitations', {});
  const member = new ServiceClient(receiver.root); member.base = receiver.base;
  await member.call('/auth/join', { code: invitation.code, username: 'concurrency_member', name: 'Fixture member', password: `fixture-${randomUUID()}` });
  await member.call('/network/execution-concurrency', { maxConcurrent: 5 }, 403);
  pass('Default 3, limits 1 and 10, invalid input and owner-only writes; changing concurrency preserves disabled execution and approval policy');
  const directory = join(receiver.root, 'same-project'); mkdirSync(directory);
  const project = await receiver.call('/projects', { name: 'Shared fixture directory', directory, trusted: true }, 201);
  await receiver.call('/network/execution-policy', { enabled: true, projectID: project.id, model: 'fixture/m34', approvalMode: 'ask', confirmed: true });
  await pairServices(sender, receiver);
  const receiverID = (await receiver.network()).local!.id;
  await until(() => sender.network(), (network) => {
    const peer = network.nearby.find((n) => n.id === receiverID);
    return !!peer?.channelReady && network.brains.some((b) => b.state === 'established' && b.online && peer.brains.some((p) => p.id === b.id));
  }, 'established shared Brain directory');
  const operator = initial.user.id;
  const local = (n: number) => receiver.call<Task>('/tasks', {
    requestID: randomUUID(), runRequested: true, queueConfirmedFor: receiverID, projectID: project.id,
    title: `CONCURRENCY_LOCAL_${n}`, description: `CONCURRENCY_LOCAL_${n} Reply briefly. Do not use tools.`, criteria: 'Return a short answer.',
    assigneeID: operator, approverID: operator, reviewerID: operator, model: 'fixture/m34', approvalMode: 'ask',
  }, 201);
  const remote = async (n: number) => {
    const response = await sender.call<NodeNetwork & { createdTaskID: string }>(`/network/nodes/${receiverID}/tasks`, {
      requestID: randomUUID(), queueConfirmedFor: receiverID, title: `CONCURRENCY_REMOTE_${n}`,
      description: `CONCURRENCY_REMOTE_${n} Reply briefly. Do not use tools.`, criteria: 'Return a short answer.', requirements: {}, confirmed: true,
    }, 201);
    return response.createdTaskID;
  };
  const count = async () => (await receiver.network()).local!.nodeQueue!.concurrency!;
  const active = (kind: 'LOCAL' | 'REMOTE') => [...release.keys()].filter((key) => key.startsWith(`CONCURRENCY_${kind}_`)).length;
  const waitActive = (kind: 'LOCAL' | 'REMOTE', n: number) => until(async () => active(kind), (value) => value === n, `${n} simultaneous ${kind} official model requests`, 90_000);
  for (let i = 0; i < 11; i++) await local(i);
  await waitActive('LOCAL', 11);
  for (let i = 0; i < 4; i++) await remote(i);
  await waitActive('REMOTE', 3);
  await until(count, (c) => c.remoteOccupied === 3 && c.localExecuting === 11, 'split public report');
  await wait(1500); assert.equal(active('REMOTE'), 3);
  assert(!entered.has('CONCURRENCY_REMOTE_3'));
  const live = (await receiver.bootstrap()).tasks.filter((t) => t.state === 'running');
  assert.equal(live.length, 14); assert(live.every((t) => t.projectID === project.id && t.sessionID));
  assert.equal(new Set(live.map((t) => t.sessionID)).size, 14);
  const offered = (await receiver.network()).local!.worker!;
  assert.equal(offered.load.availableSlots, 0); assert.equal(offered.load.runningTasks, 3);
  pass('Eleven local tasks in one project and three incoming tasks overlap in 14 distinct official sessions; fourth incoming waits and local tasks consume no incoming slots');
  await receiver.call('/network/execution-concurrency', { maxConcurrent: 1 });
  assert.equal(active('REMOTE'), 3);
  release.get('CONCURRENCY_REMOTE_0')!(); release.get('CONCURRENCY_REMOTE_1')!();
  await waitActive('REMOTE', 1);
  await until(count, (c) => c.remoteOccupied === 1 && c.remoteLimit === 1, 'lowered limit report');
  await wait(1500); assert(!entered.has('CONCURRENCY_REMOTE_3'));
  await local(11); await waitActive('LOCAL', 12);
  release.get('CONCURRENCY_REMOTE_2')!();
  await until(async () => entered.has('CONCURRENCY_REMOTE_3'), Boolean, 'waiting incoming starts after remaining slot is released');
  assert.equal(active('REMOTE'), 1);
  release.get('CONCURRENCY_REMOTE_3')!();
  await until(count, (c) => c.remoteOccupied === 0, 'old incoming complete');
  pass('Lowering 3 to 1 leaves all running tasks intact, waits until occupancy drops below 1 and never blocks a new local task');
  await receiver.call('/network/execution-concurrency', { maxConcurrent: 10 });
  for (let i = 10; i < 21; i++) await remote(i);
  await waitActive('REMOTE', 10);
  await wait(1500); assert(!entered.has('CONCURRENCY_REMOTE_20'));
  await local(12); await waitActive('LOCAL', 13);
  await until(count, (c) => c.remoteExecuting === 10 && c.localExecuting === 13 && c.remoteLimit === 10, '23 simultaneous sessions');
  const beforeRestart = (await receiver.bootstrap()).tasks;
  writeFileSync(join(root, 'live-before-restart.json'), JSON.stringify({ counts: await count(), tasks: beforeRestart, intervals: [...entered] }, null, 2));
  pass('Raising to 10 admits ten incoming sessions, queues the eleventh and permits a thirteenth local session while full');
  await receiver.stop();
  for (const resolve of release.values()) resolve();
  await receiver.start({ discovery, logPath: join(root, 'receiver-restart.log') });
  const restarted = await receiver.bootstrap();
  assert.equal(restarted.executionPolicy.maxConcurrent, 10);
  for (const old of beforeRestart.filter((t) => t.sessionID)) {
    const next = restarted.tasks.find((t) => t.id === old.id); assert(next); assert.equal(next.sessionID, old.sessionID);
  }
  await wait(2000);
  const recovered = await count(); assert.equal(recovered.remoteOccupied, 10);
  assert(!entered.has('CONCURRENCY_REMOTE_20'));
  pass('Restart preserves configured 10, task/session identities and all uncertain incoming reservations; queued work cannot duplicate or overbook them');
  status = 'passed';
} catch (error) {
  failure = error instanceof Error ? error.stack || error.message : String(error); console.error(failure); process.exitCode = 1;
} finally {
  for (const resolve of release.values()) resolve();
  await Promise.all(clients.map((client) => client.stop())); await fixture.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status, failure, assertions, root, intervals: [...entered] }, null, 2));
  console.log('Report:', join(root, 'report.json'));
}
