// Two isolated services, the Rivloom OpenCode engine, and a deterministic loopback model.
import assert from 'node:assert/strict';
import { readEngineSource } from '../server/engine-artifact.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bootstrap, ModelSettings, NodeNetwork, NodePairing, Project, Task } from '../shared/types.ts';
import { taskFileMime, type TaskFileConversation, type TaskFileDescriptor } from '../shared/task-files.ts';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';
import { testEnvironment } from './ci-workspace.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';

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
    logs = '';
    constructor(name: string, headless: boolean) { super(join(sandbox, name)); this.headless = headless; }
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
    await Promise.all([origin.launch(), worker.launch()]);
    const originID = (await origin.network()).local!.id, workerID = (await worker.network()).local!.id;
    const project = await cliCommand<Project>(['projects', 'add', projectDirectory, '--name', 'Headless execution fixture', '--confirm']);
    assert((await cliCommand<ModelSettings>(['models', 'list'])).models.some(model => model.id === 'fixture/m34'));
    await cliCommand(['models', 'default', 'fixture/m34']);
    await cliCommand(['execution', 'enable', '--project', project.id, '--model', 'fixture/m34', '--approval', 'ask', '--confirm']);
    await cliCommand(['execution', 'concurrency', '1']);
    pass('The worker is configured through the real CLI with an isolated project, loopback model and explicit ask policy');

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
    const sent = await origin.call<NodeNetwork & { createdTaskID: string }>(route, request, 201);
    const remoteID = sent.createdTaskID; assert(remoteID);
    const pending = await until(() => worker.bootstrap(), state => {
      const task = taskFor(state, remoteID);
      if (task?.state === 'failed') throw new Error(`Official task failed: ${task.error}`);
      return task?.state === 'waiting_approval' && task.approvals.length > 0;
    }, 'official write permission request', 90_000);
    const localTask = taskFor(pending, remoteID)!;
    assert(!existsSync(outputPath), 'File must not be written before permission approval');
    const cliPending = await cliCommand<{ taskID: string; approvals: Task['approvals'] }[]>(['pending']);
    assert(cliPending.find(task => task.taskID === localTask.id)?.approvals.some(approval => approval.id === localTask.approvals[0].id));
    await cliCommand(['approve', localTask.id, localTask.approvals[0].id, 'once']);
    const complete = await until(() => worker.bootstrap(), state => taskFor(state, remoteID)?.state === 'accepted', 'official task completion', 90_000);
    const completedTask = taskFor(complete, remoteID)!;
    assert.equal(readFileSync(outputPath, 'utf8'), outputText);
    assert(completedTask.sessionID);
    const received = await until(() => origin.network(), network => network.remoteTasks.some(task => task.id === remoteID && task.executionState === 'accepted' && task.executionSummary.includes(completionText)), 'origin completion summary');
    assert(received.remoteTasks.find(task => task.id === remoteID)!.executionSummary.includes(completionText));
    pass('An actual Rivloom-engine write waits for CLI approval, then completes and returns its summary to the desktop origin', { remoteID, localTaskID: completedTask.id, sessionID: completedTask.sessionID });

    // Explicitly select the file that OpenCode actually wrote, using the existing
    // result-attachment API; this does not claim all arbitrary output files auto-publish.
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
    await worker.stop();
    await worker.launch();
    await Promise.all([waitChannel(origin, workerID), waitChannel(worker, originID)]);
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
  } catch (error) { failure = error; }
  finally {
    for (const node of [worker, origin]) {
      try { await node.stop(); } catch (error) { failure ||= error; }
      writeFileSync(join(sandbox, node.headless ? 'worker.log' : 'origin.log'), node.logs);
    }
    await fixture.close();
    writeFileSync(join(sandbox, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, engineVersion: readEngineSource(root).version, platform: process.platform, arch: process.arch, modelRequests: fixture.requests, discoveryPort, shutdown: process.platform === 'win32' ? 'headless test IPC -> exported shutdown; desktop stdin lifecycle' : 'headless SIGTERM; desktop stdin lifecycle', scope: 'Two isolated services; real CLI, pairing, encrypted task/result transport and Rivloom OpenCode with a deterministic loopback model. No real provider, physical devices or systemd enablement.', ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n');
    process.umask(previousUmask);
  }
  console.log(`Headless task report: ${join(sandbox, 'report.json')}`);
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkHeadlessTask();
