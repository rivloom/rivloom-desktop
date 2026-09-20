import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { engineDigest, engineRecipeDigest, engineTarget, readEngineSource, verifyPreparedEngine, type EngineSource } from '../server/engine-artifact.ts';
import { prepareEngine, verifyEngineRecipe } from '../scripts/engine-prepare.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));

function artifact(directory: string, source: EngineSource, payload: string) {
  mkdirSync(directory, { recursive: true });
  const binary = Buffer.alloc(512);
  binary.write('MZ', 0, 'ascii'); binary.writeUInt32LE(128, 60);
  binary.write('PE\0\0', 128, 'ascii'); binary.writeUInt16LE(0x8664, 132); binary.writeUInt16LE(0x20b, 152);
  binary.write(payload, 256, 'utf8');
  const binarySHA256 = engineDigest(binary);
  const manifest = {
    schemaVersion: 1, version: source.version, channel: 'rivloom', target: source.target,
    builtAt: '2026-09-19T00:00:00.000Z',
    source: { repository: source.repository, commit: source.commit, tree: source.tree, dirty: false },
    upstream: source.upstream, toolchain: source.toolchain,
    packageVersions: { opencode: source.packageVersion, sdk: source.packageVersion, plugin: source.packageVersion },
    inputs: { bunLockSHA256: source.inputs['bun.lock'], modelsSHA256: source.inputs['rivloom/models.json'] },
    profile: { embedWebUI: false, signed: false, desktopIntegrated: false },
    binary: { file: 'opencode.exe', bytes: binary.length, sha256: binarySHA256 },
  };
  const smoke = { schemaVersion: 1, version: source.version, binarySHA256, passed: true,
    checks: Array.from({ length: 10 }, (_, index) => ({ name: `synthetic-check-${index}`, passed: true })) };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  const smokeBytes = JSON.stringify(smoke, null, 2) + '\n';
  for (const [file, content] of Object.entries({
    'opencode.exe': binary, 'runtime-manifest.json': manifestBytes, 'smoke-report.json': smokeBytes,
    SHA256SUMS: `${binarySHA256}  opencode.exe\n`, LICENSE: 'synthetic license\n', 'README.md': 'Synthetic metadata fixture; never execute.\n',
  })) writeFileSync(join(directory, file), content);
  return { binarySHA256, manifestSHA256: engineDigest(manifestBytes), smokeSHA256: engineDigest(smokeBytes) };
}

function fixture(t: TestContext, sameArtifact = false) {
  const base = mkdtempSync(join(tmpdir(), 'rivloom-engine-artifact-'));
  t.after(() => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert(base.startsWith(join(tmpdir(), 'rivloom-engine-artifact-')) && !lstatSync(base).isSymbolicLink());
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, 'desktop'), approved = join(base, 'approved');
  mkdirSync(join(root, 'shared'), { recursive: true });
  const source = structuredClone(readEngineSource(repository, 'windows-x64'));
  source.inputs.LICENSE = engineDigest('synthetic license\n');
  source.approvedArtifact = artifact(approved, source, 'approved');
  const lock = JSON.stringify(source, null, 2) + '\n';
  writeFileSync(join(root, 'shared/engine-source.json'), lock);
  const directory = join(root, source.artifactPath);
  const cached = artifact(directory, source, sameArtifact ? 'approved' : 'independent-source-build');
  const proof = JSON.stringify({ commit: source.commit, tree: source.tree, clean: true, inputs: source.inputs,
    files: 7, sourceSHA256: engineDigest('synthetic source snapshot') }, null, 2) + '\n';
  writeFileSync(join(directory, 'source-proof.json'), proof);
  writeFileSync(join(directory, 'engine-build.json'), JSON.stringify({
    schemaVersion: 1, kind: 'rivloom-engine-build', mode: 'source-build', sourceLockSHA256: engineDigest(lock),
    commit: source.commit, tree: source.tree, ...cached, sourceProofSHA256: engineDigest(proof),
  }, null, 2) + '\n');
  return { base, root, approved, directory, source, cached };
}

