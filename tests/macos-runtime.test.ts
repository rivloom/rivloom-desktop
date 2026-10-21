import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPlatform, desktopPlatforms, assertMacosArm64Executable, mergeDesktopConfig } from '../scripts/desktop-platform.ts';
import { engineBinaryName, engineDigest, engineRecipeDigest, engineSourceFile, engineSourceInventoryDigest, engineTarget, macosOverlayArtifacts, readEngineSource, verifyPreparedEngine } from '../server/engine-artifact.ts';
import { verifyEngineRecipe } from '../scripts/engine-prepare.ts';
import { verifyArtifact as verifyMacosProducerArtifact } from '../scripts/runtime-macos/artifact.mjs';

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
  const corePath = 'packages/core/src/cross-spawn-spawner.ts', modulePath = 'packages/core/src/rivloom-macos-guard.ts';
  const patch = { schemaVersion: 1, target: 'darwin-arm64', baseCommit: source.commit,
    files: [{ path: corePath, beforeSHA256: engineDigest('synthetic core before'), afterSHA256: engineDigest('synthetic core after'), edits: [{ before: 'before', after: 'after' }] }],
    additions: [{ path: modulePath, source: 'spawn-guard.ts', sha256: engineDigest('synthetic guard') }] };
  writeFileSync(join(root, recipe.directory, 'core-spawn.patch.json'), json(patch));
  writeFileSync(join(root, recipe.directory, 'spawn-guard.ts'), 'synthetic guard');
  recipe.files['core-spawn.patch.json'] = engineDigest(json(patch)); recipe.files['spawn-guard.ts'] = engineDigest('synthetic guard');
  write('macos-core-spawn.patch.json', patch);
  writeFileSync(join(directory, 'macos-cross-spawn-spawner.ts'), 'synthetic core after');
  writeFileSync(join(directory, 'macos-spawn-guard.ts'), 'synthetic guard');
  const config = { sourceOverlay: { patch: { file: 'core-spawn.patch.json', sha256: recipe.files['core-spawn.patch.json'] },
    module: { file: 'spawn-guard.ts', sha256: recipe.files['spawn-guard.ts'] } },
    integrationSources: Object.fromEntries(['native/macos-process.c', 'scripts/macos-process-build.ts', 'server/engine-host.mjs', 'server/macos-process.mjs'].map(file => [file, engineDigest(`fixture:${file}`)])) };
  writeFileSync(join(root, recipe.directory, 'runtime.json'), json(config)); recipe.files['runtime.json'] = engineDigest(json(config));
  write('macos-runtime-recipe.json', config);
  const integration = { schemaVersion: 1, passed: true, target: 'darwin-arm64',
    checks: ['git-path-and-discovery', 'shell-and-exit-status', 'stdio-extra-fd-and-environment', 'concurrent-force-kill-isolation', 'scope-finalizer-descendant-cleanup', 'operation-timeout-descendant-cleanup', 'abort-descendant-cleanup'],
    inputs: { coreSHA256: patch.files[0].afterSHA256, adapterSHA256: patch.additions[0].sha256, integrationSources: config.integrationSources,
      bunVersion: source.toolchain.bun, bunSHA256: engineDigest('bun'), helperSHA256: engineDigest('helper'),
      hostSHA256: config.integrationSources['server/engine-host.mjs'], processModuleSHA256: config.integrationSources['server/macos-process.mjs'],
      fixtureSHA256: recipe.files['guard-fixture.mjs'], harnessSHA256: recipe.files['guard-integration.mjs'] },
    nativeHelper: { schemaVersion: 1, platform: 'darwin', arch: 'arm64', binarySHA256: engineDigest('helper'),
      inputs: { sourceSHA256: config.integrationSources['native/macos-process.c'], buildScriptSHA256: config.integrationSources['scripts/macos-process-build.ts'], compiler: 'Synthetic compiler', sdk: '14.0' } },
    shutdown: { phase: 'result', outcome: 'ok', proof: 'observed-exit', failure: 'none', recorded: 16, durationMs: 200 } };
  write('macos-guard-integration-report.json', integration);
  const inventory = { schemaVersion: 1, commit: source.commit, tree: source.tree, dirty: false, status: [],
    files: [...Object.entries(source.inputs), ['rivloom/README.md', engineDigest(readFileSync(join(directory, 'README.md')))], [corePath, patch.files[0].beforeSHA256]]
      .map(([path, sha256]) => ({ path, sha256, tracked: true, type: 'file', mode: '100644', bytes: 12 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  source.sourceInventory = { files: inventory.files.length, sha256: engineSourceInventoryDigest(inventory.files) };
  const record = (file: string) => ({ file, bytes: readFileSync(join(directory, file)).length, sha256: engineDigest(readFileSync(join(directory, file))) });
  write('source-files.json', inventory);
  const compiled = { ...inventory, dirty: true, status: [` M ${corePath}`, `?? ${modulePath}`], files: [
    ...inventory.files.map(item => item.path === corePath ? { ...item, sha256: patch.files[0].afterSHA256, bytes: 'synthetic core after'.length } : item),
    { path: modulePath, mode: '100644', tracked: false, type: 'file', bytes: 'synthetic guard'.length, sha256: patch.additions[0].sha256 },
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const overlay = { schemaVersion: 1, kind: 'rivloom-macos-source-overlay', baseCommit: source.commit, baseTree: source.tree,
    baseInventorySHA256: engineSourceInventoryDigest(inventory.files), compiledInventorySHA256: engineSourceInventoryDigest(compiled.files),
    patch: { file: 'macos-core-spawn.patch.json', sha256: recipe.files['core-spawn.patch.json'] },
    files: [{ path: corePath, beforeSHA256: patch.files[0].beforeSHA256, afterSHA256: patch.files[0].afterSHA256, artifact: 'macos-cross-spawn-spawner.ts' }],
    additions: [{ path: modulePath, sha256: patch.additions[0].sha256, artifact: 'macos-spawn-guard.ts' }] };
  write('compiled-source-files.json', compiled); write('macos-source-overlay.json', overlay);
  const manifest = { schemaVersion: 2, version: source.version, target: source.target, channel: 'rivloom',
    source: { repository: source.repository, commit: source.commit, tree: source.tree, dirty: false,
      inventory: { file: 'source-files.json', sha256: record('source-files.json').sha256, files: inventory.files.length },
      compilation: { kind: 'macos-source-overlay', inventory: { file: 'compiled-source-files.json', sha256: record('compiled-source-files.json').sha256, files: compiled.files.length },
        overlay: { file: 'macos-source-overlay.json', sha256: record('macos-source-overlay.json').sha256 },
        integration: { file: 'macos-guard-integration-report.json', sha256: record('macos-guard-integration-report.json').sha256 },
        recipe: { file: 'macos-runtime-recipe.json', sha256: record('macos-runtime-recipe.json').sha256 } } },
    upstream: source.upstream, recipe: { files: recipe.files, sha256: engineRecipeDigest(source) },
    toolchain: { ...source.toolchain, nodeExecutableSHA256: engineDigest('node'), bunExecutableSHA256: engineDigest('bun') },
    packageVersions: { opencode: source.packageVersion, sdk: source.packageVersion, plugin: source.packageVersion },
    inputs: { bunLockSHA256: source.inputs['bun.lock'], modelsSHA256: source.inputs['rivloom/models.json'], files: source.inputs },
    profile: { embedWebUI: false, baseline: false, signed: true, signingIdentity: 'ad-hoc', desktopIntegrated: false },
    binary: record('opencode'), artifacts: ['LICENSE', 'README.md', 'source-files.json', ...macosOverlayArtifacts].map(record) };
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
    write('compiled-source-files.json', compiled); write('macos-source-overlay.json', overlay);
    write('macos-guard-integration-report.json', integration);
    manifest.source.compilation.inventory.sha256 = record('compiled-source-files.json').sha256;
    manifest.source.compilation.overlay.sha256 = record('macos-source-overlay.json').sha256;
    manifest.source.compilation.integration.sha256 = record('macos-guard-integration-report.json').sha256;
    manifest.source.compilation.recipe.sha256 = record('macos-runtime-recipe.json').sha256;
    manifest.artifacts = ['LICENSE', 'README.md', 'source-files.json', ...macosOverlayArtifacts].map(record);
    write('runtime-manifest.json', manifest);
    smoke.binarySHA256 = manifest.binary.sha256; smoke.manifestSHA256 = record('runtime-manifest.json').sha256;
    smoke.sourceInventorySHA256 = manifest.source.inventory.sha256;
    write('smoke-report.json', smoke);
    receipt.binarySHA256 = manifest.binary.sha256; receipt.manifestSHA256 = smoke.manifestSHA256;
    receipt.smokeSHA256 = record('smoke-report.json').sha256;
    write('engine-build.json', receipt);
    writeFileSync(join(directory, 'SHA256SUMS'), ['LICENSE', 'README.md', 'opencode', 'runtime-manifest.json', 'smoke-report.json', 'source-files.json', ...macosOverlayArtifacts].map(file => `${record(file).sha256}  ${file}\n`).join(''));
  };
  rehash();
  return { root, directory, source, manifest, inventory, compiled, overlay, integration, smoke, receipt, rehash };
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
  verifyMacosProducerArtifact(value.directory, value.manifest);
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

test('Mac consumer rejects unreviewed compiled inputs even when artifact hashes are rewritten', t => {
  const value = fixture(t);
  value.compiled.files.push({ path: 'packages/core/src/unreviewed.ts', mode: '100644', tracked: false, type: 'file', bytes: 1, sha256: engineDigest('unreviewed') });
  value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /unreviewed source change/);
  assert.throws(() => verifyMacosProducerArtifact(value.directory, value.manifest));
});

test('Mac consumer binds redistributed patch and adapter to the independently pinned recipe', t => {
  const value = fixture(t);
  writeFileSync(join(value.directory, 'macos-spawn-guard.ts'), 'replacement guard'); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'));
  writeFileSync(join(value.directory, 'macos-spawn-guard.ts'), 'synthetic guard');
  const patch = JSON.parse(readFileSync(join(value.directory, 'macos-core-spawn.patch.json'), 'utf8'));
  patch.files[0].beforeSHA256 = engineDigest('different base');
  writeFileSync(join(value.directory, 'macos-core-spawn.patch.json'), json(patch)); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /source patch differs/);
});

test('Mac consumer rejects a source receipt that conceals the overlay', t => {
  const value = fixture(t);
  value.overlay.compiledInventorySHA256 = value.overlay.baseInventorySHA256; value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /overlay receipt differs/);
});

test('Mac consumer binds real Bun integration to the compiled inputs and requires every check', t => {
  const value = fixture(t);
  value.integration.inputs.bunSHA256 = engineDigest('different bun'); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /different inputs/);
  value.integration.inputs.bunSHA256 = engineDigest('bun'); value.integration.checks.pop(); value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'));
  assert.throws(() => verifyMacosProducerArtifact(value.directory, value.manifest));
});

test('Mac consumer rejects an unproven command tree shutdown despite rewritten outer hashes', t => {
  const value = fixture(t);
  value.integration.shutdown.proof = 'unproven'; value.rehash();
  assert.throws(() => verifyPreparedEngine(value.root, 'darwin-arm64'), /proven owned-process shutdown/);
  assert.throws(() => verifyMacosProducerArtifact(value.directory, value.manifest), /proven owned-process shutdown/);
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
  assert.deepEqual(config.sourceOverlay, {
    patch: { file: 'core-spawn.patch.json', sha256: source.recipe!.files['core-spawn.patch.json'] },
    module: { file: 'spawn-guard.ts', sha256: source.recipe!.files['spawn-guard.ts'] },
  });
  assert.deepEqual(Object.keys(config.integrationSources).sort(), ['native/macos-process.c', 'scripts/macos-process-build.ts', 'server/engine-host.mjs', 'server/macos-process.mjs']);
  for (const [file, sha256] of Object.entries(config.integrationSources))
    assert.equal(engineDigest(readFileSync(join(repository, file))), sha256, `Mac integration input changed: ${file}`);
});
