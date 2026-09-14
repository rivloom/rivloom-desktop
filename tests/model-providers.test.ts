import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customProviderSchema, safeOAuthURL, promptVisible } from '../shared/model-providers.ts';
import { ProviderConfigStore } from '../server/provider-config.ts';
import { ProviderOAuth, type OAuthDriver } from '../server/provider-oauth.ts';

const definition = {
  id: 'custom-test',
  name: 'Local service',
  baseURL: 'http://127.0.0.1:9000/v1/',
  protocol: 'chat',
  models: [{ id: 'org/model', name: 'Model' }],
};
test('custom providers accept exact slash model IDs and local endpoints with conservative capacities', () => {
  const parsed = customProviderSchema.parse(definition);
  assert.equal(parsed.baseURL, 'http://127.0.0.1:9000/v1');
  assert.equal(parsed.models[0].id, 'org/model');
  assert.equal(parsed.context, 32768);
  assert.equal(parsed.output, 4096);
});
test('custom provider input rejects credential URLs, executable schemes, config interpolation and prototype IDs', () => {
  for (const baseURL of [
    'file:///secret',
    'javascript:alert(1)',
    'https://user:key@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/#token',
    'https://example.com/{file:secret}',
    'https://example.com/{env:KEY}',
  ])
    assert.equal(
      customProviderSchema.safeParse({ ...definition, baseURL }).success,
      false,
      baseURL,
    );
  for (const id of ['__proto__', 'constructor', '../other', 'has spaces', 'A'])
    assert.equal(customProviderSchema.safeParse({ ...definition, id }).success, false);
  for (const id of ['{file:C:/secret}', '{env:KEY}', '__proto__', 'bad\nmodel'])
    assert.equal(
      customProviderSchema.safeParse({ ...definition, models: [{ id, name: id }] }).success,
      false,
    );
});
test('custom providers reject duplicate models and inconsistent capacity without discarding valid models', () => {
  for (const patch of [
    { models: [] },
    { models: [...definition.models, ...definition.models] },
    { context: 4096, output: 4096 },
    { output: 0 },
    { context: Infinity },
  ])
    assert.equal(customProviderSchema.safeParse({ ...definition, ...patch }).success, false);
});
test('owned config round trips and replaces removed models/providers without touching unrelated definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-provider-test-'));
  try {
    const store = new ProviderConfigStore(root);
    const a = customProviderSchema.parse(definition),
      b = customProviderSchema.parse({
        ...definition,
        id: 'second',
        protocol: 'responses',
        keyless: true,
      });
    store.write([a, b]);
    assert.deepEqual(store.list(), [a, b]);
    const raw = JSON.parse(readFileSync(store.file, 'utf8'));
    assert.equal(raw.provider.second.npm, '@ai-sdk/openai');
    assert.equal(raw.provider.second.options.apiKey, '');
    assert(!Object.hasOwn(raw.provider[a.id].options, 'apiKey'));
    store.write([{ ...a, models: [{ id: 'replacement', name: 'Replacement' }] }, b]);
    const updated = JSON.parse(readFileSync(store.file, 'utf8'));
    assert.deepEqual(Object.keys(updated.provider[a.id].models), ['replacement']);
    store.write([b]);
    assert.deepEqual(store.list(), [b]);
    store.write([]);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('OAuth links accept only HTTPS and conditional prompts respect selected deployment', () => {
  assert.match(safeOAuthURL('https://auth.example.com/authorize?state=test'), /^https:/);
  for (const url of [
    'http://auth.example.com',
    'https://user:pass@example.com',
    'file:///token',
    'javascript:alert(1)',
    'https://example.com/\n',
  ])
    assert.throws(() => safeOAuthURL(url));
  const prompt = {
    type: 'text' as const,
    key: 'domain',
    message: 'Domain',
    when: { key: 'deployment', op: 'eq' as const, value: 'enterprise' },
  };
  assert(promptVisible(prompt, { deployment: 'enterprise' }));
  assert(!promptVisible(prompt, { deployment: 'public' }));
});

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise<void>((r) => setImmediate(r));
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('Timed out');
}
function fixture(mode: 'auto' | 'code' = 'auto', lifetime?: number) {
  const result = deferred<{ type: 'api'; key: string }>();
  let closes = 0,
    commits = 0,
    calls = 0;
  const driver: OAuthDriver = {
    async authorize() {
      return {
        url: 'https://vendor.example/authorize?state=opaque',
        instructions: 'Approve device 1234',
        method: mode,
      };
    },
    async complete() {
      calls++;
      return result.promise;
    },
    async close() {
      closes++;
    },
  };
  const oauth = new ProviderOAuth(
    async () => driver,
    async (_p, auth, _actor, current, accepted) => {
      if (current()) {
        accepted();
        assert.equal(auth.type, 'api');
        commits++;
      }
    },
    () => {},
    lifetime,
  );
  return { oauth, result, stats: () => ({ closes, commits, calls }) };
}
test('OAuth successful completion commits once and hides authorization details from terminal status', async () => {
  const f = fixture();
  const view = f.oauth.begin('owner', 'test', 0, {});
  await until(() => f.oauth.snapshot('owner')?.status === 'waiting');
  assert.equal(f.oauth.snapshot('member'), null);
  assert.throws(() => f.oauth.complete('member', view.id));
  f.oauth.complete('owner', view.id);
  assert.throws(() => f.oauth.complete('owner', view.id));
  f.result.resolve({ type: 'api', key: 'synthetic-secret' });
  await until(() => !f.oauth.busy);
  assert.deepEqual(f.stats(), { commits: 1, calls: 1, closes: 1 });
  assert.equal(f.oauth.snapshot('owner')?.status, 'connected');
  assert(!JSON.stringify(f.oauth.snapshot('owner')).includes('synthetic-secret'));
  assert(!f.oauth.snapshot('owner')?.url);
});
test('OAuth cancellation fences a late successful vendor response and preserves existing credentials', async () => {
  const f = fixture();
  const view = f.oauth.begin('owner', 'test', 0, {});
  await until(() => f.oauth.snapshot('owner')?.status === 'waiting');
  f.oauth.complete('owner', view.id);
  await turn();
  await f.oauth.cancel('owner', view.id);
  f.result.resolve({ type: 'api', key: 'late-secret' });
  await turn();
  assert.equal(f.stats().commits, 0);
  assert.equal(f.stats().closes, 1);
  assert.equal(f.oauth.snapshot('owner')?.status, 'cancelled');
  assert.throws(() => f.oauth.url('owner', view.id));
});
test('OAuth code flow requires a code, times out, closes its driver and does not expose raw errors', async () => {
  const f = fixture('code', 60);
  const view = f.oauth.begin('owner', 'test', 1, {});
  await until(() => f.oauth.snapshot('owner')?.status === 'waiting');
  assert.throws(() => f.oauth.complete('owner', view.id));
  f.oauth.complete('owner', view.id, 'vendor-code');
  f.result.reject(new Error('secret provider response with bearer token'));
  await until(() => !f.oauth.busy);
  assert.equal(f.oauth.snapshot('owner')?.status, 'failed');
  assert(!JSON.stringify(f.oauth.snapshot('owner')).includes('bearer token'));
  const g = fixture('auto', 20);
  g.oauth.begin('owner', 'test', 0, {});
  await until(() => !g.oauth.busy);
  assert.equal(g.stats().closes, 1);
  assert.equal(g.stats().commits, 0);
});
test('OAuth cancellation during engine startup closes the eventual child without starting authorization', async () => {
  const pending = deferred<OAuthDriver>();
  let calls = 0,
    closes = 0;
  const oauth = new ProviderOAuth(
    () => pending.promise,
    async () => assert.fail('Must not commit'),
    () => {},
  );
  const view = oauth.begin('owner', 'test', 0, {});
  const cancelled = oauth.cancel('owner', view.id);
  assert(oauth.busy);
  pending.resolve({
    async authorize() {
      calls++;
      throw Error('Should not authorize');
    },
    async complete() {
      throw Error('Should not complete');
    },
    async close() {
      closes++;
    },
  });
  await cancelled;
  assert.equal(calls, 0);
  assert.equal(closes, 1);
  assert(!oauth.busy);
});

test('OAuth refuses a second attempt when owned process cleanup cannot be confirmed', async () => {
  const oauth = new ProviderOAuth(async () => ({
    async authorize() { return { url: 'https://vendor.example/signin', instructions: '', method: 'auto' as const }; },
    async complete() { return { type: 'api' as const, key: 'synthetic' }; },
    async close() { throw Error('Unconfirmed child exit'); },
  }), async () => {}, () => {});
  const attempt = oauth.begin('owner', 'test', 0, {});
  await until(() => oauth.snapshot('owner')?.status === 'waiting');
  await oauth.cancel('owner', attempt.id);
  assert(oauth.busy);
  assert.throws(() => oauth.begin('owner', 'test', 0, {}));
  assert.match(oauth.snapshot('owner')!.message!, /restart/);
});
