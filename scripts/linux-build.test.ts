import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundledLinuxReadme, linuxArch, linuxLauncher, verifyElf, verifyEnginePackagePath } from './linux-build.ts';
import { downloadObjectKey } from './ci-r2-storage.ts';

test('Linux packages reject unsupported architectures and wrong ELF targets', () => {
  assert.equal(linuxArch('x64'), 'x64'); assert.throws(() => linuxArch('arm64')); assert.throws(() => linuxArch('ia32'));
  const bytes = Buffer.alloc(65); bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(62, 18);
  verifyElf(bytes, 'x64'); bytes.writeUInt16LE(183, 18); assert.throws(() => verifyElf(bytes, 'x64')); bytes.writeUInt16LE(62, 18);
  bytes[4] = 1; assert.throws(() => verifyElf(bytes, 'x64'));
});
test('Linux and Windows source engines use matching SDK/plugin pins without published binary dependencies', async () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.optionalDependencies, lock.packages[''].optionalDependencies);
  for (const name of ['opencode-windows-x64', 'opencode-linux-x64-baseline', 'opencode-linux-arm64']) {
    assert.equal(manifest.dependencies[name], undefined);
    assert.equal(manifest.optionalDependencies?.[name], undefined);
    assert.equal(lock.packages[`node_modules/${name}`], undefined);
  }
  for (const sourceFile of ['engine-source.json', 'engine-source-linux.json']) {
    const source = JSON.parse(await readFile(resolve(root, 'shared', sourceFile), 'utf8'));
    for (const name of ['@opencode-ai/sdk', '@opencode-ai/plugin']) {
      assert.equal(manifest.dependencies[name], source.packageVersion);
      assert.equal(lock.packages[`node_modules/${name}`].version, source.packageVersion);
    }
  }
});
test('Linux launcher preserves arguments and uses only its bundled runtime', () => {
  const shell = linuxLauncher();
  assert(shell.startsWith('#!/bin/sh\n')); assert(shell.includes('exec "$ROOT/runtime/node" "$ROOT/app/cli/index.ts" "$@"'));
  assert(!shell.includes('\r')); assert(shell.includes('RIVLOOM_CLI_EXECUTABLE'));
});
test('Source engine packaging keeps shared SDK/plugin and rejects every published engine binary', () => {
  verifyEnginePackagePath('node_modules/@opencode-ai/sdk');
  verifyEnginePackagePath('node_modules/@opencode-ai/plugin');
  for (const path of ['node_modules/opencode-linux-x64-baseline', 'node_modules/opencode-windows-x64', 'node_modules/opencode-linux-arm64', 'node_modules/dependency/node_modules/opencode-linux-x64']) assert.throws(() => verifyEnginePackagePath(path));
});
test('Archive README documentation links refer to its exact public source commit', () => {
  const commit = 'a'.repeat(40);
  const text = bundledLinuxReadme('[CI](CI.md) [release](RELEASING.md) [retention](R2-RETENTION.md) [engine](ENGINE.md) [previous](releases/linux-0.1.18.md)', commit);
  for (const file of ['CI', 'RELEASING', 'R2-RETENTION', 'ENGINE', 'releases/linux-0.1.18']) assert(text.includes(`/blob/${commit}/docs/${file}.md)`));
  assert.throws(() => bundledLinuxReadme('text', 'main'));
});
test('R2 Linux allowlist cannot reach unrelated prefixes, scripts or traversal', () => {
  for (const key of ['releases/linux/latest.json', 'releases/linux/linux-v0.1.19-abcd-1/Rivloom_0.1.19_linux_x64.tar.gz', 'releases/linux/linux-v0.1.19-abcd-1/SHA256SUMS.txt']) assert.equal(downloadObjectKey(key), key);
  for (const key of ['releases/linux/install.sh', 'releases/linux/../latest.json', 'releases/linux/latest.json\n', 'releases/linux/linux-v1/install.sh', 'updates/linux/latest.json']) assert.throws(() => downloadObjectKey(key));
});
