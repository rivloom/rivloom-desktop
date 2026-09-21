/** Fixed-runtime compatibility check. Isolated SQLite, loopback provider, no paid model calls. */
import assert from 'node:assert/strict';
import { parseWindowsEngineStopDiagnostic } from '../server/windows-engine-stop.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { findPreparedEngine, engineBinaryName } from '../server/engine-artifact.ts';
import { engineEnv } from '../server/engine.ts';
import { startKnowledgeBridge } from '../server/knowledge-engine.ts';
import { TaskContextStore, contextSource } from '../server/task-context.ts';
import { workflowSystemPrompt } from '../server/workflow-prompts.ts';

const repo = resolve(import.meta.dirname, '..');
mkdirSync(join(repo, 'test-results', 'context-continuity'), { recursive: true });
const run = mkdtempSync(join(repo, 'test-results', 'context-continuity', 'runtime-'));
const artifact = findPreparedEngine(repo);
const root = join(run, 'engine'), directory = join(run, 'project'), home = join(run, 'home');
for (const path of [root, directory, home]) mkdirSync(path, { recursive: true });
const db = new DatabaseSync(join(run, 'contexts.sqlite'));
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('task'),('other')");
const contexts = new TaskContextStore(db, () => true);
const bridge = await startKnowledgeBridge(() => null, (scope, body) => contexts.call(scope, body));
const policyA = workflowSystemPrompt + '\nRIVLOOM_CONTINUITY_POLICY_A';
const policyB = workflowSystemPrompt + '\nRIVLOOM_CONTINUITY_POLICY_B';
const requests: { index: number; compacting: boolean; policyA: boolean; policyB: boolean; rejected: boolean; input: unknown }[] = [];
let overflow = false;
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    let text = ''; for await (const part of req) text += part;
    const input = JSON.parse(text), index = requests.length;
    const system = input.messages.filter((message: { role: string }) => ['system', 'developer'].includes(message.role))
      .map((message: { content: string }) => message.content).join('\n');
    const compacting = system.includes('context summarization agent');
    const rejected = !compacting && !overflow && JSON.stringify(input.messages).includes('FORCE_CONTEXT_OVERFLOW');
    requests.push({ index, compacting, policyA: system.includes('RIVLOOM_CONTINUITY_POLICY_A'),
      policyB: system.includes('RIVLOOM_CONTINUITY_POLICY_B'), rejected, input });
    if (rejected) {
      overflow = true; res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } })); return;
    }
    const content = compacting ? '## Objective\nContinue fixture.\n## Important Details\nLocal test.\n## Work State\n### Completed\nEarlier turn.\n### Active\nNext turn.\n### Blocked\nNone.\n## Next Move\nReturn a short answer.\n## Relevant Files\nNone.' : 'LOCAL_FIXTURE_OK';
    const high = index === 0 || index === 3;
    const usage = { prompt_tokens: high ? 31500 : 100, completion_tokens: 10, total_tokens: high ? 31510 : 110 };
    const base = { id: `chatcmpl-${index}`, model: input.model, created: Math.floor(Date.now() / 1000) };
    if (!input.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const address = provider.address(); assert.ok(address && typeof address !== 'string');
const password = randomBytes(24).toString('hex');
const env = engineEnv(password, root, { workspace: true });
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
config.enabled_providers = ['fixture']; config.model = config.small_model = 'fixture/test'; config.permission = { '*': 'deny' };
config.agent = { build: { permission: { '*': 'deny' } }, title: { disable: true }, summary: { disable: true } };
config.provider = { fixture: { name: 'Local fixture', npm: '@ai-sdk/openai-compatible',
  options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture', timeout: 10000 },
  models: { test: { name: 'Fixture', tool_call: true, limit: { context: 32000, output: 1000 }, cost: { input: 0, output: 0 } } } } };
Object.assign(env, { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), HOME: home, USERPROFILE: home,
  OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(home, 'managed'),
  OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') });
const child = spawn(process.execPath, [join(repo, 'server', 'engine-host.mjs'), join(artifact.directory, engineBinaryName(artifact.source)),
  'serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'], { cwd: directory, env, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let log = '', baseURL = '';
child.stdout!.on('data', value => { log += String(value).replaceAll(password, '[redacted]'); });
child.stderr!.on('data', value => { log += String(value).replaceAll(password, '[redacted]'); });
const until = async <T>(read: () => Promise<T> | T, label: string): Promise<NonNullable<T>> => {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error(`Timeout: ${label}`);
};
const api = async (path: string, body?: unknown) => {
  const url = new URL(path, baseURL); url.searchParams.set('directory', directory);
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`rivloom:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); assert.ok(response.ok, `${path}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
};
const report: Record<string, unknown> = { binarySHA256: artifact.binarySHA256, sourceCommit: artifact.source.commit,
  scope: 'Unchanged pinned executable, production engine environment/plugin, loopback provider with synthetic usage; no paid calls.', completed: false };
try {
  baseURL = await until(() => { assert.equal(child.exitCode, null, log.slice(-1500)); return log.match(/opencode server listening on (http:\/\/[^\s]+)/)?.[1]; }, 'startup');
  const session = await api('/session', { title: 'Context continuity' });
  async function prompt(sessionID: string, taskID: string, system: string, text: string) {
    const before = requests.length;
    contexts.prepare({ taskID, projectID: 'project', sessionID, runAfter: Date.now(), accountID: '', engineRoot: root, directory,
      system, sources: [contextSource('policy', system), contextSource('request', text)] });
    await api(`/session/${sessionID}/prompt_async`, { model: { providerID: 'fixture', modelID: 'test' }, system, parts: [{ type: 'text', text }] });
    await until(async () => {
      const messages = await api(`/session/${sessionID}/message`), status = await api('/session/status');
      const last = messages.filter((item: { info: { role: string } }) => item.info.role === 'assistant').at(-1)?.info;
      if (last?.error && (!status[sessionID] || status[sessionID].type === 'idle')) throw new Error(JSON.stringify(last.error));
      return requests.length > before && last?.finish && (!status[sessionID] || status[sessionID].type === 'idle');
    }, 'request completion');
  }
  for (let i = 0; i < 4; i++) await prompt(session.id, 'task', policyA, `Phase ${i}. Return a short answer without tools.`);
  assert.ok(requests.filter(value => value.compacting).length >= 2, 'Repeat automatic compaction did not occur');
  assert.ok(requests.filter(value => !value.compacting).every(value => value.policyA && !value.policyB));
  assert.ok(requests.filter(value => value.compacting).every(value => !value.policyA && !value.policyB), 'Execution policy reached internal summary prompt');
  const revisionBoundary = requests.length;
  await prompt(session.id, 'task', policyB, 'New explicit policy. Return a short answer.');
  await prompt(session.id, 'task', policyB, 'FORCE_CONTEXT_OVERFLOW. Return a short answer.');
  assert.ok(overflow); assert.ok(requests.slice(revisionBoundary).some(value => value.compacting), 'Provider overflow did not recover through compaction');
  assert.ok(requests.slice(revisionBoundary).filter(value => !value.compacting).every(value => value.policyB && !value.policyA));
  const other = await api('/session', { title: 'Other task' });
  await prompt(other.id, 'other', 'UNRELATED_TASK_POLICY', 'Return a short answer.');
  assert.ok(!requests.at(-1)!.policyA && !requests.at(-1)!.policyB);
  const snapshot = contexts.list('task');
  assert.ok(snapshot.records.some(record => record.observations.some(value => value.system === 'restored')));
  assert.ok(snapshot.records.every(record => record.observations.every(value => value.system !== 'mismatch')));
  assert.ok(!JSON.stringify(requests).includes(env.RIVLOOM_CONTEXT_BRIDGE_TOKEN!));
  writeFileSync(join(run, 'context-records.json'), JSON.stringify(snapshot, null, 2));
  report.compactions = requests.filter(value => value.compacting).length;
  report.overflowRecovered = true; report.policyReplacement = true; report.crossSessionIsolation = true; report.completed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  if (child.connected) child.disconnect();
  try { await until(() => child.exitCode !== null, 'owned engine tree exit'); assert.equal(child.exitCode, 0); report.engineHostExit = 0; }
  catch (error) {
    report.shutdownError = String(error);
    report.stopDiagnostics = log.split(/\r?\n/).map(parseWindowsEngineStopDiagnostic).filter(Boolean).slice(-8);
    process.exitCode = 1;
  }
  provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
  await bridge.close(); db.close();
  report.requests = requests.length;
  writeFileSync(join(run, 'requests.json'), JSON.stringify(requests, null, 2));
  writeFileSync(join(run, 'engine.log'), log);
  writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, ...report }, null, 2));
}
