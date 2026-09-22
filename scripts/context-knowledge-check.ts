// Isolated real desktop + pinned Runtime. Every model response is synthetic and loopback-only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServiceClient, modelFixture, until } from './m34-fixtures.ts';
import { isolatedWorkspace, testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Workflow } from '../shared/workflows.ts';
import type { KnowledgeUsagePage, LocalKnowledgeEntry, WorkflowMemoryLink } from '../shared/knowledge.ts';

const parent = join(import.meta.dirname, '..', 'test-results', 'context-knowledge');
await mkdir(parent, { recursive: true }); const evidence = await mkdtemp(join(parent, 'run-'));
const runtime = await isolatedWorkspace('context-knowledge'), application = join(runtime, '.data', 'application');
const taskHome = join(runtime, 'home'), directory = join(runtime, 'project');
await mkdir(taskHome); await mkdir(directory);
process.env = { ...testEnvironment(runtime), HOME: taskHome, USERPROFILE: taskHome,
  APPDATA: join(taskHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(taskHome, 'AppData', 'Local'),
  RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
const report: any = { status: 'running', evidence, runtime, realVendorRequests: 0, checks: [] };
const requests: unknown[] = [], failures: string[] = [];
const source = 'CONTEXT-KNOWLEDGE-LONG\n' + '中文知识😀"\\\n'.repeat(3000) + '\nSOURCE-END-' + randomUUID();
const text = (content: any): string => typeof content === 'string' ? content : (content || []).map((part: any) => part.text || '').join('');
let memory: LocalKnowledgeEntry;
const model = await modelFixture(30_000, input => {
  requests.push(input);
  try {
    const user = input.messages.filter((m: any) => m.role === 'user').map((m: any) => text(m.content)).join('\n');
    if (user.includes('CONTEXT_MEMORY_LINK') && input.tools?.some((t: any) => t.function.name === 'rivloom_history')) {
      if (user.includes('只允许读取和规划')) return { content: JSON.stringify({ kind: 'plan', plan: { summary: 'Prepare sourced note', steps: [
        { id: 'verify', title: 'Verify requirement', instructions: 'CONTEXT_MEMORY_LINK Report requirements without changing files.',
          dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} },
      ] } }) };
      return { content: JSON.stringify({ kind: 'completed', summary: 'Source available for explicit owner promotion.', files: [] }) };
    }
    if (!user.includes('CONTEXT_KNOWLEDGE_LONG') || !input.tools?.some((t: any) => t.function.name === 'rivloom_knowledge_read'))
      return { content: 'Knowledge fixture' };
    const system = input.messages.filter((m: any) => m.role === 'system').map((m: any) => text(m.content)).join('\n');
    assert(!system.includes(source));
    const results = input.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(text(m.content)));
    if (!results.length) return { toolName: 'rivloom_knowledge_search', arguments: { text: 'Context knowledge long', kind: 'memory', brainID: null } };
    assert(results[0].entries.some((entry: any) => entry.id === memory.id));
    const ref = { brainID: null, nodeID: memory.nodeID, id: memory.id, revision: memory.revision };
    const pages = results.slice(1);
    if (!pages.length) return { toolName: 'rivloom_knowledge_read', arguments: ref };
    for (const page of pages) { assert(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024); assert.equal(page.entry.revision, memory.revision); }
    const last = pages.at(-1);
    if (last.nextOffset !== null) return { toolName: 'rivloom_knowledge_read', arguments: { ...ref, offset: last.nextOffset } };
    assert(pages.length > 1); assert.equal(pages.map((page: any) => page.content).join(''), source);
    report.pages = pages.map((page: any) => ({ offset: page.offset, nextOffset: page.nextOffset, bytes: Buffer.byteLength(JSON.stringify(page)) }));
    return { content: 'All exact source pages loaded successfully.' };
  } catch (error) { failures.push(String(error)); return { content: `Fixture failed: ${error}` }; }
});
model.configure(application); model.release(); loadNodeIdentity(application);
const service = new ServiceClient(application), outsider = new ServiceClient(application);
try {
  await service.start({ runtimeDirectory: runtime, logPath: join(evidence, 'service.log') });
  const bootstrap = await service.bootstrap(); assert.equal(bootstrap.engine.version, '1.18.31-rivloom.9b07cf442a7e');
  const project = await service.call('/projects', { name: 'Context knowledge fixture', directory, trusted: true }, 201);
  memory = await service.call('/knowledge/memory', { name: 'Context knowledge long', description: 'Chinese source with escaping and emoji',
    category: 'Projects/Fixture/Reference', body: source, projectID: project.id });
  const owner = bootstrap.user;
  const task = await service.call('/tasks', { projectID: project.id, title: 'CONTEXT_KNOWLEDGE_LONG', description: 'CONTEXT_KNOWLEDGE_LONG Read the relevant project Wiki until complete.',
    criteria: 'Exact source and version retained.', assigneeID: owner.id, approverID: owner.id, reviewerID: owner.id,
    model: 'fixture/m34', approvalMode: 'auto' }, 201);
  await service.call(`/tasks/${task.id}/claim`, {}); await service.call(`/tasks/${task.id}/run`, { confirmed: true });
  const completed = await until(() => service.call(`/tasks/${task.id}`), value => ['accepted', 'failed', 'waiting_approval'].includes(value.task.state), 'knowledge pages', 60_000);
  assert.equal(completed.task.state, 'accepted', JSON.stringify(completed)); assert.deepEqual(failures, []); assert(report.pages?.length > 1);
  const usage = await service.call<KnowledgeUsagePage>(`/tasks/${task.id}/context/knowledge`);
  assert.equal(usage.total, report.pages.length); assert(usage.entries.every(entry => entry.revision === memory.revision && entry.reference.id === memory.id));
  assert(!JSON.stringify(usage).includes(source)); report.usage = usage;
  report.checks.push('Pinned Runtime receives exact 32 KiB Chinese/emoji/escaped Wiki pages and follows nextOffset',
    'Only successful read ranges enter metadata-only usage; no entire Wiki is injected into system');
  const workflow = await service.call<Workflow>('/workflows', { requestID: randomUUID(), title: 'CONTEXT_MEMORY_LINK',
    description: 'CONTEXT_MEMORY_LINK Keep original. Output PNG. Future output JPG.', projectID: project.id, model: 'fixture/m34',
    approvalMode: 'auto', target: { mode: 'automatic' } }, 201);
  const done = await until(() => service.call<Workflow>(`/workflows/${workflow.id}`), value => ['completed', 'failed'].includes(value.state), 'memory workflow', 60_000);
  assert.equal(done.state, 'completed'); assert.deepEqual(failures, []);
  const state = await service.call(`/workflows/${workflow.id}/context`);
  const confirmed = await service.call(`/workflows/${workflow.id}/context/notes`, { requestID: randomUUID(), expectedVersion: state.version,
    kind: 'decision', text: 'Output PNG', source: { id: state.goal.id, revision: state.goal.revision, quote: 'Output PNG' } });
  const promote = { requestID: randomUUID(), expectedVersion: confirmed.version, noteID: confirmed.id,
    name: 'Fixture format', description: 'Owner-confirmed project format', category: 'Projects/Fixture/Decisions' };
  const first = await service.call<WorkflowMemoryLink>(`/workflows/${workflow.id}/context/memory`, promote);
  assert.deepEqual(await service.call(`/workflows/${workflow.id}/context/memory`, promote), first);
  assert.equal(first.provenance.source.revision, state.goal.revision); assert.equal(first.status, 'active');
  const replace = await service.call(`/workflows/${workflow.id}/context/notes`, { requestID: randomUUID(), expectedVersion: confirmed.version,
    kind: 'decision', text: 'output JPG', source: { id: state.goal.id, revision: state.goal.revision, quote: 'output JPG' }, supersedes: confirmed.id });
  const second = await service.call<WorkflowMemoryLink>(`/workflows/${workflow.id}/context/memory`, { ...promote, requestID: randomUUID(),
    expectedVersion: replace.version, noteID: replace.id, id: first.id, expectedRevision: first.revision });
  assert.equal(second.id, first.id); assert.notEqual(second.revision, first.revision);
  assert.equal((await service.call(`/knowledge/history/${first.id}`)).length, 2);
  const withdraw = { requestID: randomUUID(), id: second.id, expectedRevision: second.revision };
  const withdrawn = await service.call<WorkflowMemoryLink>(`/workflows/${workflow.id}/context/memory/withdraw`, withdraw);
  assert.equal(withdrawn.status, 'withdrawn'); assert.deepEqual(await service.call(`/workflows/${workflow.id}/context/memory/withdraw`, withdraw), withdrawn);
  await service.call('/knowledge/read', { brainID: null, nodeID: first.nodeID, id: first.id }, 409);
  assert((await service.call(`/knowledge/memory/${first.id}`)).body.includes('output JPG'));
  report.checks.push('Owner confirms, promotes and replaces exact source-backed notes; receipts are idempotent and old Wiki versions remain',
    'Explicit withdrawal hides discovery and blocks further reading while retaining body and versions');
  outsider.base = service.base;
  const invitation = await service.call('/invitations', {});
  await outsider.call('/auth/join', { username: 'knowledge_observer', name: 'Unrelated observer', password: 'fixture-' + randomUUID(), code: invitation.code });
  await outsider.call(`/workflows/${workflow.id}/context/memory`, undefined, 403);
  await outsider.call(`/workflows/${workflow.id}/context/memory`, promote, 403);
  await outsider.call(`/tasks/${task.id}/context/knowledge`, undefined, 403);
  report.checks.push('Unrelated user cannot read usage or promote another conversation into private memory');
  await service.stop(); assert.equal(service.child?.exitCode, 0);
  await service.start({ runtimeDirectory: runtime, logPath: join(evidence, 'restart.log') });
  assert.deepEqual(await service.call(`/tasks/${task.id}/context/knowledge`), usage);
  assert.deepEqual(await service.call(`/workflows/${workflow.id}/context/memory`), [withdrawn]);
  report.checks.push('Actual backend restart preserves usage, provenance and withdrawal state'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); throw error; }
finally {
  await service.stop(); await model.close(); report.exitCode = service.child?.exitCode;
  report.syntheticRequests = requests.length; report.fixtureFailures = failures;
  await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence, status: report.status, requests: requests.length, exitCode: report.exitCode }));
}
