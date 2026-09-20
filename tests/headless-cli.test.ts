import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dataDirectory, help, parseArguments, peerPort, runCommand, systemdUnit, type API } from '../cli/commands.ts';
import { cliHelp, cliText, prepareCliArguments } from '../cli/localization.ts';
import { spawnSync } from 'node:child_process';
import { HeadlessClient, parseControl, readControl } from '../cli/control.ts';
import { initializeDataDirectory } from '../cli/index.ts';

const command = (...args: string[]) => parseArguments(args);

test('CLI language follows locale precedence, explicit language and preserves literal command arguments', () => {
  assert.equal(prepareCliArguments(['status'], { LANG: 'zh_CN.UTF-8' }).locale, 'zh-CN');
  assert.equal(prepareCliArguments(['status'], { LANG: 'zh_CN.UTF-8', LC_ALL: 'C' }).locale, 'en');
  assert.equal(prepareCliArguments(['status'], { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }).locale, 'zh-CN');
  assert.deepEqual(prepareCliArguments(['--lang', 'en', '--data-dir', '/tmp/node', 'status'], { LANG: 'zh_CN.UTF-8' }), { locale: 'en', args: ['--data-dir', '/tmp/node', 'status'] });
  assert.deepEqual(prepareCliArguments(['name', '--', '--lang', 'zh-CN'], {}).args, ['name', '--', '--lang', 'zh-CN']);
  assert.throws(() => prepareCliArguments(['--lang', 'en', '--lang', 'zh-CN'], {}), /Duplicate/);
  assert.throws(() => prepareCliArguments(['--lang', 'fr'], {}), /en or zh-CN/);
  assert.match(cliHelp(help, 'zh-CN'), /初始化仅当前用户可访问的本地数据/);
  assert.match(cliHelp(help, 'zh-CN'), /pair confirm PAIRING_ID --code CODE/);
  assert.equal(cliHelp(help, 'en'), help);
  assert.equal(cliText("'providers key' requires --stdin", 'zh-CN'), "命令 'providers key' 需要 --stdin");
  assert.equal(cliText('Unknown external error from a tool', 'zh-CN'), 'Unknown external error from a tool');
  prepareCliArguments([], { LANG: 'en' });
});

test('actual CLI help and error output support Chinese and English without a node or model', () => {
  const execute = (locale: string, ...args: string[]) => spawnSync(process.execPath, ['cli/index.ts', '--lang', locale, ...args], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, LANG: 'en_US.UTF-8' } });
  for (const locale of ['zh-CN', 'en']) {
    const result = execute(locale, '--help'); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, locale === 'en' ? /Initialize private local data/ : /初始化仅当前用户可访问的本地数据/);
    const error = execute(locale, 'not-a-command'); assert.equal(error.status, 1);
    assert.match(error.stderr, locale === 'en' ? /Unknown command/ : /未知命令/);
    const version = execute(locale, '--version', '--json'); assert.equal(version.status, 0);
    assert.equal(typeof JSON.parse(version.stdout).version, 'string');
  }
});
const io = (input = '') => ({ dataDir: '/tmp/rivloom-test', stdin: async () => input });
function fakeAPI(values: Record<string, unknown> = {}) {
  const calls: { path: string; body?: unknown }[] = [];
  const api: API = { async request<T>(path: string, body?: unknown) { calls.push({ path, body }); return (values[path] ?? { ok: true }) as T; } };
  return { api, calls };
}

test('headless CLI rejects ambiguous flags, unknown commands and API keys on argv', () => {
  assert.deepEqual(command('--data-dir', '/tmp/node', 'execution', 'status', '--json'), { name: 'execution status', args: [], options: { 'data-dir': '/tmp/node', json: true } });
  assert.equal(command('pair').name, 'pair list');
  assert.equal(command('execution').name, 'execution status');
  assert.equal(command('--version').name, 'version');
  for (const argv of [ ['serve', '--port', '9999'], ['init', '--name'], ['init', '--name', 'a', '--name', 'b'], ['api', 'http://evil.example'], ['providers', 'key', 'deepseek', 'private-key'], ['providers', 'key', 'deepseek', '--key', 'private-key'], ['execution', 'disable', '--approval', 'full'] ]) {
    assert.throws(() => parseArguments(argv));
  }
});

test('headless CLI data paths honor explicit settings and absolute XDG paths', () => {
  assert.equal(dataDirectory('relative', {}, '/home/u'), resolve('relative'));
  assert.equal(dataDirectory(undefined, { RIVLOOM_DATA_DIR: 'environment' }, '/home/u'), resolve('environment'));
  assert.equal(dataDirectory(undefined, { XDG_DATA_HOME: 'relative' }, '/home/u'), join('/home/u', '.local', 'share', 'rivloom'));
  assert.equal(dataDirectory(undefined, { XDG_DATA_HOME: resolve('xdg') }, '/home/u'), join(resolve('xdg'), 'rivloom'));
});

