import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { readMacosStartupEvidence } from '../scripts/macos-startup-evidence.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rivloom-startup-evidence-'));
  const directory = join(root, 'engine', 'data', 'opencode', 'log');
  await mkdir(directory, { recursive: true });
  return { root, directory, log: join(directory, 'opencode.log'), async cleanup() {
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true, force: true });
  } };
}

test('startup evidence parses actual key/value logs and returns only fixed classifications', async () => {
  const f = await fixture();
  const canary = 'private-user-token-and-project';
  const text = [
    'timestamp=2026-10-22 level=INFO run=secret path=/global/health message="level=ERROR error.code=EPERM"',
    'timestamp=2026-10-22 level=ERROR run=secret path=/provider error.name=TypeError error.code=ERR_MODULE_NOT_FOUND error.message="Cannot find module /private/project"',
    `timestamp=2026-10-22 level=WARN run=secret error.name=${canary} error.code=${canary} message="Permission denied ETIMEDOUT ECONNREFUSED ${canary}"`,
    'timestamp=2026-10-22 level=INFO run=secret level=ERROR message=ignored',
    'not a structured line', ''
  ].join('\n');
  try {
    await writeFile(f.log, text);
    const actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'read');
    assert.equal(actual.bytes, Buffer.byteLength(text));
    assert.deepEqual(actual.lines, { complete: 5, parsed: 4, unparsed: 1, error: 1, warn: 1 });
    assert.deepEqual(actual.observedRoutes, { health: true, provider: true });
    assert.deepEqual(actual.errorNames, ['TypeError', 'unknown']);
    assert.deepEqual(actual.errorCodes, ['ECONNREFUSED', 'ERR_MODULE_NOT_FOUND', 'ETIMEDOUT', 'unknown']);
    assert.deepEqual(actual.markers, { moduleMissing: true, permissionDenied: true, networkFailure: true, timeout: true });
    for (const secret of [canary, 'secret', '/private/project', f.root]) assert(!JSON.stringify(actual).includes(secret));
    assert.equal(await readFile(f.log, 'utf8'), text);
  } finally { await f.cleanup(); }
});

test('startup evidence reads at most 64 KiB and discards incomplete boundary records', async () => {
  const f = await fixture();
  try {
    await writeFile(f.log, 'level=ERROR error.code=EPERM\n' + 'x'.repeat(80_000) + '\nlevel=INFO path=/provider\nlevel=ERROR error.code=ENOENT');
    const actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'read');
    assert.equal(actual.sampledBytes, 64 * 1024);
    assert.equal(actual.tailTruncated, true);
    assert.equal(actual.partialStartDiscarded, true);
    assert.equal(actual.partialEndDiscarded, true);
    assert.deepEqual(actual.lines, { complete: 1, parsed: 1, unparsed: 0, error: 0, warn: 0 });
    assert.deepEqual(actual.errorCodes, []);
    assert.deepEqual(actual.observedRoutes, { health: false, provider: true });
  } finally { await f.cleanup(); }
});

test('startup evidence observes exact source-locked core phase messages without exposing their fields', async () => {
  const f = await fixture();
  const canary = 'private-phase-session-and-project';
  try {
    await writeFile(f.log, [
      `timestamp=2026-10-22 level=INFO run=private message=bootstrapping directory=${canary}`,
      `timestamp=2026-10-22 level=INFO run=private message=loop session.id=${canary} step=0`,
      `timestamp=2026-10-22 level=INFO run=private message="shell tool using shell" shell=/private/${canary}`,
      `timestamp=2026-10-22 level=INFO run=private message=stream session.id=${canary} providerID=${canary}`,
      `timestamp=2026-10-22 level=ERROR run=private message="prompt_async failed" sessionID=${canary} cause=${JSON.stringify(`TypeError: ${canary}\n    at /private/${canary}`)}`,
      '',
    ].join('\n'));
    const actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'read');
    assert.deepEqual(actual.phaseMarkers, { instanceBootstrap: true, promptLoop: true, shellToolInit: true, llmStream: true, asyncPromptFailed: true });
    assert.deepEqual(actual.errorNames, ['TypeError']);
    for (const secret of [canary, '/private', f.root]) assert(!JSON.stringify(actual).includes(secret));
  } finally { await f.cleanup(); }
});

