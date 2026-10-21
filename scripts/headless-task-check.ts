// Two isolated services, the Rivloom OpenCode engine, and a deterministic loopback model.
import assert from 'node:assert/strict';
import { readEngineSource } from '../server/engine-artifact.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bootstrap, ModelSettings, NodeNetwork, NodePairing, Project, Task } from '../shared/types.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';
import { taskFileMime, type TaskFileConversation, type TaskFileDescriptor } from '../shared/task-files.ts';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { parseMacosEngineStopDiagnostic, type MacosEngineStopDiagnostic } from '../server/macos-process.mjs';
import { readMacosStartupEvidence } from './macos-startup-evidence.ts';

/** Failure evidence only: never return prompt, tool input/output, IDs, paths or raw errors. */
export function readTaskSessionEvidence(dataDirectory: string, sessionID: string | null) {
  if (!sessionID) return { status: 'not-applicable' as const };
  let database: DatabaseSync | undefined;
  try {
    if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0') || sessionID.length > 120 || sessionID.includes('\0'))
      return { status: 'rejected' as const };
    const safeDirectory = (path: string) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === 'function' && info.uid !== process.getuid())
        throw new Error('unsafe-directory');
    };
    safeDirectory(dataDirectory);
    let path = realpathSync(dataDirectory);
    for (const segment of ['engine', 'data', 'opencode']) { path = join(path, segment); safeDirectory(path); }
    path = join(path, 'opencode.db');
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || typeof process.getuid === 'function' && before.uid !== process.getuid()) return { status: 'rejected' as const };
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) return { status: 'rejected' as const };
    // Schema verified against the source-locked core's packages/core/src/session/sql.ts.
    // SQLite selects fixed classifications; raw JSON data never crosses this boundary.
    const messages = database.prepare(`SELECT
      CASE WHEN json_valid(data) THEN CASE json_extract(data,'$.role') WHEN 'user' THEN 'user' WHEN 'assistant' THEN 'assistant' ELSE 'unknown' END ELSE 'unknown' END AS role,
      CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.time.completed') IN ('integer','real') AND json_extract(data,'$.time.completed') > 0 THEN 1 ELSE 0 END ELSE 0 END AS completed,
      CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.error') IS NOT NULL AND json_type(data,'$.error') != 'null' THEN 1 ELSE 0 END ELSE 0 END AS failed
      FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 257`).all(sessionID);
    const parts = database.prepare(`SELECT
      CASE WHEN json_valid(data) THEN CASE json_extract(data,'$.type') WHEN 'text' THEN 'text' WHEN 'reasoning' THEN 'reasoning' WHEN 'tool' THEN 'tool' WHEN 'step-start' THEN 'step-start' WHEN 'step-finish' THEN 'step-finish' ELSE 'other' END ELSE 'other' END AS type,
      CASE WHEN json_valid(data) THEN CASE json_extract(data,'$.state.status') WHEN 'pending' THEN 'pending' WHEN 'running' THEN 'running' WHEN 'completed' THEN 'completed' WHEN 'error' THEN 'error' ELSE 'unknown' END ELSE 'unknown' END AS toolState
      FROM part WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 257`).all(sessionID);
    const messageSample = messages.slice(0, 256), partSample = parts.slice(0, 256);
    return {
      status: 'read' as const,
      sessionPresent: !!database.prepare('SELECT 1 FROM session WHERE id=?').get(sessionID),
      messages: { sampled: messageSample.length, truncated: messages.length > 256,
        user: messageSample.filter(row => row.role === 'user').length,
        assistant: messageSample.filter(row => row.role === 'assistant').length,
        unknown: messageSample.filter(row => row.role === 'unknown').length,
        assistantCompleted: messageSample.filter(row => row.role === 'assistant' && row.completed === 1).length,
        assistantError: messageSample.filter(row => row.role === 'assistant' && row.failed === 1).length },
      parts: { sampled: partSample.length, truncated: parts.length > 256,
        text: partSample.filter(row => row.type === 'text').length,
        reasoning: partSample.filter(row => row.type === 'reasoning').length,
        tool: partSample.filter(row => row.type === 'tool').length,
        stepStart: partSample.filter(row => row.type === 'step-start').length,
        stepFinish: partSample.filter(row => row.type === 'step-finish').length,
        toolPending: partSample.filter(row => row.type === 'tool' && row.toolState === 'pending').length,
        toolRunning: partSample.filter(row => row.type === 'tool' && row.toolState === 'running').length,
        toolCompleted: partSample.filter(row => row.type === 'tool' && row.toolState === 'completed').length,
        toolError: partSample.filter(row => row.type === 'tool' && row.toolState === 'error').length },
    };
  } catch { return { status: 'unavailable' as const }; }
  finally { try { database?.close(); } catch { /* Diagnostic cleanup must not mask the original failure. */ } }
}

