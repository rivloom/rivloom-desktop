import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { engineDigest, engineRecipeDigest, engineVerificationDigest, engineSourceInventoryDigest, engineTarget, readEngineSource, verifyEngineArtifact, verifyEngineProducer, verifyPreparedEngine, type EngineSource } from '../server/engine-artifact.ts';
import { prepareEngine, verifyEngineRecipe, verifyEngineVerification } from '../scripts/engine-prepare.ts';
import { capturePublicationWorkspace, publicationFailureMatches, recoverPublication, type ProducerFailure } from '../scripts/engine-publication.ts';
import { pathToFileURL } from 'node:url';

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
    ...(source.verification ? { manifestSHA256: engineDigest(JSON.stringify(manifest, null, 2) + '\n'), verificationSHA256: engineVerificationDigest(source),
      verificationFiles: source.verification.files, harnessSHA256: source.verification.files['scripts/runtime-windows/smoke.mjs'],
      stops: [{ stopped: true, recorded: 1, rootExited: true, proof: 'taskkill', code: 0 }, { stopped: true, recorded: 1, rootExited: true, proof: 'observed-exit', code: 128 }] } : {}),
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
  // These cases exercise the retained schema 1 contract even after the repository pin moves on.
  source.producerSchemaVersion = 1;
  delete source.sourceInventory;
  if (source.verification) delete source.verification.files['server/engine-artifact.ts'];
  for (const file of Object.keys(source.verification?.files || {})) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), readFileSync(join(repository, file))); }
  if (source.verification) source.verification.files = Object.fromEntries(Object.keys(source.verification.files).map(file => [file, engineDigest(readFileSync(join(root, file)))]));
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
    ...(source.verification ? { verificationSHA256: engineVerificationDigest(source) } : {}),
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

test('Windows verification rejects a changed harness before executing it', t => {
  const value = fixture(t);
  verifyEngineVerification(value.root, value.source);
  writeFileSync(join(value.root, 'scripts/runtime-windows/smoke.mjs'), 'changed verifier');
  assert.throws(() => verifyEngineVerification(value.root, value.source), /verification differs/);
});

test('Windows smoke rejects rehashed reports with missing exit proof or a different producer', t => {
  const value = fixture(t);
  const file = join(value.directory, 'smoke-report.json'), original = JSON.parse(readFileSync(file, 'utf8'));
  const receiptFile = join(value.directory, 'engine-build.json'), receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  for (const change of [
    (smoke: typeof original) => { smoke.stops[0].rootExited = false; },
    (smoke: typeof original) => { smoke.stops[0].recorded = 0; },
    (smoke: typeof original) => { smoke.stops[0].proof = 'unproven'; },
    (smoke: typeof original) => { smoke.stops[0].code = 128; },
    (smoke: typeof original) => { smoke.manifestSHA256 = engineDigest('other producer'); },
    (smoke: typeof original) => { smoke.verificationSHA256 = engineDigest('other verification'); },
  ]) {
    const smoke = structuredClone(original); change(smoke); const bytes = JSON.stringify(smoke);
    writeFileSync(file, bytes); writeFileSync(receiptFile, JSON.stringify({ ...receipt, smokeSHA256: engineDigest(bytes) }));
    assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /exit proof|different producer|verification recipe/);
  }
});