test('prepared engine verifies a source-build receipt independently of the approved import bytes', (t) => {
  const value = fixture(t);
  const verified = verifyPreparedEngine(value.root, 'windows-x64');
  assert.equal(verified.binarySHA256, value.cached.binarySHA256);
  assert.notEqual(verified.binarySHA256, value.source.approvedArtifact!.binarySHA256);
});

if (process.platform === 'win32' && process.arch === 'x64') {
  test('explicit reviewed artifact import rejects a different already-prepared source-build cache', async (t) => {
    const value = fixture(t);
    const before = readFileSync(join(value.directory, 'opencode.exe'));
    await assert.rejects(prepareEngine(value.root, { mode: 'artifact', path: value.approved }));
    assert.deepEqual(readFileSync(join(value.directory, 'opencode.exe')), before, 'A cache conflict must preserve existing bytes');
  });

  test('explicit reviewed artifact import can reuse a byte-identical verified cache', async (t) => {
    const value = fixture(t, true);
    const result = await prepareEngine(value.root, { mode: 'artifact', path: value.approved });
    assert.equal(result.binarySHA256, value.source.approvedArtifact!.binarySHA256);
  });
}

test('prepared engine rejects a junction in the workspace-to-vendor ancestor chain', (t) => {
  const value = fixture(t);
  const target = join(value.base, 'external-vendor');
  renameSync(join(value.root, 'vendor'), target);
  symlinkSync(target, join(value.root, 'vendor'), 'junction');
  assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /link|directory|ancestor|escape/i);
});

