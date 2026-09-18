import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundledLinuxReadme, linuxArch, linuxLauncher, verifyElf, verifyIntegrity, verifyEnginePackagePath, LINUX_TARGETS } from './linux-build.ts';
import { downloadObjectKey } from './ci-r2-storage.ts';

test('Linux packages reject unsupported architectures and wrong ELF targets', () => {
  assert.equal(linuxArch('arm64'), 'arm64'); assert.throws(() => linuxArch('ia32'));
  const bytes = Buffer.alloc(65); bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(62, 18);
  verifyElf(bytes, 'x64'); assert.throws(() => verifyElf(bytes, 'arm64'));
  bytes[4] = 1; assert.throws(() => verifyElf(bytes, 'x64'));
});
test('Linux dependency pins match the lock and Windows remains optional on other platforms', async () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.optionalDependencies, lock.packages[''].optionalDependencies);
  assert.equal(manifest.dependencies['opencode-windows-x64'], undefined);
  for (const arch of ['x64', 'arm64'] as const) {
    const name = LINUX_TARGETS[arch].enginePackage, item = lock.packages[`node_modules/${name}`];
    assert.equal(item.version, '1.18.25'); assert.equal(item.optional, true);
    assert.deepEqual(item.os, ['linux']); assert.deepEqual(item.cpu, [arch]);
    assert.match(item.integrity, /^sha512-/);
  }
  const bytes = Buffer.from('reviewed archive');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  verifyIntegrity(bytes, integrity); assert.throws(() => verifyIntegrity(Buffer.from('tampered'), integrity));
});
test('Linux launcher preserves arguments and uses only its bundled runtime', () => {
  const shell = linuxLauncher();
  assert(shell.startsWith('#!/bin/sh\n')); assert(shell.includes('exec "$ROOT/runtime/node" "$ROOT/app/cli/index.ts" "$@"'));
  assert(!shell.includes('\r')); assert(shell.includes('RIVLOOM_CLI_EXECUTABLE'));
});
test('OpenCode platform filtering keeps the shared SDK/plugin and rejects other architecture binaries', () => {
  verifyEnginePackagePath('node_modules/@opencode-ai/sdk', 'x64');
  verifyEnginePackagePath('node_modules/@opencode-ai/plugin', 'arm64');
  verifyEnginePackagePath('node_modules/opencode-linux-x64-baseline', 'x64');
  assert.throws(() => verifyEnginePackagePath('node_modules/opencode-windows-x64', 'x64'));
  assert.throws(() => verifyEnginePackagePath('node_modules/opencode-linux-arm64', 'x64'));
});
test('Archive README documentation links refer to its exact public source commit', () => {
  const commit = 'a'.repeat(40);
  const text = bundledLinuxReadme('[CI](CI.md) [release](RELEASING.md) [retention](R2-RETENTION.md)', commit);
  for (const file of ['CI', 'RELEASING', 'R2-RETENTION']) assert(text.includes(`/blob/${commit}/docs/${file}.md)`));
  assert.throws(() => bundledLinuxReadme('text', 'main'));
});
test('R2 Linux allowlist cannot reach unrelated prefixes, scripts or traversal', () => {
  for (const key of ['releases/linux/latest.json', 'releases/linux/linux-v0.1.19-abcd-1/Rivloom_0.1.19_linux_x64.tar.gz', 'releases/linux/linux-v0.1.19-abcd-1/SHA256SUMS.txt']) assert.equal(downloadObjectKey(key), key);
  for (const key of ['releases/linux/install.sh', 'releases/linux/../latest.json', 'releases/linux/latest.json\n', 'releases/linux/linux-v1/install.sh', 'updates/linux/latest.json']) assert.throws(() => downloadObjectKey(key));
});