function linuxFixture(t: TestContext) {
  const value = fixture(t);
  const source: EngineSource = { ...value.source, target: 'linux-x64', artifactPath: `vendor/rivloom-opencode/linux-x64/${value.source.commit.slice(0, 12)}`,
    producerSchemaVersion: 2,
    recipe: { directory: 'scripts/runtime-linux', files: Object.fromEntries(['artifact.mjs', 'build.mjs', 'runtime.json', 'smoke.mjs'].map(file => [file, engineDigest(file)])) } };
  delete source.approvedArtifact;
  delete source.verification;
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

function windowsSchema2Fixture(t: TestContext) {
  const value = fixture(t);
  const source: EngineSource = { ...value.source, producerSchemaVersion: 2 };
  delete source.approvedArtifact;
  const helper = readFileSync(join(repository, 'server/engine-artifact.ts'));
  writeFileSync(join(value.root, 'server/engine-artifact.ts'), helper);
  source.verification = { files: { ...source.verification!.files, 'server/engine-artifact.ts': engineDigest(helper) } };
  for (const file of ['rivloom/artifact.mjs', 'packages/opencode/script/build.ts']) source.inputs[file] = engineDigest(`pinned ${file}`);
  const directory = value.directory;
  const inventory = { schemaVersion: 1, commit: source.commit, tree: source.tree, dirty: false, status: [],
    files: [...Object.entries(source.inputs), ['rivloom/README.md', engineDigest(readFileSync(join(directory, 'README.md')))],
      ['packages/opencode/src/session/processor.ts', engineDigest('complete source, beyond selected inputs')]]
      .map(([path, sha256]) => ({ path, mode: '100644', bytes: 42, sha256, tracked: true, type: 'file' })) };
  source.sourceInventory = { files: inventory.files.length, sha256: engineSourceInventoryDigest(inventory.files) };
  const original = JSON.parse(readFileSync(join(directory, 'runtime-manifest.json'), 'utf8'));
  const manifest = { ...original, schemaVersion: 2,
    source: { ...original.source, inventory: { file: 'source-files.json', files: inventory.files.length, sha256: '' } },
    toolchain: { ...source.toolchain, nodeExecutableSHA256: engineDigest('node'), bunExecutableSHA256: engineDigest('bun') },
    inputs: { ...original.inputs, files: Object.fromEntries(['rivloom/runtime.json', 'rivloom/build.ps1', 'rivloom/build.mjs',
      'rivloom/artifact.mjs', 'rivloom/smoke.mjs', 'packages/opencode/script/build.ts'].map(file => [file, source.inputs[file]])) },
    artifacts: ['LICENSE', 'README.md', 'source-files.json'].map(file => ({ file, bytes: 0, sha256: '' })) };
  const smoke = { ...JSON.parse(readFileSync(join(directory, 'smoke-report.json'), 'utf8')), schemaVersion: 2,
    sourceInventorySHA256: '', licenseSHA256: source.inputs.LICENSE,
    verificationFiles: source.verification.files, verificationSHA256: engineVerificationDigest(source) };
  const lock = JSON.stringify(source) + '\n'; writeFileSync(join(value.root, 'shared/engine-source.json'), lock);
  const proof = JSON.stringify({ commit: source.commit, tree: source.tree, clean: true, inputs: source.inputs,
    files: inventory.files.length, sourceSHA256: source.sourceInventory.sha256 }) + '\n';
  writeFileSync(join(directory, 'source-proof.json'), proof);
  const receipt = { ...JSON.parse(readFileSync(join(directory, 'engine-build.json'), 'utf8')), sourceLockSHA256: engineDigest(lock),
    sourceProofSHA256: engineDigest(proof), verificationSHA256: engineVerificationDigest(source) };
  const result = { ...value, source, inventory, manifest, smoke, receipt };
  rehashWindowsMetadata(result);
  return result;
}

function rehashWindowsMetadata(value: ReturnType<typeof windowsSchema2Fixture>) {
  const write = (file: string, body: unknown) => writeFileSync(join(value.directory, file), JSON.stringify(body) + '\n');
  write('source-files.json', value.inventory);
  value.manifest.source.inventory.sha256 = engineDigest(readFileSync(join(value.directory, 'source-files.json')));
  value.manifest.source.inventory.files = value.inventory.files.length;
  value.manifest.binary.sha256 = engineDigest(readFileSync(join(value.directory, 'opencode.exe')));
  value.manifest.binary.bytes = readFileSync(join(value.directory, 'opencode.exe')).length;
  for (const row of value.manifest.artifacts) { const bytes = readFileSync(join(value.directory, row.file)); row.bytes = bytes.length; row.sha256 = engineDigest(bytes); }
  write('runtime-manifest.json', value.manifest);
  value.smoke.manifestSHA256 = engineDigest(readFileSync(join(value.directory, 'runtime-manifest.json')));
  value.smoke.binarySHA256 = value.manifest.binary.sha256;
  value.smoke.sourceInventorySHA256 = value.manifest.source.inventory.sha256;
  write('smoke-report.json', value.smoke);
  Object.assign(value.receipt, { binarySHA256: value.manifest.binary.sha256, manifestSHA256: value.smoke.manifestSHA256,
    smokeSHA256: engineDigest(readFileSync(join(value.directory, 'smoke-report.json'))) });
  write('engine-build.json', value.receipt);
  writeFileSync(join(value.directory, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode.exe', 'runtime-manifest.json', 'source-files.json', 'smoke-report.json']
    .map(file => `${engineDigest(readFileSync(join(value.directory, file)))}  ${file}\n`).join(''));
}

test('Windows schema 2 binds the complete source inventory and supports independent source builds', t => {
  const value = windowsSchema2Fixture(t);
  assert.equal(verifyPreparedEngine(value.root, 'windows-x64').binarySHA256, value.manifest.binary.sha256);
  assert.equal(verifyEngineProducer(value.directory, value.source).manifest.schemaVersion, 2);
  assert.throws(() => verifyEngineArtifact(value.directory, value.source, true), /no approved artifact import/);
});

test('Windows schema 2 pins the shared producer verifier before the consumer smoke can execute', t => {
  const value = windowsSchema2Fixture(t);
  verifyEngineVerification(value.root, value.source);
  writeFileSync(join(value.root, 'server/engine-artifact.ts'), 'changed producer verifier');
  assert.throws(() => verifyEngineVerification(value.root, value.source), /verification differs/);
});

test('Windows schema 2 inventory hashes are portable across entry order and symlink materialization', () => {
  const files = [{ path: 'z-link', mode: '120000', sha256: engineDigest('target') }, { path: 'a-file', mode: '100755', sha256: engineDigest('source') }];
  assert.equal(engineSourceInventoryDigest(files), engineSourceInventoryDigest([...files].reverse()));
  assert.notEqual(engineSourceInventoryDigest(files), engineSourceInventoryDigest(files.map(row => ({ ...row, mode: '100644' }))));
});

test('Windows schema 2 requires an explicit complete inventory and reviewed producer inputs', t => {
  const value = windowsSchema2Fixture(t);
  const path = join(value.root, 'shared/engine-source.json');
  for (const change of [
    (source: EngineSource) => { delete source.sourceInventory; },
    (source: EngineSource) => { delete source.verification; },
    (source: EngineSource) => { delete source.inputs['rivloom/artifact.mjs']; },
    (source: EngineSource) => { delete source.inputs['packages/opencode/script/build.ts']; },
  ]) {
    const source = structuredClone(value.source); change(source); writeFileSync(path, JSON.stringify(source));
    assert.throws(() => readEngineSource(value.root, 'windows-x64'), /requires|Missing reviewed/);
  }
});

test('Windows schema 2 rejects refreshed hashes for source bytes and modes beyond the selected inputs', t => {
  for (const change of [
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files.at(-1)!.sha256 = engineDigest('other source'); },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files.at(-1)!.mode = '100755'; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files.pop(); },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files[0].sha256 = engineDigest('different dependency graph'); },
  ]) {
    const value = windowsSchema2Fixture(t); change(value); rehashWindowsMetadata(value);
    assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /source inventory|Source inventory/);
  }
});