function linuxFixture(t: TestContext) {
  const value = fixture(t);
  const source: EngineSource = { ...value.source, target: 'linux-x64', artifactPath: `vendor/rivloom-opencode/linux-x64/${value.source.commit.slice(0, 12)}`,
    recipe: { directory: 'scripts/runtime-linux', files: Object.fromEntries(['artifact.mjs', 'build.mjs', 'runtime.json', 'smoke.mjs'].map(file => [file, engineDigest(file)])) } };
  delete source.approvedArtifact;
  source.inputs['packages/opencode/script/build.ts'] = engineDigest('pinned compiler');
  const directory = join(value.root, source.artifactPath); mkdirSync(directory, { recursive: true });
  mkdirSync(join(value.root, source.recipe!.directory), { recursive: true });
  for (const file of Object.keys(source.recipe!.files)) writeFileSync(join(value.root, source.recipe!.directory, file), file);
  const binary = Buffer.alloc(512); binary.set([127, 69, 76, 70, 2, 1]); binary.writeUInt16LE(2, 16); binary.writeUInt16LE(62, 18);
  writeFileSync(join(directory, 'opencode'), binary, { mode: 0o755 });
  writeFileSync(join(directory, 'LICENSE'), 'synthetic license\n'); writeFileSync(join(directory, 'README.md'), 'Synthetic Linux fixture, never execute.\n');
  const inventory = { schemaVersion: 1, commit: source.commit, tree: source.tree, dirty: false,
    files: [...Object.entries(source.inputs), ['rivloom/README.md', engineDigest(readFileSync(join(directory, 'README.md')))]]
      .map(([path, sha256]) => ({ path, sha256, tracked: true, type: 'file' })) };
  const inventoryBytes = JSON.stringify(inventory) + '\n'; writeFileSync(join(directory, 'source-files.json'), inventoryBytes);
  const manifest = { schemaVersion: 2, version: source.version, target: source.target, channel: 'rivloom',
    source: { repository: source.repository, commit: source.commit, tree: source.tree, dirty: false,
      inventory: { file: 'source-files.json', sha256: engineDigest(inventoryBytes), files: inventory.files.length } },
    upstream: source.upstream, recipe: { files: source.recipe!.files, sha256: engineRecipeDigest(source) },
    toolchain: { ...source.toolchain, nodeExecutableSHA256: engineDigest('node'), bunExecutableSHA256: engineDigest('bun') },
    packageVersions: { opencode: source.packageVersion, sdk: source.packageVersion, plugin: source.packageVersion },
    inputs: { bunLockSHA256: source.inputs['bun.lock'], modelsSHA256: source.inputs['rivloom/models.json'], files: source.inputs },
    profile: { embedWebUI: false, baseline: true, libc: 'glibc' }, binary: { file: 'opencode', bytes: binary.length, sha256: engineDigest(binary) },
    artifacts: ['LICENSE', 'README.md', 'source-files.json'].map(file => ({ file, bytes: readFileSync(join(directory, file)).length, sha256: engineDigest(readFileSync(join(directory, file))) })) };
  const manifestBytes = JSON.stringify(manifest) + '\n'; writeFileSync(join(directory, 'runtime-manifest.json'), manifestBytes);
  const smoke = { schemaVersion: 2, version: source.version, binarySHA256: manifest.binary.sha256, manifestSHA256: engineDigest(manifestBytes),
    sourceInventorySHA256: manifest.source.inventory.sha256, licenseSHA256: source.inputs.LICENSE,
    recipeSHA256: engineRecipeDigest(source), harnessSHA256: source.recipe!.files['smoke.mjs'], passed: true,
    checks: Array.from({ length: 11 }, (_, index) => ({ name: `synthetic-${index}`, passed: true })) };
  const smokeBytes = JSON.stringify(smoke) + '\n'; writeFileSync(join(directory, 'smoke-report.json'), smokeBytes);
  const sums = () => writeFileSync(join(directory, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode', 'runtime-manifest.json', 'smoke-report.json', 'source-files.json'].map(file => `${engineDigest(readFileSync(join(directory, file)))}  ${file}\n`).join(''));
  sums();
  const lock = JSON.stringify(source) + '\n'; writeFileSync(join(value.root, 'shared/engine-source-linux.json'), lock);
  const proof = JSON.stringify({ commit: source.commit, tree: source.tree, clean: true, inputs: source.inputs, files: inventory.files.length, sourceSHA256: engineDigest('all source') }) + '\n';
  writeFileSync(join(directory, 'source-proof.json'), proof);
  const receipt = { schemaVersion: 1, kind: 'rivloom-engine-build', mode: 'source-build', commit: source.commit, tree: source.tree,
    sourceLockSHA256: engineDigest(lock), binarySHA256: manifest.binary.sha256, manifestSHA256: engineDigest(manifestBytes), smokeSHA256: engineDigest(smokeBytes),
    sourceProofSHA256: engineDigest(proof), recipeSHA256: engineRecipeDigest(source) };
  writeFileSync(join(directory, 'engine-build.json'), JSON.stringify(receipt));
  return { ...value, source, directory, inventory, manifest, smoke, receipt, sums };
}

// Refresh all self-reported hashes so negative cases exercise pinned provenance,
// not a stale outer checksum. No synthetic executable is run by these tests.
function rehashLinuxMetadata(value: ReturnType<typeof linuxFixture>) {
  const write = (name: string, data: unknown) => writeFileSync(join(value.directory, name), JSON.stringify(data) + '\n');
  write('source-files.json', value.inventory);
  value.manifest.source.inventory.sha256 = engineDigest(readFileSync(join(value.directory, 'source-files.json')));
  value.manifest.source.inventory.files = value.inventory.files.length;
  for (const item of value.manifest.artifacts) {
    const bytes = readFileSync(join(value.directory, item.file));
    item.bytes = bytes.length; item.sha256 = engineDigest(bytes);
  }
  value.manifest.binary.sha256 = engineDigest(readFileSync(join(value.directory, 'opencode')));
  write('runtime-manifest.json', value.manifest);
  value.smoke.manifestSHA256 = engineDigest(readFileSync(join(value.directory, 'runtime-manifest.json')));
  value.smoke.sourceInventorySHA256 = value.manifest.source.inventory.sha256;
  value.smoke.binarySHA256 = value.manifest.binary.sha256;
  write('smoke-report.json', value.smoke);
  value.receipt.binarySHA256 = value.manifest.binary.sha256;
  value.receipt.manifestSHA256 = value.smoke.manifestSHA256;
  value.receipt.smokeSHA256 = engineDigest(readFileSync(join(value.directory, 'smoke-report.json')));
  write('engine-build.json', value.receipt);
  value.sums();
}

test('Linux ELF artifact binds clean core, external recipe, inventory, smoke and consumer receipt', t => {
  const value = linuxFixture(t);
  const verified = verifyPreparedEngine(value.root, 'linux-x64');
  assert.equal(verified.source.target, 'linux-x64');
  assert.equal(verified.recipeSHA256, engineRecipeDigest(value.source));
  verifyEngineRecipe(value.root, value.source);
});

test('Linux rejects unsupported ARM64 and a Windows executable even with rewritten checksum list', t => {
  assert.throws(() => engineTarget('linux', 'arm64'), /ARM64/);
  const value = linuxFixture(t);
  writeFileSync(join(value.directory, 'opencode'), readFileSync(join(value.root, value.source.artifactPath.replace('linux-x64', 'windows-x64'), 'opencode.exe')));
  value.sums();
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /ELF64/);
});

test('Linux checks external recipe bytes before executing build scripts', t => {
  const value = linuxFixture(t);
  writeFileSync(join(value.root, value.source.recipe!.directory, 'build.mjs'), 'unexpected script');
  assert.throws(() => verifyEngineRecipe(value.root, value.source), /recipe differs/);
});

test('Linux rejects a rewritten smoke report attached to a different producer manifest', t => {
  const value = linuxFixture(t);
  value.smoke.manifestSHA256 = engineDigest('other manifest');
  const bytes = JSON.stringify(value.smoke); writeFileSync(join(value.directory, 'smoke-report.json'), bytes); value.sums();
  value.receipt.smokeSHA256 = engineDigest(bytes); writeFileSync(join(value.directory, 'engine-build.json'), JSON.stringify(value.receipt));
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'));
});

test('Linux rejects a consumer receipt for a different build recipe', t => {
  const value = linuxFixture(t);
  value.receipt.recipeSHA256 = engineDigest('other recipe'); writeFileSync(join(value.directory, 'engine-build.json'), JSON.stringify(value.receipt));
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /recipe changed/);
});

