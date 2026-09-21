import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { engineEnv } from '../server/engine.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  customProviderSchema,
  safeOAuthURL,
  promptVisible,
  type ProviderAccess,
} from '../shared/model-providers.ts';
import {
  PROVIDER_PLATFORMS,
  nativePlatformProvider,
  platformCustomDraft,
  providerSearchText,
  providerApiRank,
} from '../src/provider-platforms.ts';
import { ProviderConfigStore } from '../server/provider-config.ts';
import { ProviderOAuth, type OAuthDriver } from '../server/provider-oauth.ts';
import { availableModels, type AvailableModel } from '../shared/model-catalog.ts';
import { reasoningPromptOptions, validReasoningEffort, reasoningForMessage } from '../shared/model-reasoning.ts';
import { formatContextWindow, groupModels, modelDetails } from '../src/model-options.ts';
import { ProviderAccountStore } from '../server/provider-accounts.ts';
import { AccountEnginePool } from '../server/account-engines.ts';
import { EventEmitter } from 'node:events';
import { resolve, sep } from 'node:path';

const platformAccess = (id: string, extra: Partial<ProviderAccess> = {}): ProviderAccess => ({
  id,
  name: id,
  connected: false,
  modelCount: 0,
  apiKey: true,
  oauth: [],
  ...extra,
});

