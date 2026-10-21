// Real CLI -> local headless API -> Rivloom engine; isolated data and a loopback provider only.
import assert from 'node:assert/strict';
import { readEngineSource } from '../server/engine-artifact.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { listenHttp } from '../server/http-ports.ts';
import { parseMacosEngineStopDiagnostic } from '../server/macos-process.mjs';
import { testEnvironment } from './ci-workspace.ts';
import type { ModelSettings, NodeExecutionPolicy, NodeNetwork, Project, RivloomNode } from '../shared/types.ts';

type Status = { online: boolean; node: RivloomNode | null; network: Pick<NodeNetwork, 'status' | 'error'>; engine: { ready: boolean; version: string; error?: string }; executionPolicy: NodeExecutionPolicy; queue: { paused: boolean } };
type ReadinessEvidence = { polls: number; phase: 'control' | 'health' | 'status'; control: 'pending' | 'read' | 'missing' | 'unavailable';
  health?: { httpStatus?: number; engineReady?: boolean; failure?: 'timeout' | 'network' | 'invalid-response' };
  status?: { attempts: number; outcome: 'pending' | 'read' | 'timeout' | 'launch' | 'exit' | 'invalid-response' | 'unavailable'; exitCode?: number } };

function cliFailure(error: unknown): NonNullable<ReadinessEvidence['status']>['outcome'] {
  const value = (error as { cliFailure?: unknown } | null)?.cliFailure;
  return ['timeout', 'launch', 'exit', 'invalid-response'].includes(String(value)) ? value as 'timeout' | 'launch' | 'exit' | 'invalid-response' : 'unavailable';
}

function statusEvidence(status: Status) {
  return { online: status.online === true, identityPresent: !!status.node,
    network: ['starting', 'online', 'degraded', 'disabled'].includes(status.network?.status) ? status.network.status : 'invalid',
    networkErrorPresent: !!status.network?.error, engineReady: status.engine?.ready === true,
    engineError: !status.engine?.error ? 'none' : status.engine.error === 'OpenCode 服务已退出，请重启应用。' ? 'host-exited'
      : status.engine.error === 'OpenCode 启动失败。检查系统架构和已锁定的引擎安装；重启应用后再试。' ? 'initialization-failed' : 'reported' };
}

