import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
process.env.RIVLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), 'rivloom-security-'));
const { captureArtifacts, redact } = await import('../server/artifacts.ts');
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
test('review capture includes tracked edits, new files and deletion; hash changes with contents', async () => {
  const dir = join(process.env.RIVLOOM_DATA_DIR!, 'fixture');
  createExample(dir);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const first = await captureArtifacts(dir, base);
  assert.equal(first.artifacts.length, 0);
  const source = readFileSync(join(dir, 'slugify.mjs'), 'utf8');
  writeFileSync(join(dir, 'slugify.mjs'), source + '// external edit\n');
  writeFileSync(join(dir, 'new.txt'), 'new artifact');
  const next = await captureArtifacts(dir, base);
  assert.equal(next.artifacts.length, 2);
  assert.notEqual(first.artifactHash, next.artifactHash);
  assert(next.artifacts.some((f) => f.file === 'new.txt' && f.status === 'added'));
  writeFileSync(join(dir, 'new.txt'), 'different artifact');
  assert.notEqual((await captureArtifacts(dir, base)).artifactHash, next.artifactHash);
  unlinkSync(join(dir, 'slugify.mjs'));
  assert(
    (await captureArtifacts(dir, base)).artifacts.some(
      (f) => f.file === 'slugify.mjs' && f.status === 'deleted',
    ),
  );
});
test('sensitive filenames do not expose diff content', async () => {
  const dir = join(process.env.RIVLOOM_DATA_DIR!, 'private-fixture');
  createExample(dir);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeFileSync(join(dir, '.env'), 'SOME_UNKNOWN_SECRET=private-value');
  const result = await captureArtifacts(dir, base);
  assert(!JSON.stringify(result).includes('private-value'));
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
