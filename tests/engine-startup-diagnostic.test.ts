import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEngineStartupDiagnostic, summarizeEngineStartupFailure } from '../server/engine-startup-diagnostic.ts';

test('startup diagnostics distinguish launch and provider failures without copying private error fields', () => {
  const secret = 'PRIVATE_TOKEN_PROVIDER_PATH';
  const error = Object.assign(new TypeError(`fetch failed https://provider.example/${secret}`), {
    stack: secret, path: `/Users/${secret}/settings`, env: { API_KEY: secret },
    cause: Object.assign(new Error(`connect ECONNREFUSED ${secret}`), { code: 'ECONNREFUSED' }),
  });
  assert.deepEqual(summarizeEngineStartupFailure(error, 'providers'), {
    phase: 'providers', kind: 'TypeError', code: 'ECONNREFUSED', markers: ['fetch-failed', 'network'],
  });
  const launch = summarizeEngineStartupFailure(new Error('OpenCode 启动超时'), 'start-engine');
  assert.deepEqual(launch, { phase: 'start-engine', kind: 'Error', markers: ['startup-timeout'] });
  assert(!JSON.stringify(summarizeEngineStartupFailure(error, 'providers')).includes(secret));
});

test('SDK name/data errors and tagged core errors produce only allowlisted classifications', () => {
  const sdk = { name: 'UnknownError', data: { message: "Cannot find module '/private/credentials/plugin.mjs'", statusCode: 500 } };
  assert.deepEqual(summarizeEngineStartupFailure(sdk, 'providers'), {
    phase: 'providers', kind: 'UnknownError', httpStatus: 500, markers: ['module-resolution'],
  });
  assert.deepEqual(summarizeEngineStartupFailure({ _tag: 'ConfigInvalidError', data: { message: 'ConfigInvalidError: SECRET' } }, 'providers'), {
    phase: 'providers', kind: 'ConfigInvalidError', markers: ['configuration'],
  });
  assert.equal(summarizeEngineStartupFailure({ type: 'ResolveMessage' }, 'providers').kind, 'ResolveMessage');
  assert.equal(summarizeEngineStartupFailure(new Error('wrapper', { cause: { name: 'SystemError', code: 'ENOENT' } }), 'start-engine').kind, 'SystemError');
});

test('private or unknown names, codes and thrown primitives are never serialized or coerced', () => {
  let invoked = false;
  const hostile = { toString() { invoked = true; throw new Error('private'); }, toJSON() { invoked = true; throw new Error('private'); } };
  const expected = { phase: 'providers', kind: 'unknown', markers: [] };
  for (const value of [null, undefined, 'SECRET', 500, Symbol('SECRET'), () => 'SECRET',
    { name: 'SECRET', _tag: 'SecretError', type: 'private-provider', code: 'TOKEN_123', message: 'SECRET', stack: 'SECRET' },
    { name: hostile, code: hostile, message: hostile, status: hostile, toJSON: hostile.toJSON }]) {
    assert.deepEqual(summarizeEngineStartupFailure(value, 'providers'), expected);
  }
  assert.equal(invoked, false);
  assert.deepEqual(summarizeEngineStartupFailure('Cannot find module /PRIVATE; request timed out token=SECRET', 'providers'), {
    phase: 'providers', kind: 'unknown', markers: ['module-resolution', 'timeout'],
  });
});