export function summarizeTaskContextEvidence(value: unknown, sessionID: string, runAfter: number) {
  const source = value as { records?: unknown } | null;
  if (!source || !Array.isArray(source.records)) return { status: 'invalid-response' as const };
  const records = source.records.slice(0, 20) as Array<{ sessionID?: unknown; runAfter?: unknown; observationCount?: unknown; observations?: unknown }>;
  const current = records.find(row => row && row.sessionID === sessionID && row.runAfter === runAfter);
  const observations = current && Array.isArray(current.observations) ? current.observations.slice(0, 50) : [];
  const number = current?.observationCount;
  return { status: 'read' as const, recordPresent: !!current,
    observationCount: typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000 ? number : null,
    truncated: source.records.length > 20 || !!current && Array.isArray(current.observations) && current.observations.length > 50,
    observations: {
      execution: observations.filter(row => row?.kind === 'execution').length,
      compaction: observations.filter(row => row?.kind === 'compaction').length,
      matched: observations.filter(row => row?.system === 'matched').length,
      restored: observations.filter(row => row?.system === 'restored').length,
      mismatch: observations.filter(row => row?.system === 'mismatch').length,
      notApplicable: observations.filter(row => row?.system === 'not_applicable').length,
    } };
}

export async function checkHeadlessTask(root = resolve(import.meta.dirname, '..')) {
  const previousUmask = process.umask(0o077);
  const base = join(root, 'test-results', 'headless-task');
  await mkdir(base, { recursive: true });
  const sandbox = await mkdtemp(join(base, 'check-'));
  const home = join(sandbox, 'home'), projectDirectory = join(sandbox, 'project');
  mkdirSync(home); mkdirSync(projectDirectory);
  const outputPath = join(projectDirectory, 'headless-result.txt');
  const outputText = 'This file was written by Rivloom OpenCode on the isolated headless worker.\n';
  const completionText = 'HEADLESS_TASK_OK: wrote headless-result.txt on the headless worker.';
  const environment = { ...testEnvironment(sandbox), HOME: home, USERPROFILE: home, RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'enabled' };
  const socket = createSocket('udp4');
  await new Promise<void>((done, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', done); });
  const discoveryPort = socket.address().port;
  await new Promise<void>(done => socket.close(done));
  const cli = join(root, 'cli', 'index.ts');
  const checks: { name: string; evidence: unknown }[] = [];
  const pass = (name: string, evidence: unknown = {}) => { checks.push({ name, evidence }); console.log(`PASS ${name}`); };
  const fixture = await modelFixture(120_000, input => {
    const tools = (input.tools || []) as { function?: { name?: string } }[];
    if (!tools.some(tool => tool.function?.name === 'write')) return { content: 'Headless fixture task' };
    const written = (input.messages || []).some((message: { role: string; tool_calls?: { function?: { name?: string } }[] }) =>
      message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'write'));
    return written ? { content: completionText } : { toolName: 'write', arguments: { filePath: outputPath, content: outputText } };
  });
  fixture.release();

  class ManagedNode extends ServiceClient {
    readonly headless: boolean;
    readonly stopReceipts: MacosEngineStopDiagnostic[] = [];
    logs = '';
    constructor(name: string, headless: boolean) { super(join(sandbox, name)); this.headless = headless; }
    observeStopReceipts() {
      const receipts = this.logs.split(/\r?\n/).map(parseMacosEngineStopDiagnostic).filter(value => value !== undefined).slice(-8);
      this.stopReceipts.splice(0, this.stopReceipts.length, ...receipts);
      return this.stopReceipts;
    }
    async launch() {
      assert(!this.child || this.child.exitCode !== null || this.child.signalCode !== null);
      this.base = ''; this.cookie = ''; this.output = '';
      const bootstrap = `await (await import(${JSON.stringify(pathToFileURL(cli).href)})).main(['--data-dir',${JSON.stringify(this.root)},'serve']); process.once('message', async message => { if (message === 'shutdown') await (await import(${JSON.stringify(pathToFileURL(join(root, 'server/index.ts')).href)})).shutdown(); });`;
      const args = this.headless
        ? process.platform === 'win32' ? ['--input-type=module', '-e', bootstrap] : [cli, '--data-dir', this.root, 'serve']
        : [join(root, 'server', 'desktop-entry.mjs')];
      this.child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: {
        ...environment, PORT: '0', RIVLOOM_DATA_DIR: this.root, RIVLOOM_DISCOVERY_PORT: String(discoveryPort),
        ...(this.headless ? {} : { RIVLOOM_DESKTOP: '1' }),
      } });
      const capture = (chunk: Buffer) => {
        const text = chunk.toString(); this.logs += text; this.output = (this.output + text).slice(-8000);
        this.base ||= this.output.match(/RIVLOOM_(?:DESKTOP|HEADLESS)_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || '';
      };
      this.child.stdout!.on('data', capture); this.child.stderr!.on('data', capture);
      await until(async () => { assert.equal(this.child!.exitCode, null, this.output); return this.base; }, Boolean, 'isolated node listener');
      await until(() => this.call<{ engineReady: boolean }>('/health'), health => health.engineReady, 'Rivloom engine readiness', 60_000);
      if (this.headless) {
        const control = JSON.parse(readFileSync(join(this.root, 'headless-control.json'), 'utf8')) as { token: string };
        await this.call('/auth/headless', {}, 200, { 'X-Rivloom-Headless-Token': control.token });
      } else await this.authenticate();
      const state = await this.bootstrap();
      assert(state.network.local, `${this.headless ? 'Headless' : 'Desktop'} node identity unavailable: network=${['starting', 'online', 'degraded', 'disabled'].includes(state.network.status) ? state.network.status : 'invalid'}, error=${state.network.error ? 'reported' : 'none'}`);
      assert.equal(state.engine.version, readEngineSource(root).version);
      assert.deepEqual(state.engine.models.map(model => model.id), ['fixture/m34']);
    }
    override async stop() {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<{ code: number | null; signal: string | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
      if (!this.headless) child.stdin!.end('shutdown\n');
      else if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      const result = await Promise.race([exited, delay(25_000, null, { ref: false })]);
      if (!result) { child.kill('SIGKILL'); throw new Error('Isolated node failed to stop normally'); }
      assert.equal(result.code, 0, 'Isolated node shutdown failed');
      if (this.headless) assert(!existsSync(join(this.root, 'headless-control.json')));
    }
  }
  const origin = new ManagedNode('desktop-origin', false), worker = new ManagedNode('headless-worker', true);
  let phase = 'initializing', originID = '', workerID = '', remoteID = '';
  let lastPermissionObservation: unknown, failureDiagnostics: unknown;
  const taskState = (state: Bootstrap) => {
    const task = state.tasks.find(item => item.remoteOrigin?.remoteTaskID === remoteID);
    const remote = state.network.remoteTasks.find(item => item.id === remoteID);
    return {
      engine: { ready: state.engine.ready, errorPresent: !!state.engine.error, fixtureModelPresent: state.engine.models.some(model => model.id === 'fixture/m34') },
      task: task ? { state: task.state, sessionPresent: !!task.sessionID, approvals: task.approvals.length, errorPresent: !!task.error } : null,
      remote: remote ? { status: remote.status, transmissionState: remote.transmissionState ?? null, deliveryPending: remote.deliveryPending,
        deliveryErrorPresent: !!remote.deliveryError, executionStatus: remote.executionStatus, executionState: remote.executionState, localTaskPresent: !!remote.localTaskID } : null,
    };
  };
  async function observeFailure() {
    async function read<T>(node: ManagedNode, route: string): Promise<{ status: number | null; value?: T }> {
      if (!node.base) return { status: null };
      try {
        const response = await fetch(`${node.base}/api${route}`, { headers: { cookie: node.cookie, 'x-rivloom-request': '1' }, signal: AbortSignal.timeout(3000) });
        return { status: response.status, ...(response.ok ? { value: await response.json() as T } : {}) };
      } catch { return { status: null }; }
    }
    const nodes = await Promise.all(([['origin', origin, workerID], ['worker', worker, originID]] as const).map(async ([role, node, peerID]) => {
      const [bootstrap, queue, coreLog] = await Promise.all([read<Bootstrap>(node, '/bootstrap'), read<NodeQueueSnapshot>(node, '/node-queue'),
        process.platform === 'darwin' ? readMacosStartupEvidence(node.root) : undefined]);
      const state = bootstrap.value;
      const peer = state?.network.nearby.find(item => item.id === peerID);
      const currentTask = state?.tasks.find(item => item.remoteOrigin?.remoteTaskID === remoteID);
      const context = currentTask?.sessionID ? await read(node, `/tasks/${encodeURIComponent(currentTask.id)}/context`) : undefined;
      return {
        role, child: { exitCode: node.child?.exitCode ?? null, signalCode: node.child?.signalCode ?? null },
        stopReceipts: node.observeStopReceipts(),
        ...(coreLog ? { coreLog } : {}),
        coreSession: readTaskSessionEvidence(node.root, currentTask?.sessionID ?? null),
        context: context ? { httpStatus: context.status,
          ...(context.value ? summarizeTaskContextEvidence(context.value, currentTask!.sessionID!, currentTask!.runAfter) : {}) } : null,
        bootstrapStatus: bootstrap.status, queueStatus: queue.status,
        ...(state ? taskState(state) : {}),
        network: state ? { status: state.network.status, errorPresent: !!state.network.error,
          peerPresent: !!peer, online: !!peer?.online, trusted: !!peer?.trusted, channelReady: !!peer?.channelReady } : null,
        queue: queue.value ? { paused: queue.value.paused, entries: queue.value.entries
          .filter(item => item.source.kind === 'remote' && item.source.remoteTaskID === remoteID).slice(0, 4)
          .map(item => ({ state: item.state, admissionPhase: item.admissionPhase, blockReason: item.blockReason?.code ?? null,
            endReason: item.endReason?.code ?? null, receivedSequence: item.receivedSequence, localTaskPresent: !!item.localTaskID })) } : null,
      };
    }));
    failureDiagnostics = { phase, at: new Date().toISOString(), modelRequests: fixture.requests, fixtureTransport: fixture.transport,
      remoteCreated: !!remoteID, lastPermissionObservation, nodes };
    console.error('HEADLESS_TASK_DIAGNOSTIC', JSON.stringify(failureDiagnostics));
  }
  async function cliCommand<T = unknown>(args: string[]): Promise<T> {
    return new Promise<T>((done, reject) => {
      const child = spawn(process.execPath, [cli, '--data-dir', worker.root, ...args], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
      child.once('error', failure => { clearTimeout(timer); reject(failure); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`Headless CLI ${args[0]} exited ${code}: ${error.slice(-3000)}`)); return; }
        try { done(JSON.parse(output) as T); } catch { reject(new Error(`Headless CLI ${args[0]} returned invalid JSON`)); }
      });
    });
  }
  const waitChannel = (left: ServiceClient, rightID: string) => until(() => left.network(),
    network => !!network.nearby.find(node => node.id === rightID && node.online && node.trusted && node.channelReady), 'bidirectional encrypted channel');
  const taskFor = (state: Bootstrap, remoteID: string) => state.tasks.find(task => task.remoteOrigin?.remoteTaskID === remoteID);
  function sessionIDs() {
    const db = new DatabaseSync(join(worker.root, 'engine', 'data', 'opencode', 'opencode.db'), { readOnly: true });
    try { return db.prepare('SELECT id FROM session ORDER BY id').all().map(row => String(row.id)); }
    finally { db.close(); }
  }
  let failure: unknown;
  try {
    await cliCommand(['init', '--name', 'Isolated headless executor']);
    for (const node of [origin, worker]) { mkdirSync(node.root, { recursive: true, mode: 0o700 }); fixture.configure(node.root); }
    // Model the existing desktop installation that a new Linux worker joins.
    loadNodeIdentity(origin.root);
    phase = 'launching';
    await Promise.all([origin.launch(), worker.launch()]);
    originID = (await origin.network()).local!.id; workerID = (await worker.network()).local!.id;
    phase = 'configuring_worker';
    const project = await cliCommand<Project>(['projects', 'add', projectDirectory, '--name', 'Headless execution fixture', '--confirm']);
    assert((await cliCommand<ModelSettings>(['models', 'list'])).models.some(model => model.id === 'fixture/m34'));
    await cliCommand(['models', 'default', 'fixture/m34']);
    await cliCommand(['execution', 'enable', '--project', project.id, '--model', 'fixture/m34', '--approval', 'ask', '--confirm']);
    await cliCommand(['execution', 'concurrency', '1']);
    pass('The worker is configured through the real CLI with an isolated project, loopback model and explicit ask policy');

    phase = 'pairing';
    await until(() => origin.network(), network => network.nearby.some(node => node.id === workerID && node.online), 'worker discovery');
    await until(() => worker.network(), network => network.nearby.some(node => node.id === originID && node.online), 'origin discovery');
    await origin.call('/network/pairings', { nodeID: workerID }, 201);
    const pairing = (await origin.network()).pairings.find(item => item.nodeID === workerID)!; assert(pairing);
    const workerPairing = (await cliCommand<{ pairings: NodePairing[] }>(['pair', 'list'])).pairings.find(item => item.id === pairing.id)!;
    assert(workerPairing && workerPairing.code === pairing.code);
    await origin.call(`/network/pairings/${pairing.id}/confirm`, {});
    await cliCommand(['pair', 'confirm', pairing.id, '--code', workerPairing.code]);
    await Promise.all([waitChannel(origin, workerID), waitChannel(worker, originID)]);
    await until(() => origin.network(), network => {
      const target = network.nearby.find(node => node.id === workerID);
      return network.brains.some(brain => brain.state === 'established' && brain.online && target?.brains.some(item => item.id === brain.id));
    }, 'established shared Brain after pairing', 60_000);
    pass('Desktop and headless nodes discover each other on an isolated port, compare codes and establish encrypted channels');

    const request = { requestID: randomUUID(), title: 'Headless execution fixture', description: 'Write headless-result.txt in the selected project and return a short completion summary.', criteria: 'The file contains the fixture output and returns to the originating desktop node.', requirements: {}, confirmed: true };
    const route = `/network/nodes/${workerID}/tasks`;
    phase = 'submitting';
    const sent = await origin.call<NodeNetwork & { createdTaskID: string }>(route, request, 201);
    remoteID = sent.createdTaskID; assert(remoteID);
    phase = 'waiting_permission';
    const pending = await until(() => worker.bootstrap(), state => {
      lastPermissionObservation = { at: new Date().toISOString(), ...taskState(state) };
      const task = taskFor(state, remoteID);
      if (task?.state === 'failed') throw new Error(`Official task failed: ${task.error}`);
      return task?.state === 'waiting_approval' && task.approvals.length > 0;
    }, 'official write permission request', 90_000);
    const localTask = taskFor(pending, remoteID)!;
    assert(!existsSync(outputPath), 'File must not be written before permission approval');
    const cliPending = await cliCommand<{ taskID: string; approvals: Task['approvals'] }[]>(['pending']);
    assert(cliPending.find(task => task.taskID === localTask.id)?.approvals.some(approval => approval.id === localTask.approvals[0].id));
    phase = 'approving';
    await cliCommand(['approve', localTask.id, localTask.approvals[0].id, 'once']);
    phase = 'waiting_completion';
    const complete = await until(() => worker.bootstrap(), state => taskFor(state, remoteID)?.state === 'accepted', 'official task completion', 90_000);
    const completedTask = taskFor(complete, remoteID)!;
    assert.equal(readFileSync(outputPath, 'utf8'), outputText);
    assert(completedTask.sessionID);
    const received = await until(() => origin.network(), network => network.remoteTasks.some(task => task.id === remoteID && task.executionState === 'accepted' && task.executionSummary.includes(completionText)), 'origin completion summary');
    assert(received.remoteTasks.find(task => task.id === remoteID)!.executionSummary.includes(completionText));
    pass('An actual Rivloom-engine write waits for CLI approval, then completes and returns its summary to the desktop origin', { remoteID, localTaskID: completedTask.id, sessionID: completedTask.sessionID });

    // Explicitly select the file that OpenCode actually wrote, using the existing
    // result-attachment API; this does not claim all arbitrary output files auto-publish.
    phase = 'delivering_result';
    const bytes = readFileSync(outputPath);
    const descriptor: TaskFileDescriptor = { id: randomUUID(), name: 'headless-result.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime: taskFileMime('headless-result.txt') };
    await worker.call('/task-files/uploads', descriptor, 201);
    await worker.call(`/task-files/uploads/${descriptor.id}/chunk`, { offset: 0, data: bytes.toString('base64') });
    await worker.call(`/task-files/remote/${remoteID}/results`, { attachmentIDs: [descriptor.id] });
    await until(() => origin.call<TaskFileConversation>(`/task-files/remote/${remoteID}`), value => value.results.some(file => file.id === descriptor.id && file.state === 'complete'), 'encrypted result file delivery');
    const response = await fetch(`${origin.base}/api/task-files/remote/${remoteID}/${descriptor.id}/content`, { headers: { cookie: origin.cookie, 'x-rivloom-request': '1' }, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    pass('The explicitly selected file produced by the headless engine returns to the desktop byte for byte', { bytes: bytes.length, sha256: descriptor.sha256 });

    await until(async () => fixture.pendingRequests, count => count === 0, 'model responses settled');
    const beforeRestartRequests = fixture.requests;
    assert.deepEqual(sessionIDs(), [completedTask.sessionID]);
    phase = 'restarting';
    await worker.stop();
    await worker.launch();
    await Promise.all([waitChannel(origin, workerID), waitChannel(worker, originID)]);
    phase = 'verifying_restart';
    const restarted = await worker.bootstrap();
    assert.equal(restarted.network.local!.id, workerID);
    assert.equal(restarted.network.pairings.length, 0);
    assert(restarted.network.paired?.some(node => node.id === originID && node.trusted));
    assert.equal((await origin.call<NodeNetwork & { createdTaskID: string }>(route, request, 201)).createdTaskID, remoteID);
    await delay(5500); // Cross the worker's real processing tick after the repeated request.
    const final = await worker.bootstrap();
    const tasks = final.tasks.filter(task => task.remoteOrigin?.remoteTaskID === remoteID);
    assert.equal(tasks.length, 1); assert.equal(tasks[0].id, completedTask.id); assert.equal(tasks[0].sessionID, completedTask.sessionID); assert.equal(tasks[0].state, 'accepted');
    assert.deepEqual(sessionIDs(), [completedTask.sessionID]);
    assert.equal(fixture.requests, beforeRestartRequests);
    assert.equal(readFileSync(outputPath, 'utf8'), outputText);
    assert.equal((await origin.bootstrap()).tasks.length, 0);
    pass('Headless restart preserves identity and trust; retrying the original request creates no extra task, session or model request', { modelRequests: fixture.requests, sessions: 1, tasks: 1 });
  } catch (error) {
    failure = error;
    try { await observeFailure(); }
    catch { failureDiagnostics = { phase, observationFailed: true, modelRequests: fixture.requests, nodes: [
      { role: 'origin', stopReceipts: origin.stopReceipts }, { role: 'worker', stopReceipts: worker.stopReceipts },
    ] }; }
  }
  finally {
    for (const node of [worker, origin]) {
      try { await node.stop(); } catch (error) { failure ||= error; }
      node.observeStopReceipts();
      writeFileSync(join(sandbox, node.headless ? 'worker.log' : 'origin.log'), node.logs);
    }
    await fixture.close();
    if (failure && !failureDiagnostics) failureDiagnostics = { phase, nodes: [
      { role: 'origin', stopReceipts: origin.stopReceipts }, { role: 'worker', stopReceipts: worker.stopReceipts },
    ] };
    writeFileSync(join(sandbox, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, engineVersion: readEngineSource(root).version, platform: process.platform, arch: process.arch, modelRequests: fixture.requests, discoveryPort, shutdown: process.platform === 'win32' ? 'headless test IPC -> exported shutdown; desktop stdin lifecycle' : 'headless SIGTERM; desktop stdin lifecycle', scope: 'Two isolated services; real CLI, pairing, encrypted task/result transport and Rivloom OpenCode with a deterministic loopback model. No real provider, physical devices or systemd enablement.', ...(failure ? { error: String(failure), diagnostics: failureDiagnostics } : {}) }, null, 2) + '\n');
    process.umask(previousUmask);
  }
  console.log(`Headless task report: ${join(sandbox, 'report.json')}`);
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkHeadlessTask();
