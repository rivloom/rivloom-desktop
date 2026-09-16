// Real application + official OpenCode. Model checks use a loopback synthetic service only.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { Bootstrap, ModelSettings, User } from '../shared/types.ts';
import type { ProviderAccess } from '../shared/model-providers.ts';
import { createServer } from 'node:http';

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
const requests: { path: string; model: string; authorization?: string }[] = [];
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || !/\/(chat\/completions|responses)$/.test(req.url || '')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ path: req.url!, model: body.model, authorization: req.headers.authorization });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (req.url!.endsWith('/responses')) {
    let sequence = 0;
    const event = (type: string, value: object) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
      );
    const response = {
      id: 'resp_rivloom',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: body.model,
      status: 'in_progress',
      output: [],
    };
    const part = { type: 'output_text', text: 'RIVLOOM_OK', annotations: [], logprobs: [] };
    const item = {
      id: 'msg_rivloom',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [part],
    };
    event('response.created', { response });
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    });
    event('response.content_part.added', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    });
    event('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: part.text,
      logprobs: [],
    });
    event('response.output_text.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: part.text,
    });
    event('response.content_part.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', {
      response: {
        ...response,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    res.end();
    return;
  }
  const chunk = (delta: object, reason: string | null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl-rivloom', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
    );
  chunk({ role: 'assistant', content: 'RIVLOOM_OK' }, null);
  chunk({}, 'stop');
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((done) => mock.listen(0, '127.0.0.1', done));
const address = mock.address();
assert(address && typeof address !== 'string');
const localBase = `http://127.0.0.1:${address.port}/v1`;
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

  const catalog = await owner.call<ProviderAccess[]>('/model-settings/providers');
  assert(catalog.find((p) => p.id === 'openai')?.oauth.some((m) => m.label.includes('ChatGPT')));
  assert(catalog.find((p) => p.id === 'github-copilot')?.oauth[0]?.prompts.length);
  assert(catalog.find((p) => p.id === 'deepseek')?.apiKey);
  assert.equal(await owner.call('/model-settings/oauth'), null);
  await member.call('/model-settings/oauth', undefined, 403);
  await member.call(
    '/model-settings/provider/key',
    { providerID: 'openai', key: fakeKey, shared: true },
    403,
  );
  await member.call(
    '/model-settings/oauth/start',
    { providerID: 'openai', method: 0, shared: true },
    403,
  );
  await owner.call(
    '/model-settings/oauth/start',
    { providerID: 'deepseek', method: 0, shared: true },
    400,
  );
  pass('Catalog exposes official OAuth methods and restricts sign-in and keys to the owner');

  const definition = {
    id: 'rivloom-local-check',
    name: 'Local verification',
    baseURL: localBase,
    protocol: 'chat',
    models: [{ id: 'org/check-model', name: 'Check model' }],
    keyless: false,
  };
  const customBody = { provider: definition, key: fakeKey, shared: true };
  await member.call('/model-settings/provider/custom', customBody, 403);
  await owner.call(
    '/model-settings/provider/custom',
    { ...customBody, provider: { ...definition, id: 'openai' } },
    409,
  );
  await owner.call(
    '/model-settings/provider/custom',
    { ...customBody, provider: { ...definition, baseURL: 'https://example.com/{file:secrets}' } },
    400,
  );
  const custom = await owner.call<ModelSettings>('/model-settings/provider/custom', customBody);
  const localModel = `${definition.id}/org/check-model`;
  assert(custom.models.some((m) => m.id === localModel));
  const displayModel = custom.models.find((m) => m.id === localModel)!;
  assert.equal(displayModel.providerID, definition.id);
  assert.equal(displayModel.providerName, definition.name);
  assert.equal(displayModel.modelName, definition.models[0].name);
  assert.equal(displayModel.contextWindow, 32768);
  assert.equal(displayModel.supportsImages, false);
  const bootstrap = await owner.call<Bootstrap>('/bootstrap');
  assert.deepEqual(bootstrap.engine.models.find((m) => m.id === localModel), displayModel);
  pass('Provider identity, context and image input metadata reach settings and the development bootstrap without credentials');
  assert.equal(requests.length, 0);
  assert(!JSON.stringify(await owner.call('/model-settings/providers')).includes(fakeKey));
  assert(!readFileSync(join(directory, 'engine', 'rivloom-providers.json')).includes(fakeKey));
  pass(
    'Custom provider configuration exposes a slash-containing model without sending a model request or exposing its key',
  );

  async function checkLocal(model: string) {
    await owner.call('/model-settings/test', { model, confirmed: true }, 202);
    await owner.call(
      '/model-settings/provider/remove',
      { providerID: definition.id, confirmed: true },
      409,
    );
    for (let i = 0; i < 120; i++) {
      const status = await owner.call<ModelSettings>('/model-settings');
      const result = status.checks[model];
      if (result && result.status !== 'testing' && !status.busy) {
        assert.equal(result.status, 'passed', result.message);
        return;
      }
      await sleep(500);
    }
    assert.fail('Local model check timed out');
  }
  await checkLocal(localModel);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'org/check-model');
  assert.equal(requests[0].authorization, `Bearer ${fakeKey}`);
  pass(
    'Official engine successfully calls the local Chat Completions endpoint with exact model ID and authorization',
  );

  const edited = {
    ...definition,
    protocol: 'responses',
    models: [{ id: 'replacement', name: 'Replacement model' }],
  };
  const updated = await owner.call<ModelSettings>('/model-settings/provider/custom', {
    provider: edited,
    shared: true,
  });
  assert(!updated.models.some((m) => m.id === localModel));
  assert(updated.models.some((m) => m.id === `${definition.id}/replacement`));
  assert(!updated.checks[localModel]);
  await checkLocal(`${definition.id}/replacement`);
  assert.equal(requests[1].authorization, `Bearer ${fakeKey}`);
  assert.equal(requests[1].path, '/v1/responses');
  pass(
    'Editing removes stale models, preserves the existing key and successfully switches the official engine to Responses',
  );

  const keyless = await owner.call<ModelSettings>('/model-settings/provider/custom', {
    provider: { ...edited, keyless: true },
    shared: true,
  });
  assert(keyless.models.some((m) => m.id === `${definition.id}/replacement`));
  await checkLocal(`${definition.id}/replacement`);
  assert.notEqual(requests[2].authorization, `Bearer ${fakeKey}`);
  assert(
    !readFileSync(join(directory, 'engine', 'data', 'opencode', 'auth.json')).includes(fakeKey),
  );
  pass(
    'Keyless local services work through the official engine and switching to keyless removes the old credential',
  );

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
  assert(afterRestart.models.some((m) => m.id === `${definition.id}/replacement`));
  assert(
    (await owner.call<ProviderAccess[]>('/model-settings/providers')).find(
      (p) => p.id === definition.id,
    )?.custom?.keyless,
  );
  await owner.call('/model-settings/default', { model: `${definition.id}/replacement` });
  const customRemoved = await owner.call<ModelSettings>('/model-settings/provider/remove', {
    providerID: definition.id,
    confirmed: true,
  });
  assert(!customRemoved.models.some((m) => m.id.startsWith(definition.id + '/')));
  assert(!customRemoved.defaultModel.startsWith(definition.id + '/'));
  assert(
    !(await owner.call<ProviderAccess[]>('/model-settings/providers')).some(
      (p) => p.id === definition.id,
    ),
  );
  assert.equal(requests.length, 3);
  pass(
    'Custom definitions persist across restart and removal clears models and default without further requests',
  );

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
        kind: 'real-app / official-opencode / synthetic-local-model-only',
        engineVersion: '1.18.25',
        deepseekModelsSeen: configured.models.filter((model) => model.id.startsWith('deepseek/'))
          .length,
        assertions,
        limits: [
          'No real DeepSeek API key was supplied, so a successful DeepSeek model response is not claimed.',
          'Three official engine checks used a loopback synthetic endpoint. No real provider model request or quota was used.',
          'OAuth catalog and application authorization are real; no real vendor account was signed in.',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Proof:', proofFile);
} finally {
  await stop();
  await new Promise<void>((done) => mock.close(() => done()));
}