test('headless initialization preserves existing identity and refuses to replace the profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-cli-init-'));
  try {
    const directory = join(root, 'private');
    initializeDataDirectory(directory, 'Lab machine');
    const path = join(directory, 'node-profiles.json');
    const original = readFileSync(path, 'utf8');
    writeFileSync(join(directory, 'node-identity.json'), 'existing-identity');
    initializeDataDirectory(directory);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.throws(() => initializeDataDirectory(directory, 'Changed'), /already exists/);
    assert.equal(readFileSync(join(directory, 'node-identity.json'), 'utf8'), 'existing-identity');
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('headless pairing requires the matching current code before any confirmation request', async () => {
  const id = 'f71475b2-1bac-4a77-93c7-6f58fc5f0054';
  const { api, calls } = fakeAPI({ '/api/network': { pairings: [{ id, code: '123456', expiresAt: new Date(Date.now() + 60_000).toISOString() }] } });
  await assert.rejects(runCommand(command('pair', 'confirm', id), api, io()), /requires --code/);
  await assert.rejects(runCommand(command('pair', 'confirm', id, '--code', '654321'), api, io()), /does not match/);
  assert.equal(calls.filter(call => call.body !== undefined).length, 0);
  await runCommand(command('pair', 'confirm', id, '--code', '123456'), api, io());
  assert.equal(calls.at(-1)?.path, `/api/network/pairings/${id}/confirm`);
  const expired = fakeAPI({ '/api/network': { pairings: [{ id, code: '123456', expiresAt: '2020-01-01T00:00:00.000Z' }] } });
  await assert.rejects(runCommand(command('pair', 'confirm', id, '--code', '123456'), expired.api, io()), /expired/);
  assert.equal(expired.calls.length, 1);
});

test('headless execution requires explicit project, model, approval mode and confirmation', async () => {
  const { api, calls } = fakeAPI();
  for (const argv of [ ['execution', 'enable'], ['execution', 'enable', '--confirm'], ['execution', 'enable', '--project', 'p', '--model', 'a/b', '--approval', 'invalid', '--confirm'] ]) await assert.rejects(runCommand(parseArguments(argv), api, io()));
  assert.equal(calls.length, 0);
  await runCommand(command('execution', 'enable', '--project', 'p', '--model', 'a/b', '--approval', 'ask', '--confirm'), api, io());
  assert.deepEqual(calls[0], { path: '/api/network/execution-policy', body: { enabled: true, reasoningEffort: null, projectID: 'p', model: 'a/b', approvalMode: 'ask', confirmed: true } });
  await runCommand(command('execution', 'enable', '--project', 'p', '--model', 'a/b', '--approval', 'ask', '--thinking', 'high', '--confirm'), api, io());
  assert.equal((calls.at(-1)?.body as { reasoningEffort: string }).reasoningEffort, 'high');
  await runCommand(command('execution', 'enable', '--project', 'p', '--model', 'a/b', '--approval', 'ask', '--thinking', 'auto', '--confirm'), api, io());
  assert.equal((calls.at(-1)?.body as { reasoningEffort: null }).reasoningEffort, null);
  const count = calls.length;
  await assert.rejects(runCommand(command('execution', 'enable', '--project', 'p', '--model', 'a/b', '--approval', 'ask', '--thinking', 'bad value', '--confirm'), api, io()), /Invalid thinking/);
  assert.equal(calls.length, count);
});

test('headless concurrency and fixed LAN ports reject out-of-range and ambiguous values', async () => {
  const { api, calls } = fakeAPI();
  for (const value of ['0', '11', '1.5', '1e0', '-1']) await assert.rejects(runCommand(command('execution', 'concurrency', value), api, io()));
  await runCommand(command('execution', 'concurrency', '5'), api, io());
  assert.deepEqual(calls[0], { path: '/api/network/execution-concurrency', body: { maxConcurrent: 5 } });
  for (const value of ['0', '65536', '1.5', '1e4', '-1']) assert.throws(() => peerPort(value));
  assert.equal(peerPort('43532'), 43532);
  assert(systemdUnit('/opt/rivloom/bin/rivloom', '/home/user/data', 43532).includes('serve --peer-port 43532'));
});

test('headless queue pause and resume use the observed queue version and distinct operation IDs', async () => {
  const { api, calls } = fakeAPI({ '/api/node-queue': { version: 7, entries: [], paused: false } });
  await runCommand(command('queue', 'pause'), api, io());
  await runCommand(command('queue', 'resume'), api, io());
  const pause = calls[1].body as { expectedVersion: number; operationID: string; paused: boolean };
  const resume = calls[3].body as typeof pause;
  assert.equal(pause.expectedVersion, 7);
  assert.equal(pause.paused, true);
  assert.equal(resume.paused, false);
  assert.notEqual(pause.operationID, resume.operationID);
});

test('headless providers accept secrets only through explicit confirmed stdin and preserve account scope', async () => {
  const { api, calls } = fakeAPI();
  await assert.rejects(runCommand(command('providers', 'key', 'deepseek', '--confirm'), api, io('secret')), /stdin/);
  await assert.rejects(runCommand(command('providers', 'key', 'deepseek', '--stdin'), api, io('secret')), /confirm/);
  assert.equal(calls.length, 0);
  await runCommand(command('providers', 'key', 'deepseek', '--stdin', '--confirm', '--account', 'Lab', '--account-id', 'rivloom-account-lab'), api, io('secret\n'));
  assert.deepEqual(calls[0].body, { providerID: 'deepseek', key: 'secret', shared: true, account: { name: 'Lab', id: 'rivloom-account-lab' } });
  await assert.rejects(runCommand(command('providers', 'custom', '--stdin', '--confirm'), api, io('{bad secret')), error => error instanceof Error && !error.message.includes('secret'));
  await assert.rejects(runCommand(command('providers', 'custom', '--stdin', '--confirm'), api, io('{"provider":{},"untrusted":true}')), /Expected/);
});

test('headless pending and replies retain request IDs and validate all question answers', async () => {
  const { api, calls } = fakeAPI({ '/api/bootstrap': { tasks: [{ id: 'one', title: 'Task', state: 'running', approvals: [{ id: 'permission' }], questions: [] }, { id: 'two', approvals: [], questions: [] }] } });
  const pending = await runCommand(command('pending'), api, io()) as { taskID: string }[];
  assert.deepEqual(pending.map(item => item.taskID), ['one']);
  await runCommand(command('approve', 'one', 'permission', 'once'), api, io());
  assert.deepEqual(calls.at(-1), { path: '/api/tasks/one/permissions/permission', body: { reply: 'once' } });
  await runCommand(command('respond', 'one', 'question', '--stdin'), api, io('[["Option A"],["Explanation"]]'));
  assert.deepEqual(calls.at(-1)?.body, { answers: [['Option A'], ['Explanation']] });
  for (const input of ['[]', '[[]]', '[true]', '[[42]]']) await assert.rejects(runCommand(command('respond', 'one', 'question', '--stdin'), api, io(input)));
});

test('headless control rejects remote destinations, URL tricks and invalid tokens', () => {
  const value = { version: 1, pid: 1, url: 'http://127.0.0.1:12345', token: 'a'.repeat(43) };
  assert.equal(parseControl(value).url, value.url);
  for (const url of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.0.0.1:12345@evil.example', 'http://127.0.0.1:12345/?url=evil', 'http://127.0.0.1:12345/api', 'http://127.0.0.1:70000', 'http://2130706433:12345']) assert.throws(() => parseControl({ ...value, url }));
  assert.throws(() => parseControl({ ...value, token: 'token\n' }));
  assert.throws(() => readControl(join(tmpdir(), `rivloom-missing-${Date.now()}`)), /not running/);
});

test('headless HTTP client never forwards the control token after login and forbids redirects', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/headless')) return new Response('{}', { headers: { 'set-cookie': 'rivloom_session=session-value; HttpOnly; Path=/' } });
    return new Response('{"ok":true}');
  }) as typeof fetch;
  const client = new HeadlessClient({ version: 1, pid: 1, url: 'http://127.0.0.1:12345', token: 'a'.repeat(43) }, send);
  await client.connect();
  await client.request('/api/network');
  await assert.rejects(client.request('//evil.example/api'), /Invalid/);
  await assert.rejects(client.request('/api/%2e%2e'), /Invalid/);
  await client.close();
  assert.equal(calls.length, 3);
  assert(calls.every(call => call.init.redirect === 'error'));
  assert.equal(new Headers(calls[0].init.headers).get('x-rivloom-headless-token'), 'a'.repeat(43));
  assert.equal(new Headers(calls[1].init.headers).get('x-rivloom-headless-token'), null);
  assert.equal(new Headers(calls[1].init.headers).get('cookie'), 'rivloom_session=session-value');
  await assert.rejects(client.request('/api/network'), /not authenticated/);
});

test('headless service output quotes systemd arguments without allowing directive injection', () => {
  const unit = systemdUnit('/opt/Rivloom build/bin/rivloom', '/home/user/50% $value');
  assert(unit.includes('ExecStart="/opt/Rivloom build/bin/rivloom" --data-dir "/home/user/50%% $$value" serve'));
  assert(unit.includes('UMask=0077'));
  assert(unit.includes('KillMode=control-group'));
  assert.throws(() => systemdUnit('/opt/rivloom\nExecStart=evil', '/home/user'), /control characters/);
  assert.throws(() => systemdUnit('rivloom', '/home/user'), /absolute Linux/);
});
