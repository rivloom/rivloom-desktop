// Real Rivloom and pinned OpenCode engines, with only loopback synthetic model traffic.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProviderAccountStore } from '../server/provider-accounts.ts';
import { ProviderConfigStore } from '../server/provider-config.ts';
import type { Task, ModelSettings, User } from '../shared/types.ts';
import type { ProviderAccess } from '../shared/model-providers.ts';

const directory = resolve('.data', 'provider-accounts', String(Date.now()));
mkdirSync(directory, { recursive: true });
const store = new ProviderAccountStore(join(directory, 'engine'));
const a = store.create('opencode-go', 'Go A'),
  b = store.create('opencode-go', 'Go B');
const keys = [0, 1].map(() => 'synthetic-' + randomBytes(16).toString('hex'));
const password = 'Rivloom-' + randomBytes(16).toString('hex');
const modelID = 'rivloom-account-isolation';
const assertions: string[] = [],
  requests: { account: number; session: string; userAgent: string; model: string }[] = [];
const pass = (text: string) => {
  assertions.push(text);
  console.log('PASS', text);
};
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let release!: () => void,
  hold = true;
const gate = new Promise<void>((done) => {
  release = done;
});
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const account = keys.findIndex((key) => req.headers.authorization === 'Bearer ' + key);
  if (account < 0) {
    res.writeHead(401).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({
    account,
    model: body.model,
    session: String(req.headers['x-opencode-session'] || ''),
    userAgent: String(req.headers['user-agent'] || ''),
  });
  if (hold) await gate;
  if (res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: `RIVLOOM_OK ACCOUNT_${account}` }, null],
    [{}, 'stop'],
  ])
    res.write(
      `data: ${JSON.stringify({ id: `chatcmpl-${account}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((done) => mock.listen(0, '127.0.0.1', done));
const address = mock.address();
assert(address && typeof address !== 'string');
for (const account of [a, b])
  new ProviderConfigStore(store.directory(account.id)).write([
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'chat',
      models: [{ id: modelID, name: 'Isolation check' }],
      context: 32768,
      output: 4096,
      keyless: false,
    },
  ]);
let child: ChildProcess | undefined,
  base = '',
  output = '';
