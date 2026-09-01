// Real application + official OpenCode auth/provider APIs; no model request and no mocks.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { ModelSettings, User } from '../shared/types.ts';

const directory = resolve('.data', 'model-settings', String(Date.now()));
const proofFile = resolve('.data', 'verification', 'model-settings.json');
mkdirSync(directory, { recursive: true });
mkdirSync(resolve('.data', 'verification'), { recursive: true });
const fakeKey = 'sk-rivloom-check-' + randomBytes(18).toString('hex');
const password = 'Rivloom-' + randomBytes(18).toString('hex');
let child: ChildProcess;
let base = '';
let output = '';
const assertions: string[] = [];
const pass = (value: string) => {
  assertions.push(value);
  console.log('PASS', value);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function start() {
  output = '';
  base = '';
  child = spawn(process.execPath, ['server/index.ts'], {
    cwd: process.cwd(),
    windowsHide: true,
    env: { ...process.env, PORT: '0', RIVLOOM_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-5000);
    base ||= output.match(/Rivloom: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || '';
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  for (let index = 0; index < 100; index++) {
    await sleep(300);
    if (child.exitCode !== null) throw new Error('Server startup failed: ' + output);
    if (!base) continue;
    try {
      const health = await fetch(base + '/api/health').then((response) => response.json());
      if (health.engineReady) return;
    } catch {
      // Keep waiting for the loopback app and bundled engine.
    }
  }
  throw new Error('Server or engine did not become ready: ' + output);
}

async function stop() {
  const target = child;
  if (!target || target.exitCode !== null) return;
  target.kill('SIGINT');
  await Promise.race([new Promise<void>((done) => target.once('exit', () => done())), sleep(7000)]);
  let alive = false;
  if (target.pid)
    try {
      process.kill(target.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  if (alive && target.pid) {
    execFileSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await Promise.race([
      new Promise<void>((done) => target.once('exit', () => done())),
      sleep(3000),
    ]);
  }
  let stillRunning = false;
  if (target.pid)
    try {
      process.kill(target.pid, 0);
      stillRunning = true;
    } catch {
      stillRunning = false;
    }
  assert(!stillRunning, 'Server did not stop');
}

class Client {
  cookie = '';
  user!: User;
  async call<T>(path: string, body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rivloom-Request': '1',
        Cookie: this.cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.has('set-cookie'))
      this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
}

const owner = new Client();
const member = new Client();
try {
  await start();
  owner.user = await owner.call('/auth/setup', {
    username: 'owner',
    name: '工作区创建者',
    password,
    code: readFileSync(join(directory, 'setup-code.txt'), 'utf8'),
  });
  const invitation = await owner.call<{ code: string }>('/invitations', {});
  member.user = await member.call('/auth/join', {
    username: 'member',
    name: '协作成员',
    password,
    code: invitation.code,
  });

  const initial = await owner.call<ModelSettings>('/model-settings');
  assert.equal(initial.credentialState, 'unconfigured');
  assert(initial.models.some((model) => model.id === 'opencode/mimo-v2.5-free'));
  assert(!JSON.stringify(initial).includes(fakeKey));
  pass('Initial status is readable without a provider key and exposes the free engine model');

  await member.call('/model-settings/deepseek', { key: fakeKey, shared: true }, 403);
  await member.call('/model-settings/default', { model: initial.defaultModel }, 403);
  await owner.call(
    '/model-settings/deepseek',
    { key: 'contains spaces and is invalid', shared: true },
    400,
  );
  pass('Only the owner can mutate settings and malformed credentials are rejected');

  const configured = await owner.call<ModelSettings>('/model-settings/deepseek', {
    key: fakeKey,
    shared: true,
  });
  assert(configured.deepseekConfigured);
  assert.equal(configured.credentialState, 'configured_unverified');
  const deepseekModel = configured.models.find((model) => model.id.startsWith('deepseek/'));
  assert(deepseekModel, 'OpenCode did not expose DeepSeek models after auth.set');
  assert(!JSON.stringify(configured).includes(fakeKey));
  assert(!readFileSync(join(directory, 'rivloom.sqlite')).includes(fakeKey));
  assert(
    readFileSync(join(directory, 'engine', 'data', 'opencode', 'auth.json')).includes(fakeKey),
  );
  pass(
    'Official OpenCode auth.set configures DeepSeek while the Rivloom database and response omit the key',
  );

  const selected = await owner.call<ModelSettings>('/model-settings/default', {
    model: deepseekModel.id,
  });
  assert.equal(selected.defaultModel, deepseekModel.id);
  assert(selected.operations.some((item) => item.kind === 'credential_saved'));
  assert(selected.operations.some((item) => item.kind === 'default_changed'));
  assert(!JSON.stringify(selected.operations).includes(fakeKey));
  pass('Default model and sanitized local audit records persist without a model call');

  await stop();
  await start();
  const afterRestart = await owner.call<ModelSettings>('/model-settings');
  assert(afterRestart.deepseekConfigured);
  assert.equal(afterRestart.defaultModel, deepseekModel.id);
  pass('Credential metadata and default model survive a clean application restart');

  const removed = await owner.call<ModelSettings>('/model-settings/deepseek/remove', {
    confirmed: true,
  });
  assert(!removed.deepseekConfigured);
  assert.equal(removed.credentialState, 'unconfigured');
  assert(
    !readFileSync(join(directory, 'engine', 'data', 'opencode', 'auth.json')).includes(fakeKey),
  );
  assert(!readFileSync(join(directory, 'rivloom.sqlite')).includes(fakeKey));
  pass(
    'Official OpenCode auth.remove disconnects DeepSeek and leaves no key in engine auth or business data',
  );

  writeFileSync(
    proofFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        kind: 'real-app / official-opencode-auth-and-provider-api / no-model-request',
        engineVersion: '1.18.25',
        deepseekModelsSeen: configured.models.filter((model) => model.id.startsWith('deepseek/'))
          .length,
        assertions,
        limits: [
          'No real DeepSeek API key was supplied, so a successful DeepSeek model response is not claimed.',
          'This check deliberately did not call any model and therefore did not consume provider quota.',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Proof:', proofFile);
} finally {
  await stop();
}