test('fresh engine disables implicit Zen while explicit credentials and scoped accounts remain usable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-zen-test-'));
  try {
    const config = (providerID?: string) => JSON.parse(engineEnv(undefined, root, { providerID }).OPENCODE_CONFIG_CONTENT!);
    assert.deepEqual(config().disabled_providers, ['opencode']);
    mkdirSync(join(root, 'data', 'opencode'), { recursive: true });
    const auth = join(root, 'data', 'opencode', 'auth.json');
    for (const value of ['broken', '{}', JSON.stringify({ opencode: { type: 'api', key: '  ' } })]) {
      writeFileSync(auth, value);
      assert.deepEqual(config().disabled_providers, ['opencode']);
    }
    writeFileSync(auth, JSON.stringify({ opencode: { type: 'api', key: 'synthetic-zen-key' } }));
    assert.deepEqual(config().disabled_providers, []);
    writeFileSync(auth, '{}');
    for (const id of ['opencode', 'deepseek']) {
      const scoped = config(id);
      assert.deepEqual(scoped.enabled_providers, [id]);
      assert.equal(scoped.disabled_providers, undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('thinking choices come from runtime variants and expose no provider parameters', () => {
  const models = availableModels([{ id: 'openrouter', name: 'OpenRouter', models: { one: {
    id: 'org/model', name: 'One', limit: { context: 32000 }, capabilities: { input: { image: false } },
    variants: { low: { reasoning: { effort: 'low' } }, high: { reasoning: { effort: 'high' }, private: 'hidden' },
      removed: { disabled: true }, 'invalid value': {}, default: {}, auto: {} },
  } } }] as unknown as Parameters<typeof availableModels>[0], ['openrouter']);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']);
  assert(!JSON.stringify(models).includes('hidden'));
  assert.deepEqual(reasoningPromptOptions(models[0], 'high'), { variant: 'high' });
  assert.deepEqual(reasoningPromptOptions(models[0], null), {});
  assert.deepEqual(reasoningPromptOptions(models[0], undefined), {});
  assert.throws(() => reasoningPromptOptions(models[0], 'max'));
  assert.throws(() => reasoningPromptOptions({ id: 'plain/model', name: 'Plain' }, 'high'));
  for (const value of ['', 'a b', '\n', 'high\n', {}, [], true, 'x'.repeat(65)]) assert(!validReasoningEffort(value));
  const previous = { model: 'account/model', reasoningEffort: 'high' };
  assert.equal(reasoningForMessage(previous, {}), 'high');
  assert.equal(reasoningForMessage(previous, { reasoningEffort: null }), null);
  assert.equal(reasoningForMessage(previous, { model: 'other/model' }), null);
  assert.equal(reasoningForMessage(previous, { model: 'other/model', reasoningEffort: 'low' }), 'low');
});

test('platform shortcuts use exact native providers without merging regions or saved accounts', () => {
  const native = platformAccess('openrouter', { modelCount: 372 });
  const alias = platformAccess('rivloom-account-one', {
    account: { providerID: 'openrouter', name: 'Work' },
    connected: true,
  });
  const international = platformAccess('siliconflow');
  const providers = [native, alias, international];
  assert.equal(nativePlatformProvider(providers, 'openrouter'), native);
  assert.equal(nativePlatformProvider([alias], 'openrouter'), undefined);
  assert.equal(nativePlatformProvider(providers, 'siliconflow-cn'), undefined);
  assert.equal(
    nativePlatformProvider([platformAccess('openrouter', { apiKey: false })], 'openrouter'),
    undefined,
  );
  assert.equal(
    nativePlatformProvider(
      [
        platformAccess('openrouter', {
          custom: { ...platformCustomDraft('openrouter', []), id: 'openrouter' },
        }),
      ],
      'openrouter',
    ),
    undefined,
  );
  assert.equal(nativePlatformProvider(providers, 'unknown'), undefined);
  assert.equal(native.connected, false);
});

test('compatible platform drafts never overwrite providers or invent model availability', () => {
  const saved = platformAccess('openrouter-custom', {
    custom: {
      ...platformCustomDraft('openrouter', []),
      models: [{ id: 'org/model', name: 'Model' }],
    },
  });
  const catalog = [saved, platformAccess('openrouter-custom-2'), platformAccess('openrouter')];
  const snapshot = structuredClone(catalog);
  const draft = platformCustomDraft('openrouter', catalog);
  assert.equal(draft.id, 'openrouter-custom-3');
  assert.deepEqual(catalog, snapshot);
  assert.deepEqual(draft.models, []);
  assert.equal(customProviderSchema.safeParse(draft).success, false);
  const valid = customProviderSchema.parse({
    ...draft,
    models: [{ id: 'org/model', name: 'org/model' }],
  });
  assert.equal(valid.models[0].id, 'org/model');
  draft.name = 'Edited locally';
  assert.equal(platformCustomDraft('openrouter', []).name, 'OpenRouter');
  assert.throws(() => platformCustomDraft('unknown', []), /Unknown/);
  for (const platform of PROVIDER_PLATFORMS) {
    const value = platformCustomDraft(platform.id, []);
    assert.equal(value.protocol, 'chat');
    assert.equal(value.keyless, false);
    assert.equal(value.baseURL, platform.baseURL);
    assert.equal(new URL(platform.docsURL).protocol, 'https:');
    assert.equal(
      customProviderSchema.safeParse({ ...value, models: [{ id: 'vendor/model', name: 'Model' }] })
        .success,
      true,
    );
  }
  assert.equal(platformCustomDraft('siliconflow-cn', []).baseURL, 'https://api.siliconflow.cn/v1');
});

test('provider search aliases distinguish SiliconFlow regions and common platforms rank first', () => {
  assert.match(providerSearchText(platformAccess('siliconflow-cn')), /硅基流动.*中国/);
  assert.match(providerSearchText(platformAccess('siliconflow')), /硅基流动.*国际/);
  assert.doesNotMatch(providerSearchText(platformAccess('siliconflow')), /中国/);
  assert.match(providerSearchText(platformAccess('openrouter')), /open router/);
  assert.match(
    providerSearchText(platformAccess('custom', { name: 'My Endpoint' })),
    /my endpoint/,
  );
  assert.equal(providerApiRank('openrouter'), 0);
  for (const platform of PROVIDER_PLATFORMS) {
    assert(providerApiRank(platform.id) < providerApiRank('unknown'));
  }
});

const accountFixture = (context: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-account-check-'));
  context.after(() => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return new ProviderAccountStore(root);
};

test('account aliases have stable routing IDs, independent names, bounded paths and no credential storage', (t) => {
  const store = accountFixture(t);
  const a = store.create('opencode-go', 'Work'),
    b = store.create('opencode-go', 'Personal');
  assert.notEqual(a.id, b.id);
  assert.throws(() => store.create('opencode-go', ' WORK '), /already exists/);
  assert.throws(() => store.create('deepseek', '\n'));
  assert.throws(() => store.directory('../elsewhere'));
  assert.throws(() => store.rename('missing', 'Alias'));
  store.rename(a.id, 'Go A');
  assert.equal(new ProviderAccountStore(store.root).get(a.id)?.name, 'Go A');
  assert.deepEqual(store.resolveModel(`${a.id}/org/model`), {
    accountID: a.id,
    providerID: 'opencode-go',
    modelID: 'org/model',
  });
  assert.equal(store.resolveModel('deepseek/org/model').accountID, '');
  store.rename('opencode-go', 'Original', 'opencode-go');
  assert.equal(store.alias('opencode-go'), 'Original');
  assert.throws(() => store.rename(b.id, 'original'), /already exists/);
  store.remove(a.id);
  assert.equal(store.get(b.id)?.name, 'Personal');
  assert.throws(() => store.resolveModel(`${a.id}/org/model`), /no longer connected/);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(store.root, 'rivloom-accounts.json'), 'utf8'))).sort(),
    ['accounts', 'aliases'],
  );
});

