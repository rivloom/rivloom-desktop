import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayVersion, installedVersion } from '../src/app-version.ts';

test('installed version selection reads no authentication, paths or object serialization', () => {
  const sensitive = () => {
    throw new Error('Sensitive fields must never be read');
  };
  const info = {
    version: '0.1.4',
    get desktopToken() {
      return sensitive();
    },
    get dataDirectory() {
      return sensitive();
    },
    toJSON: sensitive,
    toString: sensitive,
  };
  assert.equal(installedVersion(info), '0.1.4');
});

test('native and engine version labels reject response dumps and unbounded text', () => {
  for (const value of [
    null,
    undefined,
    {},
    123,
    '',
    '0.1.4\nsecret-token',
    '0.1.4 C:\\Users\\private',
    '{"version":"0.1.4","desktopToken":"private"}',
    '<script>private</script>',
    `0.1.4+${'a'.repeat(80)}`,
  ]) {
    assert.equal(displayVersion(value), null);
    assert.equal(installedVersion({ version: value }), null);
  }
  assert.equal(installedVersion(null), null);
  assert.equal(installedVersion('0.1.4'), null);
  assert.equal(installedVersion({ desktopToken: 'private' }), null);
  assert.equal(installedVersion(Object.assign([], { version: '0.1.4' })), null);
});

test('version labels preserve prerelease and build identity without a hardcoded fallback', () => {
  for (const version of ['0.1.4', '1.18.25', '0.2.0-beta.1', '0.2.0-beta.1+20260907.a1b2']) {
    assert.equal(displayVersion(version), version);
    assert.equal(installedVersion({ version, desktopToken: 'private' }), version);
  }
});