export async function checkHeadlessService(root = resolve(import.meta.dirname, '..')) {
  const base = join(root, 'test-results', 'headless-service');
  await mkdir(base, { recursive: true });
  const sandbox = await mkdtemp(join(base, 'check-'));
  const data = join(sandbox, 'data'), home = join(sandbox, 'home'), project = join(sandbox, 'project');
  await mkdir(home); await mkdir(project);
  const environment = { ...testEnvironment(sandbox), HOME: home, USERPROFILE: home, RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
  const cli = join(root, 'cli', 'index.ts');
  const checks: string[] = [];
  const pass = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
  let child: ChildProcess | undefined, serverOutput = '', modelRequests = 0;
  const readiness: ReadinessEvidence[] = [];
  let failureStatus: object | undefined;
  const fixture = createServer((request, response) => {
    if (request.url?.includes('/chat/completions') || request.url?.includes('/responses')) modelRequests++;
    response.writeHead(404).end();
  });
  await listenHttp(fixture, '127.0.0.1');
  const address = fixture.address(); assert(address && typeof address !== 'string');
  async function run<T = unknown>(args: string[], input?: unknown, timeoutMs = 120_000): Promise<T> {
    return new Promise<T>((done, reject) => {
      const processChild = spawn(process.execPath, [cli, '--data-dir', data, ...args], { cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL'); }, timeoutMs);
      processChild.stdout.on('data', chunk => { output += chunk; });
      processChild.stderr.resume();
      processChild.once('error', () => { clearTimeout(timeout); reject(Object.assign(new Error(`CLI ${args[0]} could not start`), { cliFailure: 'launch' })); });
      processChild.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(Object.assign(new Error(`CLI ${args[0]} failed (${code})`), { cliFailure: timedOut ? 'timeout' : 'exit', exitCode: code })); return; }
        try { done(JSON.parse(output) as T); } catch { reject(Object.assign(new Error(`CLI ${args[0]} did not return JSON`), { cliFailure: 'invalid-response' })); }
      });
      processChild.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function start() {
    const evidence: ReadinessEvidence = { polls: 0, phase: 'control', control: 'pending' };
    readiness.push(evidence);
    // Windows cannot deliver POSIX SIGTERM. A test-only IPC wrapper calls the same
    // exported shutdown; Linux runs the actual CLI entry and receives SIGTERM.
    const script = `await (await import(${JSON.stringify(pathToFileURL(cli).href)})).main(['--data-dir',${JSON.stringify(data)},'serve']); process.once('message', async message => { if (message === 'shutdown') await (await import(${JSON.stringify(pathToFileURL(join(root, 'server/index.ts')).href)})).shutdown(); });`;
    child = spawn(process.execPath, process.platform === 'win32' ? ['--input-type=module', '-e', script] : [cli, '--data-dir', data, 'serve'], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.on('data', chunk => { serverOutput += chunk; });
    child.stderr!.on('data', chunk => { serverOutput += chunk; });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      evidence.polls++;
      assert.equal(child.exitCode, null, 'Headless exited during startup');
      let url: string | undefined;
      try {
        evidence.phase = 'control';
        const control = JSON.parse(await readFile(join(data, 'headless-control.json'), 'utf8')) as { url: string };
        url = control.url;
        evidence.control = 'read';
      } catch (error) { evidence.control = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'; }
      let engineReady = false;
      if (url) try {
        evidence.phase = 'health';
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
        evidence.health = { httpStatus: response.status };
        const health = await response.json() as { engineReady: boolean };
        if (!health || typeof health.engineReady !== 'boolean') evidence.health.failure = 'invalid-response';
        else { evidence.health.engineReady = health.engineReady; engineReady = health.engineReady; }
      } catch (error) {
        const name = (error as Error).name;
        evidence.health = { ...evidence.health, failure: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name === 'SyntaxError' ? 'invalid-response' : 'network' };
      }
      if (engineReady) {
        evidence.phase = 'status';
        evidence.status = { attempts: (evidence.status?.attempts || 0) + 1, outcome: 'pending' };
        try {
          const status = await run<Status>(['status']);
          evidence.status.outcome = 'read';
          return status;
        } catch (error) {
          evidence.status.outcome = cliFailure(error);
          const exitCode = (error as { exitCode?: unknown }).exitCode;
          if (Number.isSafeInteger(exitCode)) evidence.status.exitCode = Number(exitCode);
        }
      }
      await delay(250);
    }
    throw new Error('Headless readiness timeout');
  }
  async function stop() {
    assert(child && child.exitCode === null && child.signalCode === null, 'Headless stopped unexpectedly');
    const stopped = new Promise<{ code: number | null; signal: string | null }>(done => child!.once('exit', (code, signal) => done({ code, signal })));
    if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM');
    const result = await Promise.race([stopped, delay(25_000, null, { ref: false })]);
    if (!result) { child.kill('SIGKILL'); throw new Error('Headless did not stop normally'); }
    assert.equal(result.code, 0, 'Headless shutdown failed');
    await assert.rejects(readFile(join(data, 'headless-control.json')), { code: 'ENOENT' });
  }
  let failure: unknown;
  try {
    await run(['init', '--name', 'CLI integration node']);
    const first = await start();
    assert(first.node, `Headless node identity unavailable: network=${['starting', 'online', 'degraded', 'disabled'].includes(first.network.status) ? first.network.status : 'invalid'}, error=${first.network.error ? 'reported' : 'none'}`);
    assert(first.online && first.engine.ready && first.node.id);
    assert.equal(first.engine.version, readEngineSource(root).version);
    assert.equal(first.node.name, 'CLI integration node');
    assert.equal(first.executionPolicy.enabled, false);
    pass('CLI init/serve/status starts an isolated node with execution disabled');

    await run(['name', 'CLI renamed']);
    assert.equal((await run<Status>(['status'])).node?.name, 'CLI renamed');
    const pairings = await run<{ pairings: unknown[] }>(['pair', 'list']);
    assert.deepEqual(pairings.pairings, []);
    pass('CLI node rename and pair list use the live API');

    const created = await run<Project>(['projects', 'add', project, '--name', 'CLI test project', '--confirm']);
    assert(created.id);
    assert((await run<Project[]>(['projects', 'list'])).some(item => item.id === created.id));
    await run(['queue', 'pause']);
    assert.equal((await run<Status>(['status'])).queue.paused, true);
    await run(['queue', 'resume']);
    assert.equal((await run<Status>(['status'])).queue.paused, false);
    await run(['execution', 'disable']);
    assert.deepEqual(await run(['pending']), []);
    pass('CLI project authorization, queue pause/resume and empty pending requests follow API schemas');

    await run(['providers', 'custom', '--stdin', '--confirm'], { provider: { id: 'headless-fixture', name: 'Headless loopback fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, protocol: 'chat', models: [{ id: 'fixture', name: 'Synthetic model' }], context: 32768, output: 4096, keyless: true } });
    await run(['providers', 'list']);
    const settings = await run<ModelSettings>(['models', 'list']);
    const model = settings.models.find(item => item.id === 'headless-fixture/fixture'); assert(model, 'Custom provider did not supply a model');
    await run(['models', 'default', model.id]);
    await run(['execution', 'enable', '--project', created.id, '--model', model.id, '--approval', 'ask', '--confirm']);
    await run(['execution', 'concurrency', '2']);
    const policy = await run<NodeExecutionPolicy>(['execution', 'status']);
    assert.equal(policy.enabled, true); assert.equal(policy.approvalMode, 'ask'); assert.equal(policy.maxConcurrent, 2);
    await run(['execution', 'disable']);
    assert.equal(modelRequests, 0);
    pass('CLI stdin provider configuration, model choice and explicit execution policy need no model calls');

    await stop();
    const second = await start();
    assert(second.node, `Restarted headless node identity unavailable: network=${['starting', 'online', 'degraded', 'disabled'].includes(second.network.status) ? second.network.status : 'invalid'}, error=${second.network.error ? 'reported' : 'none'}`);
    assert.equal(second.engine.version, readEngineSource(root).version);
    assert.equal(second.node.id, first.node.id);
    assert.equal(second.node.name, 'CLI renamed');
    assert.equal(second.executionPolicy.enabled, false);
    assert.equal(second.executionPolicy.maxConcurrent, 2);
    assert((await run<Project[]>(['projects', 'list'])).some(item => item.id === created.id));
    assert.equal((await run<ModelSettings>(['models', 'list'])).defaultModel, model.id);
    await stop();
    assert.equal(modelRequests, 0);
    pass('CLI restart preserves node identity, profile, project, model and disabled execution policy');
  } catch (error) {
    failure = error;
    // One bounded read-only observation after failure; it does not retry any test action.
    try { failureStatus = statusEvidence(await run<Status>(['status'], undefined, 5000)); }
    catch (statusError) { failureStatus = { outcome: cliFailure(statusError) }; }
  }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { await stop(); } catch { child.kill('SIGKILL'); }
    }
    fixture.closeAllConnections();
    await new Promise<void>(done => fixture.close(() => done()));
    await writeFile(join(sandbox, 'server.log'), serverOutput);
    const diagnostics = { readiness, status: failureStatus,
      markers: { listener: serverOutput.includes('RIVLOOM_HEADLESS_READY '), engineHealth: serverOutput.includes('RIVLOOM_ENGINE_READY ') },
      macosStops: serverOutput.split(/\r?\n/).map(parseMacosEngineStopDiagnostic).filter(value => value !== undefined).slice(-8) };
    if (failure) console.error('HEADLESS_SERVICE_DIAGNOSTIC', JSON.stringify(diagnostics));
    await writeFile(join(sandbox, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, modelRequests, engineVersion: readEngineSource(root).version, platform: process.platform, arch: process.arch, dataDirectory: data, shutdown: process.platform === 'win32' ? 'test-only IPC -> exported shutdown' : 'SIGTERM', scope: 'Isolated real CLI/API/Rivloom engine configuration and restart. No model inference, user data, systemd changes or physical LAN.', ...(failure ? { error: String(failure), diagnostics } : {}) }, null, 2) + '\n');
  }
  if (failure) throw failure;
  console.log(`Headless service report: ${join(sandbox, 'report.json')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkHeadlessService();
