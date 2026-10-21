import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPlatform, desktopPlatforms, assertMacosArm64Executable, mergeDesktopConfig } from '../scripts/desktop-platform.ts';
import { engineBinaryName, engineDigest, engineRecipeDigest, engineSourceFile, engineSourceInventoryDigest, engineTarget, readEngineSource, verifyPreparedEngine } from '../server/engine-artifact.ts';
import { verifyEngineRecipe } from '../scripts/engine-prepare.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function machO() {
  // Header-only fixtures are deliberately non-executable and never launched.
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8); bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(8, 20);
  bytes.write('SYNTHETIC MACOS HEADER ONLY', 64);
  return bytes;
}
function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'rivloom-macos-runtime-'));
  t.after(() => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert(base.startsWith(join(tmpdir(), 'rivloom-macos-runtime-')) && !lstatSync(base).isSymbolicLink());
    rmSync(base, { recursive: true, force: true });
  });
  const source = structuredClone(readEngineSource(repository, 'darwin-arm64'));
  const root = join(base, 'desktop'), directory = join(root, source.artifactPath);
  mkdirSync(directory, { recursive: true }); mkdirSync(join(root, 'shared'), { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), json(value));
  for (const name of Object.keys(source.inputs)) source.inputs[name] = engineDigest(`synthetic:${name}`);
  writeFileSync(join(directory, 'LICENSE'), 'synthetic:LICENSE');
  writeFileSync(join(directory, 'README.md'), 'Synthetic metadata fixture; never execute.\n');
  writeFileSync(join(directory, 'opencode'), machO(), { mode: 0o755 });
  const recipe = source.recipe!;
  mkdirSync(join(root, recipe.directory), { recursive: true });
  for (const file of Object.keys(recipe.files)) {
    writeFileSync(join(root, recipe.directory, file), file);
    recipe.files[file] = engineDigest(file);
  }
  const inventory = { schemaVersion: 1, commit: source.commit, tree: source.tree, dirty: false, status: [],
    files: [...Object.entries(source.inputs), ['rivloom/README.md', engineDigest(readFileSync(join(directory, 'README.md')))]]
      .map(([path, sha256]) => ({ path, sha256, tracked: true, type: 'file', mode: '100644', bytes: 12 })) };
  source.sourceInventory = { files: inventory.files.length, sha256: engineSourceInventoryDigest(inventory.files) };
  const record = (file: string) => ({ file, bytes: readFileSync(join(directory, file)).length, sha256: engineDigest(readFileSync(join(directory, file))) });
  write('source-files.json', inventory);
  const manifest = { schemaVersion: 2, version: source.version, target: source.target, channel: 'rivloom',
    source: { repository: source.repository, commit: source.commit, tree: source.tree, dirty: false,
      inventory: { file: 'source-files.json', sha256: record('source-files.json').sha256, files: inventory.files.length } },
    upstream: source.upstream, recipe: { files: recipe.files, sha256: engineRecipeDigest(source) },
    toolchain: { ...source.toolchain, nodeExecutableSHA256: engineDigest('node'), bunExecutableSHA256: engineDigest('bun') },
    packageVersions: { opencode: source.packageVersion, sdk: source.packageVersion, plugin: source.packageVersion },
    inputs: { bunLockSHA256: source.inputs['bun.lock'], modelsSHA256: source.inputs['rivloom/models.json'], files: source.inputs },
    profile: { embedWebUI: false, baseline: false, signed: true, signingIdentity: 'ad-hoc', desktopIntegrated: false },
    binary: record('opencode'), artifacts: ['LICENSE', 'README.md', 'source-files.json'].map(record) };
  const smoke = { schemaVersion: 2, version: source.version, binarySHA256: manifest.binary.sha256,
    manifestSHA256: '', sourceInventorySHA256: manifest.source.inventory.sha256, licenseSHA256: source.inputs.LICENSE,
    recipeSHA256: engineRecipeDigest(source), harnessSHA256: recipe.files['smoke.mjs'], passed: true,
    checks: Array.from({ length: 11 }, (_, index) => ({ name: `synthetic-${index}`, passed: true })) };
  const lock = json(source); writeFileSync(join(root, 'shared/engine-source-macos.json'), lock);
  const proof = { commit: source.commit, tree: source.tree, clean: true, inputs: source.inputs,
    files: inventory.files.length, sourceSHA256: source.sourceInventory.sha256 };
  write('source-proof.json', proof);
  const receipt = { schemaVersion: 1, kind: 'rivloom-engine-build', mode: 'source-build', commit: source.commit, tree: source.tree,
    sourceLockSHA256: engineDigest(lock), binarySHA256: manifest.binary.sha256, manifestSHA256: '', smokeSHA256: '',
    sourceProofSHA256: record('source-proof.json').sha256, recipeSHA256: engineRecipeDigest(source) };
  const rehash = () => {
    write('source-files.json', inventory);
    manifest.source.inventory.sha256 = record('source-files.json').sha256;
    manifest.source.inventory.files = inventory.files.length;
    manifest.binary = record('opencode');
    manifest.artifacts = ['LICENSE', 'README.md', 'source-files.json'].map(record);
    write('runtime-manifest.json', manifest);
    smoke.binarySHA256 = manifest.binary.sha256; smoke.manifestSHA256 = record('runtime-manifest.json').sha256;
    smoke.sourceInventorySHA256 = manifest.source.inventory.sha256;
    write('smoke-report.json', smoke);
    receipt.binarySHA256 = manifest.binary.sha256; receipt.manifestSHA256 = smoke.manifestSHA256;
    receipt.smokeSHA256 = record('smoke-report.json').sha256;
    write('engine-build.json', receipt);
    writeFileSync(join(directory, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode', 'runtime-manifest.json', 'smoke-report.json', 'source-files.json'].map(file => `${record(file).sha256}  ${file}\n`).join(''));
  };
  rehash();
  return { root, directory, source, manifest, inventory, smoke, receipt, rehash };
}

test('desktop and engine targets explicitly support Apple Silicon without enabling untested architectures', () => {
  assert.equal(desktopPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(engineTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(desktopPlatform('win32', 'x64'), 'windows-x64');
  assert.equal(engineTarget('linux', 'x64'), 'linux-x64');
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64']] as const) {
    assert.throws(() => desktopPlatform(platform, arch), /Unsupported/);
    assert.throws(() => engineTarget(platform, arch), /Unsupported/);
  }
  assert.equal(engineSourceFile('darwin-arm64'), 'shared/engine-source-macos.json');
  assert.equal(engineBinaryName(readEngineSource(repository, 'darwin-arm64')), 'opencode');
  assert.equal(desktopPlatforms['darwin-arm64'].executable, 'node');
  assert.match(desktopPlatforms['darwin-arm64'].url, /^https:\/\/nodejs\.org\/dist\/v24\.19\.0\/node-v24\.19\.0-darwin-arm64\.tar\.gz$/);
});

test('Mac product configuration uses platform identity and replaces installation targets', () => {
  const base = { identifier: 'com.rivloom.desktop', version: '0.1.31', bundle: { targets: ['nsis'], resources: { a: 'b' }, windows: { x: true } } };
  const merged = mergeDesktopConfig(base, { identifier: 'com.rivloom.macospreview', bundle: { targets: ['app', 'dmg'], windows: null } });
  assert.deepEqual(merged, { identifier: 'com.rivloom.macospreview', version: '0.1.31', bundle: { targets: ['app', 'dmg'], resources: { a: 'b' } } });
  assert.equal(base.identifier, 'com.rivloom.desktop');
  assert.throws(() => mergeDesktopConfig({}, JSON.parse('{"__proto__":{"polluted":true}}')), /Invalid configuration key/);
});

test('Mac Node identity rejects Intel, ARM64e, universal, object and truncated headers', () => {
  assertMacosArm64Executable(machO());
  for (const [offset, value] of [[0, 0xcafebabe], [4, 0x01000007], [8, 2], [12, 1], [16, 0], [20, 0xffffffff]]) {
    const bytes = machO(); bytes.writeUInt32LE(value, offset);
    assert.throws(() => assertMacosArm64Executable(bytes));
  }
  assert.throws(() => assertMacosArm64Executable(Buffer.alloc(20)));
});

test('Mac engine binds Mach-O bytes, pinned recipe, complete inventory and source-build receipt', t => {
  const value = fixture(t);
  assert.equal(verifyPreparedEngine(value.root, 'darwin-arm64').binarySHA256, value.manifest.binary.sha256);
  verifyEngineRecipe(value.root, value.source);
});

test('Mac recipe cannot be substituted by the Linux recipe or omit complete source inventory', t => {
  const value = fixture(t), path = join(value.root, 'shared/engine-source-macos.json');
  for (const mutate of [
    (source: typeof value.source) => { source.recipe!.directory = 'scripts/runtime-linux'; },
    (source: typeof value.source) => { delete source.sourceInventory; },
  ]) {
    const source = structuredClone(value.source); mutate(source); writeFileSync(path, json(source));
    assert.throws(() => readEngineSource(value.root, 'darwin-arm64'), /another platform|complete reviewed source inventory/);
  }
});

test('Mac engine rejects wrong architecture and non-executable Mach-O even if metadata is rehashed', t => {
  const value = fixture(t);
  for (const [offset, field] of [[4, 0x01000007], [8, 2], [12, 1], [20, 0xffffffff]]) {
    const bytes = machO(); bytes.writeUInt32LE(field, offset); writeFileSync(join(value.directory, 'opencode'), bytes);
    value.rehash();
    assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /Mach-O/);
  }
});

test('Mac source inventory remains pinned after outer hashes are rewritten', t => {
  const value = fixture(t);
  value.inventory.files[0].sha256 = engineDigest('changed source'); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /Complete source inventory differs/);
});

test('Mac producer rejects unsigned or wrong-platform profiles and incomplete smoke reports', t => {
  const value = fixture(t);
  value.manifest.profile.signed = false; value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'));
  value.manifest.profile.signed = true; value.manifest.profile.baseline = true; value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'));
  value.manifest.profile.baseline = false; value.smoke.checks.pop(); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /Incomplete engine smoke/);
});

test('repository Mac recipe has current reviewed hashes and matches the fixed core and toolchain', () => {
  const source = readEngineSource(repository, 'darwin-arm64');
  verifyEngineRecipe(repository, source);
  const config = JSON.parse(readFileSync(join(repository, source.recipe!.directory, 'runtime.json'), 'utf8'));
  assert.equal(config.source.commit, source.commit); assert.equal(config.source.tree, source.tree);
  assert.equal(config.target, source.target); assert.equal(config.bun.sha256, source.toolchain.bunArchiveSHA256);
  assert.equal(config.nodeVersion, source.toolchain.node); assert.deepEqual(config.inputs, source.inputs);
});