test('account names group and search independently even when both accounts offer the same model', () => {
  const models = ['Work', 'Personal'].map((name, i) => ({
    id: `account-${i}/same`,
    providerID: `account-${i}`,
    providerName: 'OpenCode Go',
    sourceProviderID: 'opencode-go',
    accountName: name,
    modelName: 'Same model',
    name: `Same model · ${name}`,
  }));
  const groups = groupModels(models, '', 'en');
  assert.deepEqual(
    groups.map((g) => g.accountName),
    ['Personal', 'Work'],
  );
  assert.equal(
    groupModels(models, 'OPENCODE-GO work same', 'en')[0].models[0].id,
    'account-0/same',
  );
});

test('account engine context stays isolated across concurrent requests, nested scopes and process exit', async (t) => {
  const store = accountFixture(t),
    a = store.create('opencode-go', 'A'),
    b = store.create('opencode-go', 'B');
  const launches: {
    root: string;
    scope: unknown;
    child: EventEmitter & { exitCode: number | null; signalCode: string | null };
  }[] = [];
  const fakeStart = async (_cwd: string, _port: number, root: string, scope: unknown) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
    });
    launches.push({ root, scope, child });
    return {
      child,
      client: { name: root },
      close: () => {
        child.exitCode = 0;
        child.emit('exit', 0);
      },
      waitForExit: async () => {},
    };
  };
  const pool = new AccountEnginePool(
    store,
    fakeStart as unknown as ConstructorParameters<typeof AccountEnginePool>[1],
  );
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const first = pool.run(a.id, async () => {
    await gate;
    return { current: pool.current(), client: pool.client() };
  });
  const second = pool.run(b.id, async () => {
    await gate;
    return { current: pool.current(), client: pool.client() };
  });
  await pool.get(a.id);
  await pool.get(a.id);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].current, a.id);
  assert.equal(results[1].current, b.id);
  assert.notEqual(results[0].client, results[1].client);
  assert.equal(pool.current(), '');
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].scope, { workspace: true, providerID: 'opencode-go' });
  await pool.run(a.id, async () => {
    await pool.run('', async () => assert.equal(pool.current(), ''));
    assert.equal(pool.current(), a.id);
  });
  launches[0].child.exitCode = 1;
  launches[0].child.emit('exit', 1);
  await assert.rejects(pool.get(a.id), /exited/);
  assert.equal(launches.length, 2);
  await pool.close(true);
  await assert.rejects(pool.get(b.id), /shutting down/);
});

test('OAuth retains canonical provider handling and commits only to the selected account', async () => {
  let commitTarget = '';
  const driver: OAuthDriver = {
    authorize: async (provider) => {
      assert.equal(provider, 'openai');
      return { url: 'https://example.com/auth', instructions: '', method: 'auto' };
    },
    complete: async (provider) => {
      assert.equal(provider, 'openai');
      return { type: 'api', key: 'synthetic-token' };
    },
    close: async () => {},
  };
  const oauth = new ProviderOAuth(
    async () => driver,
    async (provider, _auth, _actor, current, accepted, accountID) => {
      assert.equal(provider, 'openai');
      assert(current());
      accepted();
      commitTarget = accountID!;
    },
    () => {},
  );
  const view = oauth.begin('owner', 'openai', 0, {}, 'account-b');
  for (let i = 0; i < 30 && oauth.snapshot('owner')?.status !== 'waiting'; i++)
    await new Promise((done) => setTimeout(done, 2));
  oauth.complete('owner', view.id);
  for (let i = 0; i < 30 && oauth.snapshot('owner')?.status !== 'connected'; i++)
    await new Promise((done) => setTimeout(done, 2));
  assert.equal(commitTarget, 'account-b');
  assert.equal(oauth.snapshot('owner')?.accountID, 'account-b');
  await oauth.close();
});

