/** Three isolated desktop services, pinned Runtime, synthetic inference. No physical-node or paid-model claims. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';
import { isolatedWorkspace, testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Workflow } from '../shared/workflows.ts';
import type { Task } from '../shared/types.ts';

const parent = join(import.meta.dirname, '..', 'test-results', 'context-recovery'); await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(join(parent, 'run-')), runtime = await isolatedWorkspace('context-recovery');
const home = join(runtime, 'home'); await mkdir(home);
process.env = { ...testEnvironment(runtime), HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
const clients = ['origin', 'middle', 'last'].map(name => new ServiceClient(join(runtime, '.data', name)));
const [origin, middle] = clients;
const directories = await Promise.all(clients.map(async (_client, index) => { const path = join(runtime, `project-${index}`); await mkdir(path); return path; }));
const nonce = `RECOVERY-${randomUUID()}`, source = 'RECOVERY_SOURCE Keep originals. Only synthetic pending.txt may be written after approval.\n' + '历史恢复汉字'.repeat(1900) + '\n' + nonce;
const deniedFile = join(directories[1], 'pending.txt');
const requests: unknown[] = [], failures: string[] = [], recovered: { stage: string; revision: string; nonce: string }[] = [];
let nodes: string[] = [];
const text = (value: any): string => typeof value === 'string' ? value : (value || []).map((part: any) => part.text || '').join('');
const fixture = await modelFixture(120_000, input => {
  requests.push(input);
  try {
    if (!input.tools?.some((tool: any) => tool.function?.name === 'rivloom_history')) return { content: 'Recovery fixture' };
    const user = input.messages.filter((message: any) => message.role === 'user').map((message: any) => text(message.content)).join('\n');
    const planner = user.includes('此会话只允许读取和规划');
    const lastUser = input.messages.findLastIndex((message: any) => message.role === 'user');
    const results = input.messages.slice(lastUser + 1).filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(text(message.content)));
    const tool = (args: Record<string, unknown>) => ({ toolName: 'rivloom_history', arguments: args });
    if (!results.length) return tool({ action: 'state' });
    const state = results[0]; assert(state.goal?.id && state.version);
    if (planner) return { content: JSON.stringify({ kind: 'plan', plan: { summary: 'Single synthetic recovery step', steps: [
      { id: 'recover', title: 'Recover history', instructions: 'Read source-backed state and original history; keep originals. Continue the synthetic recovery route.',
        dependsOn: [], nodeID: nodes[0], resources: [], software: [], requirements: {} },
    ] } }) };
    if (state.round === 1) return { content: JSON.stringify({ kind: 'completed', summary: 'Synthetic history stored.', files: [] }) };
    assert(state.notes.some((note: any) => note.authority === 'user' && note.text === 'Keep originals'));
    if (results.length === 1) return tool({ action: 'search', text: 'RECOVERY_SOURCE', round: 1 });
    const entry = results[1].entries.find((value: any) => value.kind === 'request'); assert(entry);
    if (results.length === 2) return tool({ action: 'read', id: entry.id, revision: entry.revision });
    const pages = results.slice(2), page = pages.at(-1);
    if (page.nextOffset !== null) return tool({ action: 'read', id: entry.id, revision: entry.revision, offset: page.nextOffset });
    assert.equal(pages.map((value: any) => value.content).join(''), source);
    assert(pages.length >= 2); assert(pages.every((value: any) => value.revision === entry.revision));
    const resumed = user.includes('RECOVERY_RESUME_EXPLICIT');
    const stage = user.includes('RECOVERY_B_CHECKPOINT') ? 'last' : user.includes('RECOVERY_A_CHECKPOINT') ? 'middle' : 'origin';
    recovered.push({ stage: resumed ? `${stage}-resumed` : stage, revision: entry.revision, nonce });
    if (stage === 'origin') return { content: JSON.stringify({ kind: 'handoff', nodeID: nodes[1], reason: 'Synthetic recovery route',
      checkpoint: 'RECOVERY_A_CHECKPOINT: state and source verified; original files unchanged.', files: [], processesStopped: true }) };
    if (stage === 'middle' && !resumed) return { toolName: 'write', arguments: { filePath: deniedFile, content: 'This write must remain unapproved.' } };
    if (stage === 'middle') return { content: JSON.stringify({ kind: 'handoff', nodeID: nodes[2], reason: 'Continue after explicit recovery',
      checkpoint: 'RECOVERY_B_CHECKPOINT: source read after recovery; pending file was not written.', files: [], processesStopped: true }) };
    return { content: JSON.stringify({ kind: 'completed', summary: `Recovered original history through three services: ${nonce}`, files: [] }) };
  } catch (error) { failures.push(String(error)); return { content: JSON.stringify({ kind: 'completed', summary: `FIXTURE_FAILED: ${error}`, files: [] }) }; }
});
fixture.release();
const socket = createSocket('udp4'); await new Promise<void>(ok => socket.bind(0, '127.0.0.1', ok));
const discovery = { port: socket.address().port, mdns: false }; await new Promise<void>(ok => socket.close(() => ok()));
const report: any = { status: 'running', evidence, runtime, realVendorRequests: 0, checks: [] };
try {
  for (const client of clients) { fixture.configure(client.root); loadNodeIdentity(client.root); }
  await Promise.all(clients.map((client, index) => client.start({ runtimeDirectory: runtime, discovery, logPath: join(evidence, `service-${index}.log`) })));
  const data = await Promise.all(clients.map(client => client.bootstrap()));
  assert(data.every(value => value.engine.version === '1.18.31-rivloom.9b07cf442a7e'));
  nodes = (await Promise.all(clients.map(client => client.network()))).map(value => value.local!.id);
  const projects = [];
  for (const [index, client] of clients.entries()) projects.push(await client.call('/projects', { name: `Recovery ${index}`, directory: directories[index], trusted: true }, 201));
  await pairServices(clients[0], clients[1]); await pairServices(clients[0], clients[2]); await pairServices(clients[1], clients[2]);
  for (const [index, client] of clients.entries()) await client.call('/network/execution-policy', {
    enabled: true, projectID: projects[index].id, model: 'fixture/m34', approvalMode: 'ask', confirmed: true,
  });
  await until(() => origin.call('/resources'), value => nodes.slice(1).every(id => value.nodes.some((node: any) => node.nodeID === id && node.head?.state === 'ready')), 'two registered peers');
  const created = await origin.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'Context recovery fixture', description: source,
    projectID: projects[0].id, model: 'fixture/m34', approvalMode: 'ask', target: { mode: 'preferred', nodeID: nodes[0] } }, 201);
  const first = await until(() => origin.call<Workflow>(`/workflows/${created.id}`), value => ['completed', 'failed'].includes(value.state), 'seed round', 60_000);
  assert.equal(first.state, 'completed', JSON.stringify(first)); assert.deepEqual(failures, []);
  const state = await origin.call(`/workflows/${created.id}/context`);
  await origin.call(`/workflows/${created.id}/context/notes`, { requestID: randomUUID(), expectedVersion: state.version, kind: 'constraint',
    text: 'Keep originals', source: { id: state.goal.id, revision: state.goal.revision, quote: 'Keep originals' } });
  await origin.call(`/workflows/${created.id}/messages`, { requestID: randomUUID(), text: 'RECOVERY_ROUND2: continue the three-service synthetic route using the original history; keep originals.' }, 201);
  const pending = await until(() => middle.bootstrap(), value => value.tasks.some(task => task.collaboration?.workflowID === created.id && task.state === 'waiting_approval'), 'middle pending write', 90_000);
  const before = pending.tasks.find(task => task.collaboration?.workflowID === created.id)!;
  assert(before.sessionID); assert(before.messages.some(message => message.tools.some(tool => tool.name === 'rivloom_history' && tool.status === 'completed')));
  await assert.rejects(access(deniedFile));
  const graphBefore = await origin.call<Workflow>(`/workflows/${created.id}`);
  assert.equal(graphBefore.steps[0].attempts.length, 2); assert.equal(graphBefore.handoffs.length, 1);
  report.checks.push('Origin and middle actually read both 32 KiB history pages and the confirmed user constraint before interruption');
  await middle.stop(); assert.equal(middle.child?.exitCode, 0);
  const requestsBeforeRestart = fixture.requests;
  await middle.start({ runtimeDirectory: runtime, discovery, logPath: join(evidence, 'middle-restarted.log') });
  const interrupted = await until(() => origin.call<Workflow>(`/workflows/${created.id}`), value => value.steps[0].attempts.at(-1)?.phase === 'unknown', 'interrupted remote attempt', 60_000);
  const restored = (await middle.bootstrap()).tasks.filter(task => task.collaboration?.workflowID === created.id);
  assert.equal(restored.length, 1); assert.equal(restored[0].id, before.id); assert.equal(restored[0].sessionID, before.sessionID);
  assert.equal(restored[0].state, 'interrupted'); assert.deepEqual(interrupted.steps[0].attempts.map(attempt => attempt.executionID), graphBefore.steps[0].attempts.map(attempt => attempt.executionID));
  await delay(1500); assert.equal(fixture.requests, requestsBeforeRestart); await assert.rejects(access(deniedFile));
  report.checks.push('Restart preserves the same task/session/attempt, leaves it interrupted, and sends no model request or unapproved write');
  const attempt = interrupted.steps[0].attempts.at(-1)!;
  const remote = await until(() => origin.network(), value => value.remoteTasks.some(task => task.id === attempt.executionID && task.executionState === 'interrupted' && !task.controlPending), 'fresh remote sequence');
  const execution = remote.remoteTasks.find(task => task.id === attempt.executionID)!;
  await origin.call(`/network/tasks/${execution.id}/control`, { expectedExecutionSequence: execution.executionSequence,
    action: { kind: 'supplement', text: 'RECOVERY_RESUME_EXPLICIT: Continue this synthetic task. Do not repeat the unapproved write; reread history and hand off the checkpoint.' }, confirmed: true });
  const final = await until(() => origin.call<Workflow>(`/workflows/${created.id}`), value => ['completed', 'failed'].includes(value.state), 'explicit recovery and final handoff', 90_000);
  assert.equal(final.state, 'completed', JSON.stringify(final)); assert.deepEqual(failures, []);
  assert.deepEqual(final.steps[0].attempts.map(value => value.nodeID), nodes);
  assert.equal(final.steps[0].attempts.length, 3); assert(final.steps[0].attempts.every(value => value.phase === 'completed'));
  assert.equal(final.handoffs.length, 2); assert(final.handoffs.every(value => value.phase === 'completed'));
  assert(final.steps[0].attempts.at(-1)!.summary.includes(nonce));
  const middleAfter = (await middle.call<{ task: Task }>(`/tasks/${before.id}`)).task;
  assert.equal(middleAfter.sessionID, before.sessionID); await assert.rejects(access(deniedFile));
  assert(recovered.some(value => value.stage === 'middle-resumed')); assert(recovered.some(value => value.stage === 'last'));
  assert.equal(new Set(recovered.map(value => value.revision)).size, 1);
  assert(!final.conversationContextFile); assert(!final.inputFiles.some(file => file.name.startsWith('rivloom-conversation-')));
  report.checks.push('Explicit authenticated continuation resumes the existing session, rechecks the same source revision, and hands off to the third service',
    'All three attempts and both handoffs finish; original nonce is recovered from history and pending write remains absent');
  report.workflow = final; report.recovered = recovered; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); process.exitCode = 1; }
finally {
  await Promise.allSettled(clients.map(client => client.stop())); await fixture.close();
  report.syntheticRequests = fixture.requests; report.failures = failures; report.exits = clients.map(client => client.child?.exitCode);
  await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, status: report.status, requests: fixture.requests, checks: report.checks, error: report.error }, null, 2));
}