test('Linux rejects missing artifact and does not load an official npm executable', t => {
  const value = linuxFixture(t);
  renameSync(join(value.directory, 'opencode'), join(value.directory, 'opencode.saved'));
  mkdirSync(join(value.root, 'node_modules/opencode-linux-x64-baseline/bin'), { recursive: true });
  writeFileSync(join(value.root, 'node_modules/opencode-linux-x64-baseline/bin/opencode'), 'not a fallback');
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /ENOENT/);
});

test('Linux rejects mixed source inventory even when manifest, smoke, receipt and checksum hashes are refreshed', t => {
  const value = linuxFixture(t);
  const input = value.inventory.files.find(item => item.path === 'bun.lock')!;
  input.sha256 = engineDigest('different dependency graph');
  rehashLinuxMetadata(value);
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /Source inventory disagrees with pin: bun.lock/);
});

test('Linux rejects a rehashed README from another source inventory', t => {
  const value = linuxFixture(t);
  writeFileSync(join(value.directory, 'README.md'), 'Documentation from another source checkout.\n');
  rehashLinuxMetadata(value);
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /README differs from its source inventory/);
});

test('Linux rejects a rehashed consumer source proof with a different source file count', t => {
  const value = linuxFixture(t);
  const path = join(value.directory, 'source-proof.json');
  const proof = JSON.parse(readFileSync(path, 'utf8')); proof.files++;
  const bytes = JSON.stringify(proof) + '\n'; writeFileSync(path, bytes);
  value.receipt.sourceProofSHA256 = engineDigest(bytes);
  writeFileSync(join(value.directory, 'engine-build.json'), JSON.stringify(value.receipt));
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /Consumer and producer source counts differ/);
});

test('Linux rejects a rehashed relocatable ELF object instead of an executable', t => {
  const value = linuxFixture(t);
  const path = join(value.directory, 'opencode'), bytes = readFileSync(path);
  bytes.writeUInt16LE(1, 16); writeFileSync(path, bytes);
  rehashLinuxMetadata(value);
  assert.throws(() => verifyPreparedEngine(value.root, 'linux-x64'), /executable or PIE ELF/);
});

if (process.platform === 'win32' && process.arch === 'x64') {
  test('Windows native preparation reuses its verified cache alongside a Linux source lock', async t => {
    const value = linuxFixture(t);
    const result = await prepareEngine(value.root);
    assert.equal(result.source.target, 'windows-x64');
    assert.equal(result.binarySHA256, value.cached.binarySHA256);
    assert.equal(result.recipeSHA256, undefined);
  });
}