test('cyclic causes, revoked proxies and throwing getters cannot break the diagnostic boundary', () => {
  const cyclic: Record<string, unknown> = { name: 'AbortError' };
  cyclic.cause = cyclic; cyclic.data = { cause: cyclic, message: 'fetch failed PRIVATE' };
  assert.deepEqual(summarizeEngineStartupFailure(cyclic, 'providers'), {
    phase: 'providers', kind: 'AbortError', markers: ['fetch-failed'],
  });
  let getterCalls = 0;
  const guarded = Object.create(null);
  for (const key of ['name', '_tag', 'type', 'code', 'status', 'statusCode', 'httpStatus', 'message', 'cause', 'data'])
    Object.defineProperty(guarded, key, { get() { getterCalls++; throw new Error('PRIVATE'); } });
  assert.deepEqual(summarizeEngineStartupFailure(guarded, 'start-engine'), { phase: 'start-engine', kind: 'unknown', markers: [] });
  assert.equal(getterCalls, 10);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.deepEqual(summarizeEngineStartupFailure(revoked.proxy, 'providers'), { phase: 'providers', kind: 'unknown', markers: [] });
  assert.deepEqual(summarizeEngineStartupFailure({ name: 'TimeoutError', get code() { throw new Error('PRIVATE'); },
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'providers'), {
    phase: 'providers', kind: 'TimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT', markers: [],
  });
});

test('cause and SDK data traversal stops after three levels without touching deeper getters', () => {
  let accessed = false;
  const third = { name: 'TypeError', data: { code: 'ENOENT' }, get cause() { accessed = true; throw new Error('PRIVATE'); } };
  assert.deepEqual(summarizeEngineStartupFailure({ cause: { data: third } }, 'start-engine'), {
    phase: 'start-engine', kind: 'TypeError', markers: [],
  });
  assert.equal(accessed, false);
  assert.deepEqual(summarizeEngineStartupFailure({ cause: { data: { code: 'ERR_MODULE_NOT_FOUND' } } }, 'providers'), {
    phase: 'providers', kind: 'unknown', code: 'ERR_MODULE_NOT_FOUND', markers: [],
  });
});

test('HTTP evidence accepts only integer error statuses and never infers a response from missing SDK fields', () => {
  for (const status of [400, 401, 500, 599])
    assert.equal(summarizeEngineStartupFailure({ status }, 'providers').httpStatus, status);
  for (const status of [200, 399, 600, 500.5, NaN, Infinity, '500', null])
    assert.equal('httpStatus' in summarizeEngineStartupFailure({ status, statusCode: status, httpStatus: status }, 'providers'), false);
  assert.equal('httpStatus' in summarizeEngineStartupFailure({ name: 'UnknownError', data: { message: 'private' } }, 'providers'), false);
});

test('message inspection is bounded and emits at most eight distinct constant markers', () => {
  const message = 'Cannot find module; timeout; fetch failed; connection refused; permission denied; invalid configuration; '
    + 'failed to load plugin; database is locked; background dependency install failed; PRIVATE_TOKEN';
  const diagnostic = summarizeEngineStartupFailure({ message, cause: { message } }, 'providers');
  assert.equal(diagnostic.markers.length, 8);
  assert.equal(new Set(diagnostic.markers).size, 8);
  assert(!JSON.stringify(diagnostic).includes('PRIVATE'));
  assert.deepEqual(summarizeEngineStartupFailure({ message: 'x'.repeat(8192) + ' fetch failed PRIVATE' }, 'providers').markers, []);
  assert.deepEqual(summarizeEngineStartupFailure({ message: 'Owned OpenCode process tree did not exit cleanly. PRIVATE' }, 'start-engine').markers,
    ['shutdown-unproven']);
});

test('API receipt parser reconstructs valid diagnostics and rejects unexpected or invalid fields', () => {
  const valid = { ...summarizeEngineStartupFailure({ name: 'TypeError', code: 'ERR_MODULE_NOT_FOUND', status: 500,
    message: 'Cannot find module SECRET' }, 'providers'), engineAssigned: true, hostRunning: true };
  const parsed = parseEngineStartupDiagnostic(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(parsed, valid);
  assert.notEqual(parsed, valid);
  assert.notEqual(parsed!.markers, valid.markers);
  for (const invalid of [
    { ...valid, path: 'SECRET' }, { ...valid, phase: 'SECRET' }, { ...valid, kind: 'SecretError' },
    { ...valid, code: 'SECRET' }, { ...valid, code: undefined }, { ...valid, httpStatus: 200 }, { ...valid, httpStatus: '500' },
    { ...valid, markers: ['SECRET'] }, { ...valid, markers: ['timeout', 'timeout'] }, { ...valid, markers: new Array(1) },
    { ...valid, markers: new Array(9).fill('timeout') }, { ...valid, engineAssigned: false },
    { ...valid, hostRunning: 1 }, { phase: 'providers', kind: 'Error', markers: [], engineAssigned: true },
    { ...valid, [Symbol('SECRET')]: 'SECRET' },
  ]) assert.equal(parseEngineStartupDiagnostic(invalid), undefined);
  assert.deepEqual(parseEngineStartupDiagnostic({ phase: 'providers', kind: 'unknown', markers: [] }),
    { phase: 'providers', kind: 'unknown', markers: [] });
});

test('API receipt parser rejects accessors and hostile proxies without invoking their value getters', () => {
  let accessed = false;
  const getter = () => { accessed = true; throw new Error('SECRET'); };
  const valid = { phase: 'providers', kind: 'Error', markers: ['timeout'] };
  assert.equal(parseEngineStartupDiagnostic(Object.defineProperty({ ...valid }, 'kind', { get: getter })), undefined);
  assert.equal(parseEngineStartupDiagnostic({ ...valid, markers: Object.defineProperty(['timeout'], '0', { get: getter }) }), undefined);
  assert.equal(accessed, false);
  assert.equal(parseEngineStartupDiagnostic(new Proxy(valid, { ownKeys: getter })), undefined);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(parseEngineStartupDiagnostic(revoked.proxy), undefined);
  // The proxy must run its ownKeys trap, but neither value getter may run.
  accessed = false;
  parseEngineStartupDiagnostic(Object.defineProperty({ ...valid }, 'message', { get: getter }));
  assert.equal(accessed, false);
});