async function start() {
  base = '';
  output = '';
  child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const app = await import('./server/index.ts');
    const service = await import('./server/task-service.ts');
    process.on('message', async (message) => {
      if (message !== 'shutdown') return;
      await service.shutdownEngine(true);
      await app.shutdown();
    });
  `,
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, PORT: '0', RIVLOOM_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
    base ||= output.match(/Rivloom: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || '';
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    if (child.exitCode !== null) throw new Error('Isolated application exited: ' + output);
    if (base) {
      const health = await fetch(base + '/api/health')
        .then((r) => r.json())
        .catch(() => null);
      if (health?.engineReady) return;
    }
  }
  throw new Error('Isolated application startup timed out: ' + output);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const target = child;
  target.send('shutdown');
  await Promise.race([
    new Promise<void>((done) => target.once('exit', () => done())),
    sleep(15000),
  ]);
  assert(target.exitCode !== null || target.signalCode !== null, 'Owned application did not exit');
}
class Client {
  cookie = '';
  async call<T>(path: string, body?: unknown, expected = 200): Promise<T> {
    const res = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rivloom-Request': '1',
        Cookie: this.cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (res.headers.has('set-cookie')) this.cookie = res.headers.get('set-cookie')!.split(';')[0];
    const value = await res.json();
    assert.equal(res.status, expected, path + ': ' + JSON.stringify(value));
    return value;
  }
}
const owner = new Client(),
  member = new Client();
const readTask = async (id: string) => (await owner.call<{ task: Task }>('/tasks/' + id)).task;
const until = async (check: () => Promise<boolean>, message: string) => {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(message);
};
try {
  await start();
  const user = await owner.call<User>('/auth/setup', {
    username: 'owner',
    name: 'Account test owner',
    password,
    code: readFileSync(join(directory, 'setup-code.txt'), 'utf8'),
  });
  const invitation = await owner.call<{ code: string }>('/invitations', {});
  await member.call('/auth/join', {
    username: 'member',
    name: 'Account test member',
    password,
    code: invitation.code,
  });
  const credential = (account: typeof a, index: number) => ({
    providerID: 'opencode-go',
    key: keys[index],
    shared: true,
    account: { id: account.id, name: account.name },
  });
  await member.call('/model-settings/provider/key', credential(a, 0), 403);
  await member.call('/model-settings/provider/rename', { id: a.id, name: 'Not allowed' }, 403);
  await owner.call(
    '/model-settings/provider/key',
    { ...credential(a, 0), providerID: 'deepseek' },
    400,
  );
  await owner.call('/model-settings/provider/key', credential(a, 0));
  await owner.call('/model-settings/provider/key', credential(b, 1));
  const catalog = await owner.call<ProviderAccess[]>('/model-settings/providers');
  assert.equal(catalog.filter((p) => p.account?.providerID === 'opencode-go').length, 2);
  const settings = await owner.call<ModelSettings>('/model-settings');
  for (const account of [a, b])
    assert(
      settings.models.some(
        (m) => m.id === `${account.id}/${modelID}` && m.accountName === account.name,
      ),
    );
  assert(!keys.some((key) => JSON.stringify([settings, catalog]).includes(key)));
  for (const [index, account] of [a, b].entries()) {
    const auth = JSON.parse(
      readFileSync(join(store.directory(account.id), 'data/opencode/auth.json'), 'utf8'),
    );
    assert.equal(auth['opencode-go'].key, keys[index]);
    assert(!JSON.stringify(auth).includes(keys[1 - index]));
  }
  pass(
    'Owner-only accounts preserve canonical Go provider IDs, independent keys and public aliases without exposing credentials',
  );
  const tasks: Task[] = [];
  for (const [index, account] of [a, b].entries()) {
    const folder = join(directory, 'project-' + index);
    mkdirSync(folder, { recursive: true });
    const project = await owner.call<{ id: string }>(
      '/projects',
      { name: 'Account ' + index, directory: folder, trusted: true },
      201,
    );
    const task = await owner.call<Task>(
      '/tasks',
      {
        projectID: project.id,
        title: 'Account isolation ' + index,
        description: 'Reply only with RIVLOOM_OK; do not use tools or access files.',
        criteria: 'Synthetic response received',
        assigneeID: user.id,
        approverID: user.id,
        reviewerID: user.id,
        model: `${account.id}/${modelID}`,
        approvalMode: 'ask',
      },
      201,
    );
    await owner.call('/tasks/' + task.id + '/claim', {});
    tasks.push(task);
  }
  await Promise.all(
    tasks.map((task) => owner.call('/tasks/' + task.id + '/run', { confirmed: true })),
  );
  await until(async () => requests.length >= 2, 'Both account requests did not arrive');
  assert.deepEqual(requests.map((r) => r.account).sort(), [0, 1]);
  assert(requests.every((r) => r.model === modelID && r.session && /opencode/i.test(r.userAgent)));
  assert.notEqual(requests[0].session, requests[1].session);
  await owner.call('/model-settings/provider/rename', { id: a.id, name: 'Busy rename' }, 409);
  const firstSession = (await readTask(tasks[0].id)).sessionID;
  await owner.call('/tasks/' + tasks[0].id + '/stop', {});
  assert.equal((await readTask(tasks[0].id)).state, 'stopped');
  assert.equal((await readTask(tasks[1].id)).state, 'running');
  hold = false;
  release();
  await until(
    async () => (await readTask(tasks[1].id)).state === 'accepted',
    'Account B stopped with A',
  );
  await owner.call('/tasks/' + tasks[0].id + '/run', {
    confirmed: true,
    addition: 'Continue and reply only with RIVLOOM_OK.',
  });
  await until(
    async () =>
      (await Promise.all(tasks.map((t) => readTask(t.id)))).every((t) => t.state === 'accepted'),
    'Tasks did not reconcile to completion',
  );
  for (const [index, task] of tasks.entries())
    assert((await readTask(task.id)).messages.some((m) => m.text.includes('ACCOUNT_' + index)));
  assert.equal((await readTask(tasks[0].id)).sessionID, firstSession);
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1)?.account, 0);
  pass(
    'Concurrent tasks, stop and resume retain their own account/session, canonical Go headers and isolated event reconciliation',
  );
  await owner.call('/model-settings/provider/rename', { id: a.id, name: 'Go Renamed' });
  await owner.call('/model-settings/default', { model: `${b.id}/${modelID}` });
  await stop();
  await start();
  await owner.call('/auth/login', { username: 'owner', password });
  const restarted = await owner.call<ModelSettings>('/model-settings');
  assert.equal(restarted.defaultModel, `${b.id}/${modelID}`);
  assert(
    restarted.models.some((m) => m.id === `${a.id}/${modelID}` && m.accountName === 'Go Renamed'),
  );
  assert((await readTask(tasks[0].id)).messages.some((m) => m.text.includes('ACCOUNT_0')));
  pass(
    'Aliases, default model, credentials and task history survive a real application and engine restart',
  );
  await owner.call('/model-settings/provider/remove', { providerID: a.id, confirmed: true });
  const remaining = await owner.call<ModelSettings>('/model-settings');
  assert(!remaining.models.some((m) => m.providerID === a.id));
  assert(remaining.models.some((m) => m.id === `${b.id}/${modelID}`));
  assert.equal(remaining.defaultModel, `${b.id}/${modelID}`);
  const removedAuth = JSON.parse(
    readFileSync(join(store.directory(a.id), 'data/opencode/auth.json'), 'utf8'),
  );
  assert(!removedAuth['opencode-go']);
  await owner.call('/model-settings/test', { model: `${b.id}/${modelID}`, confirmed: true }, 202);
  await until(
    async () =>
      (await owner.call<ModelSettings>('/model-settings')).checks[`${b.id}/${modelID}`]?.status ===
      'passed',
    'Remaining account connection test failed',
  );
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1)?.account, 1);
  pass(
    'Removing one account clears only its credential and models; another account still completes an official engine request',
  );
  const mainAuth = join(directory, 'engine/data/opencode/auth.json');
  if (existsSync(mainAuth)) assert(!keys.some((k) => readFileSync(mainAuth, 'utf8').includes(k)));
} finally {
  hold = false;
  release();
  await stop();
  mock.closeAllConnections();
  await new Promise<void>((done) => mock.close(() => done()));
  const proof = resolve('.data/verification/provider-accounts.json');
  mkdirSync(join(proof, '..'), { recursive: true });
  writeFileSync(
    proof,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: assertions.length === 4 ? 'passed' : 'failed',
        assertions,
        requests: requests.map(({ account, model, session, userAgent }) => ({
          account,
          model,
          hasSession: !!session,
          officialUserAgent: /opencode/i.test(userAgent),
        })),
        scope:
          'Isolated application and pinned official engines; loopback synthetic service only; no real accounts or paid model calls',
      },
      null,
      2,
    ),
  );
}
