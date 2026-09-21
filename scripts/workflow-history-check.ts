// Real desktop service + fixed Runtime; every model reply and all history are isolated fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';
import { isolatedWorkspace, testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Workflow } from '../shared/workflows.ts';

const parent = join(import.meta.dirname, '..', 'test-results', 'workflow-history');
const remoteMode = process.argv.includes('--remote');
await mkdir(parent, { recursive: true }); const evidence = await mkdtemp(join(parent, 'run-'));
const runtime = await isolatedWorkspace('workflow-history'), application = join(runtime, '.data', 'application');
const taskHome = join(runtime, 'home'), directory = join(runtime, 'project');
await mkdir(taskHome); await mkdir(directory);
process.env = { ...testEnvironment(runtime), HOME: taskHome, USERPROFILE: taskHome,
  APPDATA: join(taskHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(taskHome, 'AppData', 'Local'),
  RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
const report: any = { status: 'running', evidence, runtime, remoteMode, realVendorRequests: 0, checks: [] };
const requests: unknown[] = [], failures: string[] = [];
const historySource = 'Keep original. Output PNG. HISTORY_FIRST\n' + '历史分页汉字'.repeat(1900) + '\nHISTORY_PAGE_END';
const text = (content: any): string => typeof content === 'string' ? content : (content || []).map((part: any) => part.text || '').join('');
const model = await modelFixture(30_000, input => {
  requests.push(input);
  try {
    const main = input.tools?.some((tool: any) => tool.function?.name === 'rivloom_history');
    if (!main) return { content: 'History fixture' };
    const user = input.messages.filter((m: any) => m.role === 'user').map((m: any) => text(m.content)).join('\n');
    const planner = user.includes('只允许读取和规划');
    const results = input.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(text(m.content)));
    const tool = (name: string, args: Record<string, unknown>) => ({ toolName: name, arguments: args });
    if (!results.length) return tool('rivloom_history', { action: 'state' });
    const state = results[0]; assert(state.goal?.id && state.version);
    if (!planner) {
      assert(state.notes.some((n: any) => n.text === (state.round === 1 ? 'Output PNG' : 'Output JPG')));
      if (state.round === 2) assert(state.notes.some((n: any) => n.authority === 'user' && n.text === 'Keep original'));
      return { content: JSON.stringify({ kind: 'completed', summary: `Round ${state.round} used the sourced current state`, files: [] }) };
    }
    if (results.length === 1) return tool('rivloom_history', { action: 'search', text: 'PNG', round: 1 });
    if (results.length === 2) {
      const source = results[1].entries.find((entry: any) => entry.kind === 'request'); assert(source);
      return tool('rivloom_history', { action: 'read', id: source.id, revision: source.revision });
    }
    const first = results[2]; assert(first.content.includes('PNG'));
    assert(Buffer.byteLength(JSON.stringify(first)) <= 32 * 1024);
    assert(Buffer.byteLength(JSON.stringify(first)) > 31 * 1024);
    assert.equal(first.nextOffset, first.content.length); assert(first.nextOffset > 10_000);
    if (results.length === 3) return tool('rivloom_history', { action: 'read', id: first.id, revision: first.revision, offset: first.nextOffset });
    assert.equal(results[3].nextOffset, null); assert(results[3].content.includes('HISTORY_PAGE_END'));
    assert.equal(results[3].offset, first.nextOffset);
    assert.equal(first.content + results[3].content, historySource);
    assert(Buffer.byteLength(JSON.stringify(results[3])) <= 32 * 1024);
    if (results.length === 4) return tool('rivloom_history', { action: 'read', id: state.goal.id, revision: state.goal.revision });
    if (results.length === 5) {
      const source = results[4], format = state.round === 1 ? 'PNG' : 'JPG';
      assert(source.content.includes(format));
      const old = state.notes.find((n: any) => n.authority === 'inferred');
      return tool('rivloom_context_note', { requestID: randomUUID(), expectedVersion: state.version, kind: 'decision', text: `Output ${format}`,
        source: { id: source.id, revision: source.revision, quote: format }, ...(old ? { supersedes: old.id } : {}) });
    }
    assert.equal(results[5].authority, 'inferred');
    return { content: JSON.stringify({ kind: 'plan', plan: { summary: 'Use source-backed state', steps: [
      { id: 'verify', title: 'Verify history', instructions: 'Read current state and report the active format without changing files.',
        dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} },
    ] } }) };
  } catch (error) { failures.push(String(error)); return { content: JSON.stringify({ kind: 'completed', summary: `Fixture failed: ${error}`, files: [] }) }; }
});
model.configure(application); model.release(); loadNodeIdentity(application);
const service = new ServiceClient(application), outsider = new ServiceClient(application);
const worker = remoteMode ? new ServiceClient(join(runtime, '.data', 'worker')) : null;
let discovery: { port: number; mdns: boolean } | undefined;
if (worker) {
  const socket = createSocket('udp4'); await new Promise<void>(ok => socket.bind(0, '127.0.0.1', ok));
  discovery = { port: socket.address().port, mdns: false }; await new Promise<void>(ok => socket.close(() => ok()));
  model.configure(worker.root); loadNodeIdentity(worker.root);
}
try {
  await service.start({ runtimeDirectory: runtime, discovery, logPath: join(evidence, 'service.log') });
  const data = await service.bootstrap(); assert.equal(data.engine.version, '1.18.31-rivloom.9b07cf442a7e');
  const project = await service.call('/projects', { name: 'History fixture', directory, trusted: true }, 201);
  let target: Workflow['target'] = { mode: 'automatic' };
  if (worker) {
    await worker.start({ runtimeDirectory: runtime, discovery, logPath: join(evidence, 'worker.log') });
    const remoteDirectory = join(runtime, 'remote-project'); await mkdir(remoteDirectory);
    const remoteProject = await worker.call('/projects', { name: 'Remote history fixture', directory: remoteDirectory, trusted: true }, 201);
    await pairServices(service, worker);
    await worker.call('/network/execution-policy', { enabled: true, projectID: remoteProject.id, model: 'fixture/m34', approvalMode: 'auto', confirmed: true });
    const nodeID = (await worker.network()).local!.id;
    await until(() => service.call('/resources'), value => value.nodes.some((n: any) => n.nodeID === nodeID && n.head?.state === 'ready'), 'remote registration');
    assert((await service.network()).paired?.find(n => n.id === nodeID)?.capabilities.includes('workflow-history-v1'));
    target = { mode: 'locked', nodeID };
  }
  const created = await service.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'History fixture',
    description: historySource,
    projectID: project.id, model: 'fixture/m34', approvalMode: 'auto', target }, 201);
  const completed = await until(() => service.call<Workflow>(`/workflows/${created.id}`), value => ['completed', 'failed'].includes(value.state), 'first round', 60_000);
  assert.equal(completed.state, 'completed', JSON.stringify(completed)); assert.deepEqual(failures, []);
  const before = await service.call(`/workflows/${created.id}/context`);
  assert.equal(before.notes.length, 1); assert.equal(before.notes[0].text, 'Output PNG');
  const confirmed = await service.call(`/workflows/${created.id}/context/notes`, { requestID: randomUUID(), expectedVersion: before.version,
    kind: 'constraint', text: 'Keep original', source: { id: before.goal.id, revision: before.goal.revision, quote: 'Keep original' } });
  assert.equal(confirmed.authority, 'user');
  outsider.base = service.base;
  const invitation = await service.call('/invitations', {});
  await outsider.call('/auth/join', { username: 'history_observer', name: 'Unrelated observer', password: 'fixture-' + randomUUID(), code: invitation.code });
  await outsider.call(`/workflows/${created.id}/context`, undefined, 404);
  await outsider.call(`/workflows/${created.id}/history`, { action: 'search' }, 404);
  await outsider.call(`/workflows/${created.id}/context/notes`, {}, 404);
  report.checks.push('Actual fixed Runtime calls history search/read/state and writes inferred notes', 'Executors receive the planner note with source revision', 'Context APIs enforce workflow ownership');
  report.checks.push('32 KiB serialized Chinese history pages reach the model intact and nextOffset recovers the exact full source');
  await service.stop(); assert.equal(service.child?.exitCode, 0);
  await service.start({ runtimeDirectory: runtime, discovery, logPath: join(evidence, 'restart.log') });
  const targetNode = target.mode === 'locked' ? target.nodeID : null;
  if (worker) await until(() => service.network(), value => !!value.paired?.find(n => n.id === targetNode)?.channelReady, 'reconnected worker');
  const restored = await service.call(`/workflows/${created.id}/context`); assert.equal(restored.notes.length, 2);
  await service.call(`/workflows/${created.id}/messages`, { requestID: randomUUID(), text: 'Keep original. Output JPG instead of PNG. HISTORY_SECOND' }, 201);
  const final = await until(() => service.call<Workflow>(`/workflows/${created.id}`), value => !!value.rounds?.length && ['completed', 'failed'].includes(value.state), 'second round', 60_000);
  assert.equal(final.state, 'completed', JSON.stringify(final)); assert.deepEqual(failures, []);
  assert(!final.conversationContextFile); assert(!final.inputFiles.some(file => file.name.startsWith('rivloom-conversation-')));
  assert(final.planner.attempts.every(attempt => !attempt.inputFiles.some(file => file.name.startsWith('rivloom-conversation-'))));
  if (worker) {
    assert([...final.planner.attempts, ...final.steps.flatMap(s => s.attempts)].every(a => a.kind === 'remote' && a.nodeID === targetNode));
    report.checks.push('Two actual services use authenticated on-demand history across both remote rounds, without cumulative attachments');
  }
  const state = await service.call(`/workflows/${created.id}/context`);
  assert.equal(state.notes.length, 2); assert(state.notes.some((n: any) => n.text === 'Output JPG')); assert(!state.notes.some((n: any) => n.text === 'Output PNG'));
  const audit = await service.call(`/workflows/${created.id}/context/notes`); assert.equal(audit.notes.length, 3);
  const history = await service.call(`/workflows/${created.id}/history`, { action: 'search', text: 'HISTORY_FIRST', round: 1 });
  assert(history.entries.some((n: any) => n.kind === 'request'));
  report.checks.push('Restart preserves confirmed notes and previous sources', 'A later user request supersedes the inferred format; old revisions remain readable');
  report.final = final; report.state = state; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); throw error; }
finally {
  await service.stop(); await worker?.stop(); await model.close(); report.exitCode = service.child?.exitCode; report.workerExitCode = worker?.child?.exitCode;
  report.syntheticRequests = requests.length; report.fixtureFailures = failures;
  await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, status: report.status, requests: requests.length, exitCode: report.exitCode }));
}