test('model catalog exposes only connected display metadata and preserves exact provider/model identity', () => {
  const provider = (id: string, context: number, image: boolean) => ({
    id,
    name: id.toUpperCase(),
    key: 'PRIVATE_KEY',
    options: { token: 'PRIVATE_TOKEN' },
    models: {
      'org/model': {
        id: 'org/model',
        name: 'A model',
        limit: { context },
        capabilities: { input: { image } },
        headers: { authorization: 'PRIVATE_HEADER' },
      },
    },
  });
  // A structurally minimal engine response keeps the privacy boundary visible in the assertion.
  const catalog = availableModels(
    [
      provider('a', 1_000_000, true),
      provider('b', 0, false),
      provider('offline', 128000, true),
    ] as unknown as Parameters<typeof availableModels>[0],
    ['a', 'b'],
  );
  assert.deepEqual(catalog, [
    {
      id: 'a/org/model',
      name: 'A model · A',
      providerID: 'a',
      providerName: 'A',
      modelName: 'A model',
      contextWindow: 1_000_000,
      supportsImages: true,
    },
    {
      id: 'b/org/model',
      name: 'A model · B',
      providerID: 'b',
      providerName: 'B',
      modelName: 'A model',
      supportsImages: false,
    },
  ]);
  assert(!JSON.stringify(catalog).includes('PRIVATE'));
});

const pickerModels: AvailableModel[] = [
  { id: 'z/model10', name: 'Model 10 · Zeta' },
  {
    id: 'a/org/model',
    name: 'Same · Alpha',
    providerName: 'Alpha',
    providerID: 'a',
    modelName: 'Same',
  },
  { id: 'z/org/model', name: 'Same · Zeta' },
  { id: 'z/model2', name: 'Model 2 · Zeta' },
  { id: 'b/same', name: 'Same · Alpha' },
];

test('model groups sort naturally and remain distinct for identical provider names and model names', () => {
  const sorted = groupModels(pickerModels, '', 'en');
  assert.deepEqual(
    sorted.map((group) => group.id),
    ['a', 'b', 'z'],
  );
  assert.deepEqual(
    sorted[2].models.map((model) => model.id),
    ['z/model2', 'z/model10', 'z/org/model'],
  );
  assert.deepEqual(groupModels([...pickerModels].reverse(), '', 'en'), sorted);
  assert.equal(pickerModels[0].id, 'z/model10');
});

test('model search combines provider and model terms, handles slashes, and omits empty groups', () => {
  assert.deepEqual(
    groupModels(pickerModels, ' ZETA  same ', 'en').flatMap((g) => g.models.map((m) => m.id)),
    ['z/org/model'],
  );
  assert.equal(groupModels(pickerModels, 'org/model').length, 2);
  assert.equal(groupModels(pickerModels, 'unavailable').length, 0);
  assert.equal(groupModels([], '').length, 0);
});

test('legacy model snapshots retain slash IDs and explicit metadata takes precedence over display punctuation', () => {
  assert.deepEqual(modelDetails({ id: 'local/org/model', name: 'Model' }), {
    providerID: 'local',
    providerName: 'local',
    modelName: 'Model',
  });
  assert.deepEqual(modelDetails({ id: 'plain', name: 'Unscoped' }), {
    providerID: '',
    providerName: '',
    modelName: 'Unscoped',
  });
  assert.equal(
    modelDetails({
      id: 'a/b',
      name: 'Name · Version · Brand',
      providerName: 'Brand · Official',
      modelName: 'Name · Version',
    }).providerName,
    'Brand · Official',
  );
});

test('context labels use decimal token units and never invent unknown capacities', () => {
  assert.equal(formatContextWindow(1_000_000), '1M');
  assert.equal(formatContextWindow(262_144), '262.1K');
  assert.equal(formatContextWindow(128_000), '128K');
  assert.equal(formatContextWindow(512), '512');
  for (const value of [undefined, 0, -1, NaN, Infinity])
    assert.equal(formatContextWindow(value), null);
});

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
  const oauth = new ProviderOAuth(
    async () => ({
      async authorize() {
        return { url: 'https://vendor.example/signin', instructions: '', method: 'auto' as const };
      },
      async complete() {
        return { type: 'api' as const, key: 'synthetic' };
      },
      async close() {
        throw Error('Unconfirmed child exit');
      },
    }),
    async () => {},
    () => {},
  );
  const attempt = oauth.begin('owner', 'test', 0, {});
  await until(() => oauth.snapshot('owner')?.status === 'waiting');
  await oauth.cancel('owner', attempt.id);
  assert(oauth.busy);
  assert.throws(() => oauth.begin('owner', 'test', 0, {}));
  assert.match(oauth.snapshot('owner')!.message!, /restart/);
});