test('Windows schema 2 rejects malformed, dirty and duplicate source inventories after metadata is rehashed', t => {
  for (const change of [
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files[0].tracked = false; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files[0].bytes = -1; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files[0].mode = '160000'; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.files.at(-1)!.path = value.inventory.files[0].path; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.schemaVersion = 2; },
    (value: ReturnType<typeof windowsSchema2Fixture>) => { value.inventory.dirty = true; },
  ]) {
    const value = windowsSchema2Fixture(t); change(value); rehashWindowsMetadata(value);
    assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'));
  }
});

test('Windows schema 2 rejects a source proof changed alongside its receipt digest', t => {
  const value = windowsSchema2Fixture(t), path = join(value.directory, 'source-proof.json');
  const proof = JSON.parse(readFileSync(path, 'utf8')); proof.sourceSHA256 = engineDigest('other source snapshot');
  writeFileSync(path, JSON.stringify(proof)); value.receipt.sourceProofSHA256 = engineDigest(readFileSync(path));
  rehashWindowsMetadata(value);
  assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /snapshot differs from the reviewed/);
});

test('Windows schema 2 rejects schema changes and altered binary identity despite refreshed metadata', t => {
  for (const schema of [1, 3]) {
    const value = windowsSchema2Fixture(t); value.manifest.schemaVersion = schema; value.smoke.schemaVersion = schema;
    rehashWindowsMetadata(value);
    assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /Producer schema differs/);
  }
  const value = windowsSchema2Fixture(t), path = join(value.directory, 'opencode.exe'), binary = readFileSync(path);
  binary.writeUInt16LE(0xaa64, 132); writeFileSync(path, binary); rehashWindowsMetadata(value);
  assert.throws(() => verifyPreparedEngine(value.root, 'windows-x64'), /Windows x64 PE32\+/);
});

