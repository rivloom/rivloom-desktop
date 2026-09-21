// Actual fixed Windows runtime and desktop backend, deterministic loopback inference only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceClient, until } from './m34-fixtures.ts';
import { isolatedWorkspace, testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import type { Task } from '../shared/types.ts';
import type { TaskStreamUpdate } from '../shared/task-stream.ts';

const evidenceRoot = join(import.meta.dirname, '..', 'test-results', 'context-service');
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, 'run-'));
const runtime = await isolatedWorkspace('context-service');
const application = join(runtime, '.data', 'application'), taskHome = join(runtime, 'home'), projectDirectory = join(runtime, 'project');
await mkdir(taskHome); await mkdir(projectDirectory); await writeFile(join(projectDirectory, 'fixture.txt'), 'TRACE_TOOL_OUTPUT: local verification only.\n');
process.env = { ...testEnvironment(runtime), HOME: taskHome, USERPROFILE: taskHome, APPDATA: join(taskHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(taskHome, 'AppData', 'Local'),
 RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
let requests = 0, mainRequests = 0;
const report: any = { status: 'running', evidence, runtime, realVendorRequests: 0, frames: [], checks: [] };
const model = createServer(async (req, res) => {
 if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
 let body = ''; for await (const chunk of req) body += chunk;
 const input = JSON.parse(body); requests++;
 const main = input.tools?.some((tool: any) => tool.function?.name === 'read');
 if (main) mainRequests++;
 const hasRead = input.messages.some((message: any) => message.role === 'tool');
 const useTool = main && !hasRead;
 const id = 'chatcmpl-' + randomUUID();
 res.writeHead(200, { 'Content-Type': 'text/event-stream' });
 const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: input.model, created: Math.floor(Date.now() / 1000),
  choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 80, total_tokens: 100, completion_tokens_details: { reasoning_tokens: 30 } } } : {}) })}\n\n`);
 try {
  send({ role: 'assistant' });
  if (main) for (const text of ['先核对本地夹具。', '确认没有真实用户数据。', '现在读取验证文件。', '记录工具调用与输出。', '核对执行结果。', '准备返回验证结论。']) {
   if (res.destroyed) return; send({ reasoning_content: text }); await delay(180);
  }
  if (useTool) send({ tool_calls: [{ index: 0, id: 'call_trace', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(projectDirectory, 'fixture.txt') }) } }] });
  else for (const text of ['TRACE_FINAL', ': 本地', '流式推理', '与工具记录', '验证完成。']) { if (res.destroyed) return; send({ content: text }); await delay(main ? 180 : 0); }
  send({}, useTool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
 } catch { res.end(); }
});
await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
const address = model.address(); assert(address && typeof address !== 'string');
const config = join(application, 'engine', 'config', 'opencode'); await mkdir(config, { recursive: true });
await writeFile(join(config, 'opencode.json'), JSON.stringify({ enabled_providers: ['fixture'], model: 'fixture/m34', small_model: 'fixture/m34',
 provider: { fixture: { name: 'Local streaming fixture', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-local-only' },
 models: { m34: { name: 'Streaming fixture', reasoning: true, tool_call: true, limit: { context: 32000, output: 4096 }, cost: { input: 0, output: 0 } } } } } }));
loadNodeIdentity(application);
const service = new ServiceClient(application), outsider = new ServiceClient(application);
const abort = new AbortController();
const frames: TaskStreamUpdate[] = [], foreign: TaskStreamUpdate[] = [];
const watch = async (client: ServiceClient, target: TaskStreamUpdate[]) => {
 const res = await fetch(`${client.base}/api/events`, { headers: { Cookie: client.cookie }, signal: abort.signal }); assert.equal(res.status, 200);
 return (async () => { let buffer = ''; try { for await (const chunk of res.body!) { buffer += Buffer.from(chunk).toString(); let boundary;
  while ((boundary = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); if (block.startsWith('event: task-stream')) target.push(JSON.parse(block.split('\ndata: ')[1])); }
 } } catch (error) { if (!abort.signal.aborted) throw error; } })();
};
let ownerFeed: Promise<void> | undefined, memberFeed: Promise<void> | undefined;
try {
 await service.start({ runtimeDirectory: runtime, logPath: join(evidence, 'service.log') });
 const data = await service.bootstrap(); report.engineVersion = data.engine.version; assert.equal(data.engine.version, '1.18.31-rivloom.9b07cf442a7e');
 outsider.base = service.base;
 const invitation = await service.call('/invitations', {});
 await outsider.call('/auth/join', { username: 'trace_observer', name: 'Unrelated observer', password: 'fixture-' + randomUUID(), code: invitation.code });
 // Start listeners without awaiting their lifetime promises.
 ownerFeed = watch(service, frames); memberFeed = watch(outsider, foreign); await delay(100);
 const project = await service.call('/projects', { name: 'Trace fixture', directory: projectDirectory, trusted: true }, 201);
 const created = await service.call<Task>('/tasks', { requestID: randomUUID(), runRequested: true, projectID: project.id, title: 'Streaming trace verification',
  description: 'TRACE_PROBE: Read fixture.txt and report the result. Use only this local fixture file.', criteria: 'Local fixture only',
  assigneeID: data.user.id, approverID: data.user.id, reviewerID: data.user.id, model: 'fixture/m34', approvalMode: 'auto' }, 201);
 await until(async () => frames.filter(f => f.taskID === created.id && f.message.parts?.some(p => p.type === 'reasoning' && p.text.length > 0 && !p.endedAt)).length, count => count >= 3, 'incremental reasoning frames', 45000);
 report.checks.push('Multiple reasoning snapshots arrive before reasoning completes');
 const result = await until(async () => (await service.call<{task: Task}>(`/tasks/${created.id}`)).task, task => ['accepted', 'failed'].includes(task.state), 'completion', 45000);
 assert.equal(result.state, 'accepted', result.error || 'Task failed');
 const parts = result.messages.flatMap(m => m.parts || []);
 assert(parts.some(p => p.type === 'reasoning' && p.text.includes('核对本地夹具')));
 assert(parts.some(p => p.type === 'tool' && p.name === 'read' && p.status === 'completed' && p.output.includes('TRACE_TOOL_OUTPUT')));
 assert(result.messages.some(m => m.text.includes('TRACE_FINAL')));
 assert(result.messages.some(m => m.timing?.completed && m.timing.outputTokens && m.timing.reasoningTokens));
 assert.equal(foreign.length, 0); assert.equal(mainRequests, 2);
 report.checks.push('Actual read tool, interleaved parts, final text and measured token usage persist', 'An authenticated nonparticipant receives no stream frames');
 const contextBefore = await service.call<any>(`/tasks/${created.id}/context`);
 assert.equal(contextBefore.total, 1);
 const context = contextBefore.records[0];
 assert.equal(context.taskID, created.id); assert.equal(context.sessionID, result.sessionID);
 assert(context.sources.some((source: any) => source.kind === 'policy'));
 assert(context.sources.some((source: any) => source.kind === 'project-rules'));
 assert.equal(context.observations.length, 2);
 assert(context.observations.every((value: any) => value.kind === 'execution' && value.system === 'matched'));
 assert(!JSON.stringify(contextBefore).includes('TRACE_PROBE'));
 await outsider.call(`/tasks/${created.id}/context`, undefined, 403);
 report.context = contextBefore;
 report.checks.push('Task submission creates source revisions and two exact execution observations', 'Context API excludes prompt bodies and rejects nonparticipants');
 report.result = result;
 abort.abort(); await Promise.all([ownerFeed, memberFeed]);
 await service.stop(); assert.equal(service.child?.exitCode, 0);
 await service.start({ runtimeDirectory: runtime, logPath: join(evidence, 'restart.log') });
 const restored = (await service.call<{task: Task}>(`/tasks/${created.id}`)).task;
 assert.deepEqual(restored.messages, result.messages); assert.equal(restored.state, 'accepted');
 report.checks.push('Restart preserves ordered reasoning, calls and final usage without replay');
 const contextAfter = await service.call<any>(`/tasks/${created.id}/context`);
 assert.deepEqual(contextAfter, report.context);
 const requestCount = requests;
 await service.call(`/tasks/${created.id}/messages`, { requestID: randomUUID(), text: 'Return a short continuation without modifying files.', confirmed: true });
 const continued = await until(async () => (await service.call<{task: Task}>(`/tasks/${created.id}`)).task,
  task => ['accepted', 'failed'].includes(task.state), 'continued task', 45000);
 assert.equal(continued.state, 'accepted', continued.error || 'Continuation failed');
 const latest = await service.call<any>(`/tasks/${created.id}/context`);
 assert.equal(latest.total, 2); assert.notEqual(latest.records[0].id, latest.records[1].id);
 assert(latest.records[0].observations.length > 0);
 assert(latest.records[0].observations.every((value: any) => value.system === 'matched'));
 assert(requests > requestCount);
 report.checks.push('Context records survive server restart; explicit continuation creates a new version without replay');
 report.afterRestart = latest;
 report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); throw error; }
finally {
 abort.abort(); await Promise.allSettled([ownerFeed, memberFeed].filter(Boolean)); await service.stop(); model.closeAllConnections(); await new Promise<void>(ok => model.close(() => ok()));
 report.serviceExitCode = service.child?.exitCode; report.syntheticRequests = requests; report.mainRequests = mainRequests;
 report.frames = frames.map(f => ({ messageID: f.message.id, version: f.message.streamVersion, types: f.message.parts?.map(p => p.type), chars: f.message.parts?.map(p => p.type === 'tool' ? p.output.length : p.text.length) }));
 await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ evidence, status: report.status, frames: frames.length, requests, exitCode: service.child?.exitCode }));
}