test('startup evidence does not infer phases from substrings, other fields, levels, or incomplete records', async () => {
  const f = await fixture();
  try {
    await writeFile(f.log, [
      'level=INFO message="bootstrapping private-project"',
      'level=INFO message=not-loop',
      'level=INFO message="shell tool using shell failed"',
      'level=INFO message="stream ended"',
      'level=ERROR message="prompt_async failed later"',
      'level=INFO message=unrelated error="prompt_async failed" cause=loop route=stream',
      'level=WARN message=bootstrapping',
      'level=DEBUG message=loop',
      'level=ERROR message="shell tool using shell"',
      'level=WARN message=stream',
      'level=INFO message="prompt_async failed"',
      'level=INFO message=unrelated message=stream',
      'level=INFO message=stream',
    ].join('\n'));
    const actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'read');
    assert.equal(actual.partialEndDiscarded, true);
    assert.deepEqual(actual.phaseMarkers, { instanceBootstrap: false, promptLoop: false, shellToolInit: false, llmStream: false, asyncPromptFailed: false });
  } finally { await f.cleanup(); }
});

test('startup evidence rejects hard links and nonregular files without returning their content', async () => {
  const f = await fixture();
  try {
    const other = join(f.root, 'private-source');
    await writeFile(other, 'level=ERROR error.code=EPERM\n');
    await link(other, f.log);
    let actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'rejected');
    assert.equal(actual.reason, 'unsafe-path');
    assert.equal(actual.sampledBytes, 0);
    await rm(f.log);
    await mkdir(f.log);
    actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.status, 'rejected');
    assert.equal(actual.sampledBytes, 0);
  } finally { await f.cleanup(); }
});

test('startup evidence rejects a linked log parent and linked data root', async () => {
  const f = await fixture();
  const target = await fixture();
  try {
    await writeFile(target.log, 'level=ERROR error.code=EPERM\n');
    await rmdir(f.directory);
    await symlink(target.directory, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await readMacosStartupEvidence(f.root)).status, 'rejected');
    const alias = join(f.root, 'alias');
    await symlink(target.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await readMacosStartupEvidence(alias)).status, 'rejected');
  } finally { await f.cleanup(); await target.cleanup(); }
});

test('startup evidence classifies serialized Error objects without exposing their message or stack', async () => {
  const f = await fixture();
  try {
    const canary = 'secret-source-and-token';
    await writeFile(f.log, `level=ERROR message=failed error=${JSON.stringify(`TypeError: ${canary}\n    at /private/${canary}:1\nENOEXEC EBADF`)} cause="NOT_ENOENT privateErrorCode"\n`);
    const actual = await readMacosStartupEvidence(f.root);
    assert.deepEqual(actual.errorNames, ['TypeError']);
    assert.deepEqual(actual.errorCodes, ['EBADF', 'ENOEXEC']);
    assert(!JSON.stringify(actual).includes(canary));
    assert(!JSON.stringify(actual).includes('/private'));
  } finally { await f.cleanup(); }
});

test('startup evidence handles missing, empty, invalid, and malformed inputs without throwing', async () => {
  const f = await fixture();
  try {
    assert.equal((await readMacosStartupEvidence(f.root)).status, 'missing');
    for (const path of ['relative/private', f.root + '\0private']) {
      const actual = await readMacosStartupEvidence(path);
      assert.equal(actual.status, 'rejected');
      assert.equal(actual.reason, 'invalid-directory');
      assert(!JSON.stringify(actual).includes('private'));
    }
    await writeFile(f.log, '');
    assert.equal((await readMacosStartupEvidence(f.root)).status, 'read');
    await writeFile(f.log, 'level=ERROR message="invalid\\q"\nlevel=ERROR message="private"error.code=EPERM\n');
    const actual = await readMacosStartupEvidence(f.root);
    assert.equal(actual.lines.unparsed, 2);
    assert.equal(actual.lines.error, 0);
    assert.deepEqual(actual.errorCodes, []);
  } finally { await f.cleanup(); }
});