test('Windows schema 2 approved import hashes reject a rehashed replacement binary', t => {
  const value = windowsSchema2Fixture(t);
  value.source.approvedArtifact = { binarySHA256: value.receipt.binarySHA256, manifestSHA256: value.receipt.manifestSHA256, smokeSHA256: value.receipt.smokeSHA256 };
  verifyEngineArtifact(value.directory, value.source, true);
  const path = join(value.directory, 'opencode.exe'), binary = readFileSync(path); binary[300] ^= 1; writeFileSync(path, binary);
  assert.throws(() => verifyEngineProducer(value.directory, value.source), /binary SHA256 mismatch/);
  rehashWindowsMetadata(value);
  assert.throws(() => verifyEngineArtifact(value.directory, value.source, true), /Imported engine differs/);
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

test('Windows source checkout preserves Git symlink target bytes despite inherited link and CRLF settings', t => {
  const value = fixture(t), objects = join(value.base, 'objects'), checkout = join(value.base, 'checkout');
  mkdirSync(objects);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: objects, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet');
  writeFileSync(join(objects, 'source.txt'), 'ordinary source\n');
  git('add', 'source.txt');
  const target = '../targets/source.txt';
  const linkObject = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: objects, input: target, encoding: 'utf8', windowsHide: true }).trim();
  git('update-index', '--add', '--cacheinfo', '120000,' + linkObject + ',nested/link.txt');
  git('-c', 'user.name=Rivloom test', '-c', 'user.email=ci@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source with a Git link');
  const source = { ...value.source, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    upstream: { ...value.source.upstream, commit: git('rev-parse', 'HEAD') }, inputs: { 'source.txt': engineDigest('ordinary source\n') },
    sourceInventory: { files: 2, sha256: engineSourceInventoryDigest([
      { path: 'source.txt', mode: '100644', sha256: engineDigest('ordinary source\n') },
      { path: 'nested/link.txt', mode: '120000', sha256: engineDigest(target) },
    ]) } };
  const config = join(value.base, 'gitconfig');
  writeFileSync(config, '[core]\nsymlinks = true\nautocrlf = true\n');
  const entrypoint = new URL('../scripts/engine-prepare.ts', import.meta.url).href;
  const script = 'import { readFileSync } from "node:fs"; import { cloneEngineSource, sourceSnapshot } from ' + JSON.stringify(entrypoint)
    + '; const v=JSON.parse(readFileSync(0,"utf8")); cloneEngineSource(v.checkout,v.source,v.objects); console.log(JSON.stringify(sourceSnapshot(v.checkout,v.source)));';
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { input: JSON.stringify({ checkout, objects, source }), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' } });
  const proof = JSON.parse(output.trim().split('\n').at(-1)!);
  assert.equal(proof.sourceSHA256, source.sourceInventory.sha256);
  assert.equal(proof.files, 2);
  assert.equal(lstatSync(join(checkout, 'nested/link.txt')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(checkout, 'nested/link.txt'), 'utf8'), target);
  assert.equal(execFileSync('git', ['config', '--get', 'core.symlinks'], { cwd: checkout, encoding: 'utf8' }).trim(), 'false');
  assert.equal(execFileSync('git', ['config', '--get', 'core.autocrlf'], { cwd: checkout, encoding: 'utf8' }).trim(), 'false');
});

function publicationFixture(t: TestContext, options: { failUntil?: number; otherError?: boolean; archive?: boolean } = {}) {
  const value = windowsSchema2Fixture(t), checkout = join(value.root, '.data/engine-builds/build-ABC123/source');
  mkdirSync(join(checkout, 'rivloom'), { recursive: true });
  const lines = Array.from({ length: 71 }, () => '');
  lines[0] = "import { renameSync as actualRename, mkdirSync } from 'node:fs'; let calls=0; export const count=()=>calls;";
  lines[1] = `function renameSync(stage,target) { const code=++calls===2&&${!!options.otherError}?'EACCES':'EPERM'; if(calls<=${options.failUntil ?? 2}) throw Object.assign(new Error(code+\": operation not permitted, rename '\"+stage+\"' -> '\"+target+\"'\"),{errno:-4048,code,syscall:'rename',path:stage,dest:target}); actualRename(stage,target); }`;
  lines[68] = 'export function publishDirectory(root,stage,target) {';
  lines[69] = '  renameSync(stage,target)';
  lines[70] = options.archive ? "  mkdirSync(root+'/archive');" + '\n}' : '}';
  const publisher = lines.join('\n') + '\n';
  const compilerLines = Array.from({ length: 97 }, () => '');
  compilerLines[0] = "import {publishDirectory} from './artifact.mjs'; const [root,stage,target]=process.argv.slice(2);";
  compilerLines[96] = 'publishDirectory(root,stage,target)';
  const compiler = compilerLines.join('\n') + '\n';
  for (const [file, bytes] of [['rivloom/artifact.mjs', publisher], ['rivloom/build.mjs', compiler]]) {
    writeFileSync(join(checkout, file), bytes); const digest = engineDigest(bytes);
    value.source.inputs[file] = digest; value.inventory.files.find(row => row.path === file)!.sha256 = digest;
    value.manifest.inputs.files[file] = digest;
  }
  value.source.sourceInventory = { files: value.inventory.files.length, sha256: engineSourceInventoryDigest(value.inventory.files) };
  rehashWindowsMetadata(value);
  const proof = { commit: value.source.commit, tree: value.source.tree, clean: true, inputs: structuredClone(value.source.inputs),
    files: value.source.sourceInventory.files, sourceSHA256: value.source.sourceInventory.sha256 };
  const workspace = capturePublicationWorkspace(value.root, checkout, value.source, proof);
  mkdirSync(workspace.dist); const stage = join(workspace.dist, '.stage-11111111-2222-4333-8444-555555555555');
  for (const file of ['smoke-report.json', 'engine-build.json', 'source-proof.json']) rmSync(join(value.directory, file));
  writeFileSync(join(value.directory, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode.exe', 'runtime-manifest.json', 'source-files.json']
    .map(file => `${engineDigest(readFileSync(join(value.directory, file)))}  ${file}\n`).join(''));
  renameSync(value.directory, stage);
  // A real Node child executes only this synthetic publisher, never the PE fixture.
  // Its original failed publication produces the same complete native Error formatting.
  const failed = spawnSync(process.execPath, [join(checkout, 'rivloom/build.mjs'), workspace.dist, stage, workspace.target],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(failed.status, 1); assert.equal(failed.signal, null); assert(!failed.error);
  const failure: ProducerFailure = { code: failed.status, signal: failed.signal, stderr: failed.stderr, stderrOverflow: false };
  const count = async () => (await import(pathToFileURL(join(checkout, 'rivloom/artifact.mjs')).href)).count() as number;
  return { ...value, workspace, checkout, stage, proof, failure, count };
}

test('publication recovery recognizes the actual CI EPERM block and rejects misleading metadata', () => {
  const checkout = String.raw`D:\a\rivloom-desktop\rivloom-desktop\.data\engine-builds\build-zQmslY\source`;
  const stage = checkout + String.raw`\rivloom\dist\.stage-436e0ee8-f4b7-4e02-80f7-2b60e2fbacd8`, target = checkout + String.raw`\rivloom\dist\windows-x64`;
  // Preserved from permissions job 113232117314; brace belongs to the last stack line.
  const stderr = String.raw`Error: EPERM: operation not permitted, rename 'D:\a\rivloom-desktop\rivloom-desktop\.data\engine-builds\build-zQmslY\source\rivloom\dist\.stage-436e0ee8-f4b7-4e02-80f7-2b60e2fbacd8' -> 'D:\a\rivloom-desktop\rivloom-desktop\.data\engine-builds\build-zQmslY\source\rivloom\dist\windows-x64'
    at renameSync (node:fs:1074:11)
    at publishDirectory (file:///D:/a/rivloom-desktop/rivloom-desktop/.data/engine-builds/build-zQmslY/source/rivloom/artifact.mjs:70:3)
    at file:///D:/a/rivloom-desktop/rivloom-desktop/.data/engine-builds/build-zQmslY/source/rivloom/build.mjs:97:1
    at ModuleJob.run (node:internal/modules/esm/module_job:439:25)
    at async node:internal/modules/esm/loader:643:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  errno: -4048,
  code: 'EPERM',
  syscall: 'rename',
  path: 'D:\\a\\rivloom-desktop\\rivloom-desktop\\.data\\engine-builds\\build-zQmslY\\source\\rivloom\\dist\\.stage-436e0ee8-f4b7-4e02-80f7-2b60e2fbacd8',
  dest: 'D:\\a\\rivloom-desktop\\rivloom-desktop\\.data\\engine-builds\\build-zQmslY\\source\\rivloom\\dist\\windows-x64'
}
Node.js v24.19.0`;
  const paths = { stage, target, publisherURL: 'file:///D:/a/rivloom-desktop/rivloom-desktop/.data/engine-builds/build-zQmslY/source/rivloom/artifact.mjs',
    compilerURL: 'file:///D:/a/rivloom-desktop/rivloom-desktop/.data/engine-builds/build-zQmslY/source/rivloom/build.mjs' };
  const failure: ProducerFailure = { code: 1, signal: null, stderr, stderrOverflow: false };
  assert(publicationFailureMatches(failure, paths));
  for (const changed of [stderr.replace("syscall: 'rename'", "syscall: 'unlink'"), stderr.replace('artifact.mjs:70:3', 'foreign.mjs:70:3'),
    stderr.replace('code: \'EPERM\'', 'code: \'EACCES\''), stderr.replace('dest:', 'path:'), stderr + '\n' + stderr])
    assert.equal(publicationFailureMatches({ ...failure, stderr: changed }, paths), false);
});

test('publication recovery resumes only the original validated stage and leaves smoke and receipts pending', async t => {
  const value = publicationFixture(t);
  assert.throws(() => capturePublicationWorkspace(value.root, value.checkout, value.source, value.proof), /already exists/,
    'A recovery workspace cannot be adopted after the producer has already created its output');
  assert.throws(() => capturePublicationWorkspace(value.root, join(value.base, 'unowned/source'), value.source, value.proof), /equal/);
  const result = await recoverPublication(value.workspace, value.failure, () => value.proof);
  assert(result); assert.equal(result.attempts, 3); assert.equal(result.state, 'publication-recovered-awaiting-smoke');
  assert.equal(await value.count(), 3); assert(!existsSync(value.stage));
  assert.equal(verifyEngineProducer(value.workspace.target, value.source).manifest.source.commit, value.source.commit);
  assert.throws(() => verifyEngineArtifact(value.workspace.target, value.source), /ENOENT/);
  assert(!existsSync(join(value.workspace.target, 'engine-build.json'))); assert(!existsSync(value.directory));
});

test('publication recovery never retries other producer failures or an incomplete error block', async t => {
  const value = publicationFixture(t);
  for (const changed of [ { ...value.failure, code: 2 }, { ...value.failure, signal: 'SIGTERM' as const },
    { ...value.failure, stderrOverflow: true }, { ...value.failure, stderr: value.failure.stderr.replaceAll('EPERM', 'EACCES') },
    { ...value.failure, stderr: value.failure.stderr.replace('artifact.mjs:70:3', 'artifact.mjs:71:3') },
    { ...value.failure, stderr: value.failure.stderr.replaceAll(value.stage, value.stage + '-other') },
    { ...value.failure, stderr: 'EPERM rename publishDirectory ' + value.failure.stderr.split('\n')[0] } ])
    assert.equal(await recoverPublication(value.workspace, changed, () => value.proof), null);
  assert.equal(await value.count(), 0); assert(existsSync(value.stage)); assert(!existsSync(value.workspace.target));
});

test('publication recovery rejects extra stages, existing targets, links and hard links without publishing', async t => {
  for (const change of ['extra-stage', 'target', 'junction', 'dist-junction', 'hardlink', 'extra-file', 'failed-smoke'] as const) {
    const value = publicationFixture(t);
    if (change === 'extra-stage') mkdirSync(join(value.workspace.dist, '.stage-99999999-8888-4777-8666-555555555555'));
    if (change === 'target') mkdirSync(value.workspace.target);
    if (change === 'junction') { const target = join(value.base, 'linked-stage'); renameSync(value.stage, target); symlinkSync(target, value.stage, 'junction'); }
    if (change === 'dist-junction') { const target = join(value.base, 'linked-dist'); renameSync(value.workspace.dist, target); symlinkSync(target, value.workspace.dist, 'junction'); }
    if (change === 'hardlink') linkSync(join(value.stage, 'opencode.exe'), join(value.base, 'linked.exe'));
    if (change === 'extra-file') writeFileSync(join(value.stage, 'unlisted.txt'), 'extra');
    if (change === 'failed-smoke') writeFileSync(join(value.stage, 'smoke-report.json'), '{"passed":false}');
    if (change === 'extra-stage') assert.equal(await recoverPublication(value.workspace, value.failure, () => value.proof), null);
    else await assert.rejects(recoverPublication(value.workspace, value.failure, () => value.proof));
    assert.equal(await value.count(), 0, change); assert(!existsSync(value.directory));
  }
});

test('publication recovery rejects binary, checksum, source and pinned publisher changes', async t => {
  for (const change of ['binary', 'checksums', 'source', 'publisher'] as const) {
    const value = publicationFixture(t);
    if (change === 'binary') { const file = join(value.stage, 'opencode.exe'), bytes = readFileSync(file); bytes[300] ^= 1; writeFileSync(file, bytes); }
    if (change === 'checksums') writeFileSync(join(value.stage, 'SHA256SUMS'), 'not the five complete hashes');
    if (change === 'publisher') writeFileSync(join(value.checkout, 'rivloom/artifact.mjs'), 'export const publishDirectory=()=>{};');
    const proof = change === 'source' ? { ...value.proof, sourceSHA256: engineDigest('changed source') } : value.proof;
    await assert.rejects(recoverPublication(value.workspace, value.failure, () => proof));
    assert(existsSync(value.stage)); assert(!existsSync(value.workspace.target)); assert(!existsSync(value.directory));
  }
});

test('publication retry budgets do not discard slow mandatory validation or accept persistent and non-EPERM locks', async t => {
  const slow = publicationFixture(t); let elapsed = 0;
  const result = await recoverPublication(slow.workspace, slow.failure, () => { elapsed += 6000; return slow.proof; },
    { now: () => elapsed, wait: async milliseconds => { elapsed += milliseconds; } });
  assert(result); assert(result.durationMs > 5000); assert.equal(result.waitedMs, 300);
  const persistent = publicationFixture(t, { failUntil: 9 }); elapsed = 0;
  await assert.rejects(recoverPublication(persistent.workspace, persistent.failure, () => persistent.proof,
    { now: () => elapsed, wait: async milliseconds => { elapsed += milliseconds; } }), /EPERM/);
  assert.equal(await persistent.count(), 5); assert(!existsSync(persistent.workspace.target));
  const expired = publicationFixture(t); elapsed = 0;
  await assert.rejects(recoverPublication(expired.workspace, expired.failure, () => expired.proof,
    { now: () => elapsed, wait: async () => { elapsed += 5001; } }), /EPERM/);
  assert.equal(await expired.count(), 1);
  const validationExpired = publicationFixture(t); elapsed = 0;
  await assert.rejects(recoverPublication(validationExpired.workspace, validationExpired.failure, () => { elapsed = 120001; return validationExpired.proof; },
    { now: () => elapsed, wait: async () => {} }), /deadline expired/);
  assert.equal(await validationExpired.count(), 0);
  const denied = publicationFixture(t, { otherError: true });
  await assert.rejects(recoverPublication(denied.workspace, denied.failure, () => denied.proof), /EACCES/);
  assert.equal(await denied.count(), 2);
});

test('publication recovery detects byte changes during waits and unexpected archives after rename', async t => {
  for (const change of ['bytes', 'source'] as const) {
    const value = publicationFixture(t); let proof = value.proof;
    await assert.rejects(recoverPublication(value.workspace, value.failure, () => proof, { now: () => 0, wait: async () => {
      if (change === 'bytes') writeFileSync(join(value.stage, 'README.md'), 'changed during retry');
      else proof = { ...proof, sourceSHA256: engineDigest('source changed during retry') };
    } }));
    assert.equal(await value.count(), 1); assert(!existsSync(value.workspace.target));
  }
  const archived = publicationFixture(t, { failUntil: 1, archive: true });
  await assert.rejects(recoverPublication(archived.workspace, archived.failure, () => archived.proof), /archive|entry|equal/);
  assert(existsSync(join(archived.workspace.dist, 'archive'))); assert(!existsSync(archived.directory));
});

test('a recovered publication with a later failed smoke cannot become a prepared engine', async t => {
  const value = publicationFixture(t); assert(await recoverPublication(value.workspace, value.failure, () => value.proof));
  const smoke = { ...value.smoke, passed: false, error: 'controlled downstream smoke failure' };
  writeFileSync(join(value.workspace.target, 'smoke-report.json'), JSON.stringify(smoke) + '\n');
  writeFileSync(join(value.workspace.target, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode.exe', 'runtime-manifest.json', 'source-files.json', 'smoke-report.json']
    .map(file => `${engineDigest(readFileSync(join(value.workspace.target, file)))}  ${file}\n`).join(''));
  assert.throws(() => verifyEngineArtifact(value.workspace.target, value.source), /smoke did not pass/);
  assert(!existsSync(value.directory)); assert(!existsSync(join(value.workspace.target, 'engine-build.json')));
});
