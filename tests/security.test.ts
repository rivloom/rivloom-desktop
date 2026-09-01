import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
process.env.RIVLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), 'rivloom-security-'));
const { openCodeArtifacts, redact, validateProject } = await import('../server/artifacts.ts');
const { passwordHash, sameToken, verifyPassword } = await import('../server/auth.ts');
const { createExample } = await import('../scripts/example.ts');
const { connectionFailure, parsePreferences } = await import('../server/model-settings.ts');
test('a workspace rejects a second process and recovers a lock after abrupt exit', async () => {
  const source = `import { acquireDataLock } from './server/process-lock.ts'; acquireDataLock(); console.log('locked'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((done, fail) => {
      child.stdout.once('data', () => done());
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error('Lock child exited: ' + code)));
    });
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { acquireDataLock } from './server/process-lock.ts'; acquireDataLock();`,
          ],
          { env: process.env, windowsHide: true, stdio: 'pipe' },
        ),
      /同一数据目录已有运行实例/,
    );
  } finally {
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill();
    await exited;
  }
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquireDataLock } from './server/process-lock.ts'; acquireDataLock();`,
    ],
    { env: process.env, windowsHide: true, stdio: 'pipe' },
  );
});
test('passwords are salted and cannot be verified with another password', () => {
  const first = passwordHash('a-real-long-password');
  assert.notEqual(first, passwordHash('a-real-long-password'));
  assert(verifyPassword('a-real-long-password', first));
  assert(!verifyPassword('incorrect-password', first));
  assert(sameToken('native-launch-secret', 'native-launch-secret'));
  assert(!sameToken('native-launch-secret', 'different-launch-secret'));
});
test('common secret formats are redacted', () => {
  assert(!redact('key sk-123456789abcdefghijklmnop').includes('sk-12345'));
  assert.equal(redact('Authorization: Bearer 1234567890abcde'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('api_key=not-for-the-browser'), 'api_key=[REDACTED]');
});
test('a normal folder is accepted without Git metadata', async () => {
  const dir = join(process.env.RIVLOOM_DATA_DIR!, 'plain-folder');
  createExample(dir);
  assert(!existsSync(join(dir, '.git')));
  assert.equal((await validateProject(dir)).toLowerCase(), dir.toLowerCase());
});
test('only official OpenCode diffs are displayed and sensitive contents stay hidden', () => {
  const visible = openCodeArtifacts([
    {
      file: 'slugify.mjs',
      patch: '-export const value = 1;\n+export const value = 2;\n',
      additions: 1,
      deletions: 1,
      status: 'modified',
    },
  ]);
  assert.equal(visible.length, 1);
  assert.match(visible[0].patch, /-export const value = 1/);
  assert.match(visible[0].patch, /\+export const value = 2/);
  const sensitive = openCodeArtifacts([
    {
      file: '.env',
      patch: '+SOME_UNKNOWN_SECRET=private-value',
      additions: 1,
      deletions: 0,
      status: 'added',
    },
  ]);
  assert(!JSON.stringify(sensitive).includes('private-value'));
});
test('model state rejects corrupt persisted values and provider errors never echo secrets', () => {
  const fallback = parsePreferences('{broken');
  assert.equal(fallback.defaultModel, null);
  assert.deepEqual(fallback.checks, {});
  const key = 'definitely-not-a-real-provider-secret';
  const sanitized = connectionFailure({
    data: { status: 401, message: 'invalid ' + key, headers: { authorization: key } },
  });
  assert.match(sanitized, /拒绝认证/);
  assert(!sanitized.includes(key));
});
