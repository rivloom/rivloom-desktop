import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const engineSourceSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('rivloom-source'),
  repository: z.literal('https://github.com/rivloom/rivloom-opencode-runtime.git'),
  commit, tree: commit, version: z.string().regex(/^\d+\.\d+\.\d+-rivloom\.[a-f0-9]{12}$/),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/), target: z.enum(['windows-x64', 'linux-x64', 'darwin-arm64']),
  artifactPath: z.string().regex(/^vendor\/rivloom-opencode\/(?:windows-x64|linux-x64|darwin-arm64)\/[a-f0-9]{12}$/),
  upstream: z.strictObject({ repository: z.literal('anomalyco/opencode'), tag: z.string(), commit, version: z.string() }),
  toolchain: z.strictObject({ node: z.string(), bun: z.string(), bunArchiveSHA256: digest }),
  inputs: z.record(z.string(), digest),
  producerSchemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  sourceInventory: z.strictObject({ files: z.number().int().positive(), sha256: digest }).optional(),
  approvedArtifact: z.strictObject({ binarySHA256: digest, manifestSHA256: digest, smokeSHA256: digest }).optional(),
  recipe: z.strictObject({ directory: z.enum(['scripts/runtime-linux', 'scripts/runtime-macos']), files: z.record(z.string(), digest) }).optional(),
  verification: z.strictObject({ files: z.record(z.string(), digest) }).optional(),
});
export type EngineSource = z.infer<typeof engineSourceSchema>;
export const engineDigest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export type EngineTarget = EngineSource['target'];
export function engineTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): EngineTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  assert(arch === 'x64' && (platform === 'win32' || platform === 'linux'), `Unsupported Rivloom engine platform: ${platform}/${arch}. ARM64 is supported only on macOS.`);
  return platform === 'linux' ? 'linux-x64' : 'windows-x64';
}
export const engineSourceFile = (target: EngineTarget = engineTarget()) => ({ 'windows-x64': 'shared/engine-source.json', 'linux-x64': 'shared/engine-source-linux.json', 'darwin-arm64': 'shared/engine-source-macos.json' })[target];
export const engineBinaryName = (source: EngineSource) => source.target === 'windows-x64' ? 'opencode.exe' : 'opencode';
export const engineProducerSchema = (source: EngineSource) => source.producerSchemaVersion ?? (source.target === 'windows-x64' ? 1 : 2);
export const engineSourceInventoryDigest = (files: { path: string; mode: string; sha256: string }[]) => engineDigest(JSON.stringify(
  [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(item => [item.path, item.mode, item.sha256]),
));
const windowsProducerInputs = ['rivloom/runtime.json', 'rivloom/build.ps1', 'rivloom/build.mjs', 'rivloom/artifact.mjs', 'rivloom/smoke.mjs', 'packages/opencode/script/build.ts'];
export const macosOverlayArtifacts = ['compiled-source-files.json', 'macos-core-spawn.patch.json', 'macos-cross-spawn-spawner.ts', 'macos-guard-integration-report.json', 'macos-runtime-recipe.json', 'macos-source-overlay.json', 'macos-spawn-guard.ts'];
const macosRecipeFiles = ['artifact.d.mts', 'artifact.mjs', 'build.mjs', 'core-spawn.patch.json', 'guard-fixture.mjs', 'guard-integration.mjs', 'runtime.json', 'smoke.mjs', 'source-overlay.d.mts', 'source-overlay.mjs', 'spawn-guard.ts'];
export const engineRecipeDigest = (source: EngineSource) => source.recipe ? engineDigest(JSON.stringify(Object.entries(source.recipe.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : undefined;
export const engineVerificationDigest = (source: EngineSource) => source.verification ? engineDigest(JSON.stringify(Object.entries(source.verification.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : undefined;
export function readEngineSource(root: string, target: EngineTarget = engineTarget()) {
  const source = engineSourceSchema.parse(JSON.parse(readFileSync(engineRegularFile(root, engineSourceFile(target)), 'utf8')));
  assert.equal(source.target, target);
  assert.equal(source.version, `${source.packageVersion}-rivloom.${source.commit.slice(0, 12)}`);
  assert.equal(source.artifactPath, `vendor/rivloom-opencode/${target}/${source.commit.slice(0, 12)}`);
  assert.equal(source.packageVersion, source.upstream.version);
  assert.equal(source.upstream.tag, `v${source.upstream.version}`);
  for (const path of ['bun.lock', 'rivloom/runtime.json', 'rivloom/build.mjs', 'rivloom/build.ps1', 'rivloom/smoke.mjs', 'rivloom/models.json', 'LICENSE'])
    assert(source.inputs[path], `Missing reviewed engine input: ${path}`);
  for (const path of Object.keys(source.inputs)) engineRelativePath(path);
  if (target === 'windows-x64') {
    assert(!source.recipe, 'Windows uses its committed producer');
    if (engineProducerSchema(source) === 1) assert(source.approvedArtifact, 'Legacy Windows requires its approved artifact contract');
    else {
      assert(source.sourceInventory, 'Windows schema 2 requires the complete reviewed source inventory');
      assert(source.verification, 'Windows schema 2 requires independent consumer verification');
      for (const path of windowsProducerInputs) assert(source.inputs[path], `Missing reviewed Windows producer input: ${path}`);
    }
    if (source.verification) assert.deepEqual(Object.keys(source.verification.files).sort(), engineProducerSchema(source) === 2
      ? ['scripts/runtime-windows/smoke.mjs', 'server/engine-artifact.ts', 'server/windows-engine-stop.mjs']
      : ['scripts/runtime-windows/smoke.mjs', 'server/windows-engine-stop.mjs']);
  }
  else {
    assert.equal(engineProducerSchema(source), 2, 'POSIX targets require producer schema 2');
    assert(!source.verification, 'POSIX targets use their complete pinned recipe');
    assert(source.recipe, 'POSIX source requires an independently pinned build recipe');
    assert.equal(source.recipe.directory, target === 'darwin-arm64' ? 'scripts/runtime-macos' : 'scripts/runtime-linux', 'Build recipe belongs to another platform');
    assert.deepEqual(Object.keys(source.recipe.files).sort(), target === 'darwin-arm64' ? macosRecipeFiles : ['artifact.mjs', 'build.mjs', 'runtime.json', 'smoke.mjs']);
    assert(source.inputs['packages/opencode/script/build.ts'], 'POSIX compiler entrypoint must be pinned');
    if (target === 'darwin-arm64') assert(source.sourceInventory, 'macOS requires the complete reviewed source inventory');
  }
  return source;
}
export function engineRelativePath(path: string) {
  assert(path && !isAbsolute(path) && !/[\\:\u0000-\u001f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe engine artifact path');
  return path;
}
export function engineRegularFile(root: string, path: string) {
  engineRelativePath(path);
  let cursor = resolve(root);
  assert(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink(), 'Engine root must be a real directory');
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    assert(!lstatSync(cursor).isSymbolicLink(), 'Engine artifacts must not contain links');
  }
  assert(lstatSync(cursor).isFile(), `Missing engine artifact: ${path}`);
  const suffix = relative(realpathSync(root), realpathSync(cursor));
  assert(suffix && !isAbsolute(suffix) && !suffix.startsWith('..'), 'Engine artifact escapes its root');
  return cursor;
}
function verifyMacosSourceOverlay(directory: string, source: EngineSource, base: any, manifest: any) {
  const bytes = (file: string) => readFileSync(engineRegularFile(directory, file));
  const patch = JSON.parse(bytes('macos-core-spawn.patch.json').toString('utf8'));
  assert.equal(engineDigest(bytes('macos-core-spawn.patch.json')), source.recipe!.files['core-spawn.patch.json'], 'Mac source patch differs from reviewed recipe');
  assert.equal(patch.schemaVersion, 1); assert.equal(patch.target, source.target); assert.equal(patch.baseCommit, source.commit);
  assert.deepEqual(patch.files.map((item: any) => item.path), ['packages/core/src/cross-spawn-spawner.ts']);
  assert.deepEqual(patch.additions.map((item: any) => [item.path, item.source]), [['packages/core/src/rivloom-macos-guard.ts', 'spawn-guard.ts']]);
  const changed = patch.files[0], added = patch.additions[0];
  assert.equal(base.files.find((item: any) => item.path === changed.path)?.sha256, changed.beforeSHA256, 'Mac overlay base differs from pinned source');
  assert.equal(base.files.some((item: any) => item.path === added.path), false, 'Mac overlay unexpectedly replaces an existing module');
  assert.equal(engineDigest(bytes('macos-cross-spawn-spawner.ts')), changed.afterSHA256, 'Mac compiled spawn source differs from reviewed patch');
  assert.equal(engineDigest(bytes('macos-spawn-guard.ts')), added.sha256);
  assert.equal(added.sha256, source.recipe!.files['spawn-guard.ts'], 'Mac compiled guard differs from reviewed recipe');
  const compiledBytes = bytes('compiled-source-files.json'), compiled = JSON.parse(compiledBytes.toString('utf8'));
  const expected = base.files.map((item: any) => item.path === changed.path
    ? { ...item, bytes: bytes('macos-cross-spawn-spawner.ts').length, sha256: changed.afterSHA256 } : item);
  expected.push({ path: added.path, mode: '100644', tracked: false, type: 'file', bytes: bytes('macos-spawn-guard.ts').length, sha256: added.sha256 });
  expected.sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(compiled, { ...base, dirty: true, status: [` M ${changed.path}`, `?? ${added.path}`], files: expected }, 'Mac compiled inventory contains an unreviewed source change');
  const receiptBytes = bytes('macos-source-overlay.json'), receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.deepEqual(receipt, { schemaVersion: 1, kind: 'rivloom-macos-source-overlay', baseCommit: source.commit, baseTree: source.tree,
    baseInventorySHA256: engineSourceInventoryDigest(base.files), compiledInventorySHA256: engineSourceInventoryDigest(compiled.files),
    patch: { file: 'macos-core-spawn.patch.json', sha256: source.recipe!.files['core-spawn.patch.json'] },
    files: [{ path: changed.path, beforeSHA256: changed.beforeSHA256, afterSHA256: changed.afterSHA256, artifact: 'macos-cross-spawn-spawner.ts' }],
    additions: [{ path: added.path, sha256: added.sha256, artifact: 'macos-spawn-guard.ts' }] }, 'Mac source overlay receipt differs');
  const configBytes = bytes('macos-runtime-recipe.json'), config = JSON.parse(configBytes.toString('utf8'));
  assert.equal(engineDigest(configBytes), source.recipe!.files['runtime.json'], 'Mac redistributed recipe differs from reviewed input');
  assert.deepEqual(config.sourceOverlay, { patch: { file: 'core-spawn.patch.json', sha256: source.recipe!.files['core-spawn.patch.json'] }, module: { file: 'spawn-guard.ts', sha256: added.sha256 } });
  assert.deepEqual(Object.keys(config.integrationSources).sort(), ['native/macos-process.c', 'scripts/macos-process-build.ts', 'server/engine-host.mjs', 'server/macos-process.mjs']);
  for (const hash of Object.values(config.integrationSources)) assert(digest.safeParse(hash).success, 'Mac native integration source pin missing');
  const integrationBytes = bytes('macos-guard-integration-report.json'), integration = JSON.parse(integrationBytes.toString('utf8'));
  assert.equal(integration.schemaVersion, 1); assert.equal(integration.target, source.target); assert.equal(integration.passed, true);
  assert(!integration.failure && !integration.cleanupUnproven && !integration.retainedFixture, 'Mac core guard integration did not finish cleanly');
  assert.deepEqual(integration.checks, ['git-path-and-discovery', 'shell-and-exit-status', 'stdio-extra-fd-and-environment', 'concurrent-force-kill-isolation', 'scope-finalizer-descendant-cleanup', 'operation-timeout-descendant-cleanup', 'abort-descendant-cleanup']);
  assert.deepEqual(integration.inputs, { coreSHA256: changed.afterSHA256, adapterSHA256: added.sha256,
    integrationSources: config.integrationSources,
    bunVersion: source.toolchain.bun, bunSHA256: manifest.toolchain.bunExecutableSHA256, helperSHA256: integration.nativeHelper?.binarySHA256,
    hostSHA256: config.integrationSources['server/engine-host.mjs'], processModuleSHA256: config.integrationSources['server/macos-process.mjs'],
    fixtureSHA256: source.recipe!.files['guard-fixture.mjs'], harnessSHA256: source.recipe!.files['guard-integration.mjs'] }, 'Mac native integration used different inputs');
  const helper = integration.nativeHelper;
  assert.deepEqual(Object.keys(helper).sort(), ['arch', 'binarySHA256', 'inputs', 'platform', 'schemaVersion']);
  assert.deepEqual(Object.keys(helper.inputs).sort(), ['buildScriptSHA256', 'compiler', 'sdk', 'sourceSHA256']);
  assert.equal(helper.schemaVersion, 1); assert.equal(helper.platform, 'darwin'); assert.equal(helper.arch, 'arm64');
  assert(digest.safeParse(helper.binarySHA256).success && typeof helper.inputs.compiler === 'string' && helper.inputs.compiler.length > 0 && helper.inputs.compiler.length <= 8192 &&
    typeof helper.inputs.sdk === 'string' && /^\d+(?:\.\d+){0,3}$/.test(helper.inputs.sdk));
  assert.equal(helper.inputs.sourceSHA256, config.integrationSources['native/macos-process.c']);
  assert.equal(helper.inputs.buildScriptSHA256, config.integrationSources['scripts/macos-process-build.ts']);
  const stop = integration.shutdown;
  assert(stop && stop.phase === 'result' && stop.outcome === 'ok' && stop.proof === 'observed-exit' && stop.failure === 'none' &&
    Number.isSafeInteger(stop.recorded) && stop.recorded > 0 && Number.isSafeInteger(stop.durationMs) && stop.durationMs >= 0 && !stop.inventoryFailure && !stop.ownershipFailure,
  'Mac native integration lacks proven owned-process shutdown');
  assert.deepEqual(manifest.source.compilation, { kind: 'macos-source-overlay',
    inventory: { file: 'compiled-source-files.json', sha256: engineDigest(compiledBytes), files: compiled.files.length },
    overlay: { file: 'macos-source-overlay.json', sha256: engineDigest(receiptBytes) },
    integration: { file: 'macos-guard-integration-report.json', sha256: engineDigest(integrationBytes) },
    recipe: { file: 'macos-runtime-recipe.json', sha256: engineDigest(configBytes) } }, 'Mac producer omits exact compiled source evidence');
}
export function verifyEngineProducer(directory: string, source: EngineSource) {
  const bytes = (path: string) => readFileSync(engineRegularFile(directory, path));
  const binaryName = engineBinaryName(source), linux = source.target === 'linux-x64', macos = source.target === 'darwin-arm64', schema = engineProducerSchema(source);
  const binary = bytes(binaryName);
  if (linux) {
    assert(binary.length > 64 && binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && binary[4] === 2 && binary[5] === 1 && binary.readUInt16LE(18) === 62, 'Engine must be Linux x64 ELF64');
    assert([2, 3].includes(binary.readUInt16LE(16)), 'Linux engine must be executable or PIE ELF');
    if (process.platform === 'linux') assert(lstatSync(engineRegularFile(directory, binaryName)).mode & 0o111, 'Linux engine is not executable');
  } else if (macos) {
    assert(binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === 0x0100000c && binary.readUInt32LE(8) === 0 && binary.readUInt32LE(12) === 2, 'Engine must be macOS ARM64 Mach-O executable');
    assert(binary.readUInt32LE(16) > 0 && binary.readUInt32LE(20) >= 8 && binary.readUInt32LE(20) <= binary.length - 32, 'Invalid Mach-O load commands');
    if (process.platform === 'darwin') assert(lstatSync(engineRegularFile(directory, binaryName)).mode & 0o111, 'macOS engine is not executable');
  } else {
    assert(binary.length > 154 && binary.toString('ascii', 0, 2) === 'MZ', 'Engine is not a PE binary');
    const offset = binary.readUInt32LE(60);
    assert(offset + 26 <= binary.length && binary.toString('ascii', offset, offset + 4) === 'PE\0\0' && binary.readUInt16LE(offset + 4) === 0x8664 && binary.readUInt16LE(offset + 24) === 0x20b, 'Engine must be Windows x64 PE32+');
  }
  const manifestBytes = bytes('runtime-manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, schema, 'Producer schema differs from the reviewed source lock');
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.target, source.target);
  assert.equal(manifest.channel, 'rivloom');
  assert.equal(manifest.source.repository.replace(/\.git$/, ''), source.repository.replace(/\.git$/, ''));
  assert.equal(manifest.source.commit, source.commit);
  assert.equal(manifest.source.tree, source.tree);
  assert.equal(manifest.source.dirty, false, 'Desktop only accepts committed runtime source');
  assert.deepEqual(manifest.upstream, source.upstream);
  if (schema === 2) {
    for (const key of ['node', 'bun', 'bunArchiveSHA256'] as const) assert.equal(manifest.toolchain[key], source.toolchain[key]);
    for (const key of ['bunExecutableSHA256', 'nodeExecutableSHA256']) assert(digest.safeParse(manifest.toolchain[key]).success, 'Missing toolchain executable hash');
  } else assert.deepEqual(manifest.toolchain, source.toolchain);
  for (const name of ['opencode', 'sdk', 'plugin']) assert.equal(manifest.packageVersions[name], source.packageVersion);
  assert.equal(manifest.inputs.bunLockSHA256, source.inputs['bun.lock']);
  assert.equal(manifest.inputs.modelsSHA256, source.inputs['rivloom/models.json']);
  assert.equal(manifest.profile.embedWebUI, false);
  assert.equal(manifest.binary.file, binaryName);
  assert.equal(manifest.binary.bytes, binary.length);
  const binarySHA256 = engineDigest(binary), manifestSHA256 = engineDigest(manifestBytes);
  assert.equal(manifest.binary.sha256, binarySHA256, 'Engine binary SHA256 mismatch');
  assert.equal(engineDigest(bytes('LICENSE')), source.inputs.LICENSE, 'Engine license differs from pinned source');
  if (linux || macos) {
    assert.deepEqual(manifest.inputs.files, source.inputs, 'POSIX compiled source inputs differ');
    assert.deepEqual(manifest.recipe, { files: source.recipe!.files, sha256: engineRecipeDigest(source) }, 'POSIX recipe differs from reviewed inputs');
    if (linux) { assert.equal(manifest.profile.baseline, true); assert.equal(manifest.profile.libc, 'glibc'); }
    else {
      assert.equal(manifest.profile.baseline, false); assert.equal(manifest.profile.libc, undefined);
      assert.equal(manifest.profile.signed, true); assert.equal(manifest.profile.signingIdentity, 'ad-hoc');
      assert.equal(manifest.profile.desktopIntegrated, false);
    }
  } else if (schema === 2) {
    assert.deepEqual(manifest.inputs.files, Object.fromEntries(windowsProducerInputs.map(path => [path, source.inputs[path]])), 'Windows compiled producer inputs differ');
    assert.equal(manifest.profile.signed, false); assert.equal(manifest.profile.desktopIntegrated, false);
  }
  if (schema === 2) {
    assert.deepEqual(manifest.artifacts.map((item: { file: string }) => item.file).sort(), ['LICENSE', 'README.md', ...(macos ? macosOverlayArtifacts : []), 'source-files.json'].sort());
    for (const item of manifest.artifacts) {
      assert.equal(bytes(item.file).length, item.bytes);
      assert.equal(engineDigest(bytes(item.file)), item.sha256);
    }
    const inventoryBytes = bytes('source-files.json'), inventory = JSON.parse(inventoryBytes.toString('utf8'));
    assert.equal(manifest.source.inventory.file, 'source-files.json');
    assert.equal(manifest.source.inventory.sha256, engineDigest(inventoryBytes));
    for (const key of ['commit', 'tree', 'dirty']) assert.equal(inventory[key], manifest.source[key]);
    assert.equal(inventory.schemaVersion, 1); assert.equal(inventory.files.length, manifest.source.inventory.files);
    assert(inventory.files.length > 0 && inventory.files.every((item: { path: string; sha256: string; tracked: boolean; type: string }) => engineRelativePath(item.path) && digest.safeParse(item.sha256).success && item.tracked === true && ['file', 'symlink'].includes(item.type)), 'Invalid clean source inventory');
    assert.equal(new Set(inventory.files.map((item: { path: string }) => item.path)).size, inventory.files.length, 'Duplicate source inputs');
    if (source.sourceInventory) {
      assert.deepEqual(inventory.status, [], 'Clean source inventory contains worktree changes');
      assert(inventory.files.every((item: { mode: string; type: string; bytes: number }) =>
        ['100644', '100755', '120000'].includes(item.mode) && Number.isSafeInteger(item.bytes) && item.bytes >= 0 &&
        (item.mode === '120000' || item.type === 'file')), 'Invalid portable source inventory metadata');
      assert.equal(inventory.files.length, source.sourceInventory.files, 'Reviewed source inventory count differs');
      assert.equal(engineSourceInventoryDigest(inventory.files), source.sourceInventory.sha256, 'Complete source inventory differs from the reviewed source lock');
    }
    const sourceFiles = new Map<string, string>(inventory.files.map((item: { path: string; sha256: string }) => [item.path, item.sha256]));
    for (const [file, sha256] of Object.entries(source.inputs)) assert.equal(sourceFiles.get(file), sha256, `Source inventory disagrees with pin: ${file}`);
    assert.equal(sourceFiles.get('rivloom/README.md'), engineDigest(bytes('README.md')), 'Engine README differs from its source inventory');
    if (macos) verifyMacosSourceOverlay(directory, source, inventory, manifest);
  }
  return { manifest, binarySHA256, manifestSHA256, bytes: binary.length };
}
export function verifyEngineArtifact(directory: string, source: EngineSource, approved = false) {
  const bytes = (path: string) => readFileSync(engineRegularFile(directory, path));
  const result = verifyEngineProducer(directory, source);
  const { manifest, binarySHA256, manifestSHA256 } = result;
  const posix = source.target !== 'windows-x64', schema = engineProducerSchema(source);
  const smokeBytes = bytes('smoke-report.json'), smoke = JSON.parse(smokeBytes.toString('utf8')), smokeSHA256 = engineDigest(smokeBytes);
  const checksummed = posix ? ['LICENSE', 'README.md', 'opencode', 'runtime-manifest.json', 'smoke-report.json', 'source-files.json', ...(source.target === 'darwin-arm64' ? macosOverlayArtifacts : [])]
    : schema === 2 ? ['LICENSE', 'README.md', 'opencode.exe', 'runtime-manifest.json', 'source-files.json', 'smoke-report.json'] : ['opencode.exe'];
  assert.equal(bytes('SHA256SUMS').toString('utf8'), checksummed.map(file => `${engineDigest(bytes(file))}  ${file}\n`).join(''));
  assert.equal(smoke.schemaVersion, schema);
  assert.equal(smoke.version, source.version);
  assert.equal(smoke.binarySHA256, binarySHA256);
  assert.equal(smoke.passed, true, 'Engine smoke did not pass');
  assert(!smoke.error && !smoke.cleanupError, 'Engine smoke reported a failure');
  assert(Array.isArray(smoke.checks) && smoke.checks.length === (posix ? 11 : 10) && smoke.checks.every((check: { passed: boolean }) => check.passed === true), 'Incomplete engine smoke');
  if (source.verification) {
    assert.equal(smoke.manifestSHA256, manifestSHA256, 'Windows smoke belongs to a different producer manifest');
    assert.equal(smoke.verificationSHA256, engineVerificationDigest(source), 'Windows verification recipe changed');
    assert.equal(smoke.harnessSHA256, source.verification.files['scripts/runtime-windows/smoke.mjs']);
    assert.deepEqual(smoke.verificationFiles, source.verification.files, 'Windows verification inputs differ');
    assert(Array.isArray(smoke.stops) && smoke.stops.length === 2 && smoke.stops.every((stop: { stopped: boolean; recorded: number; rootExited: boolean; proof: string; code: number }) =>
      stop.stopped === true && Number.isSafeInteger(stop.recorded) && stop.recorded > 0 && stop.rootExited === true &&
      ((stop.proof === 'taskkill' && stop.code === 0) || (stop.proof === 'observed-exit' && Number.isSafeInteger(stop.code) && stop.code > 0))),
    'Windows smoke lacks owned process exit proof');
  }
  if (schema === 2) {
    assert.equal(smoke.manifestSHA256, manifestSHA256, 'Smoke belongs to a different producer manifest');
    assert.equal(smoke.sourceInventorySHA256, manifest.source.inventory.sha256, 'Smoke source inventory differs');
    assert.equal(smoke.licenseSHA256, source.inputs.LICENSE, 'Smoke license differs');
  }
  if (posix) {
    assert.equal(smoke.recipeSHA256, engineRecipeDigest(source));
    assert.equal(smoke.harnessSHA256, source.recipe!.files['smoke.mjs']);
  }
  if (approved) {
    assert(source.approvedArtifact, 'This target has no approved artifact import; build from the pinned source');
    assert.deepEqual({ binarySHA256, manifestSHA256, smokeSHA256 }, source.approvedArtifact, 'Imported engine differs from the reviewed artifact');
  }
  return { ...result, smoke, smokeSHA256 };
}
export function verifyPreparedEngine(root: string, target: EngineTarget = engineTarget()) {
  const source = readEngineSource(root, target), directory = join(root, source.artifactPath);
  // Validate every ancestor too: checking only the leaf misses a vendor junction.
  engineRegularFile(root, `${source.artifactPath}/${engineBinaryName(source)}`);
  const result = verifyEngineArtifact(directory, source);
  const receiptBytes = readFileSync(engineRegularFile(directory, 'engine-build.json'));
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'rivloom-engine-build');
  assert.equal(receipt.sourceLockSHA256, engineDigest(readFileSync(engineRegularFile(root, engineSourceFile(target)))));
  assert.equal(receipt.commit, source.commit);
  assert.equal(receipt.tree, source.tree);
  assert.equal(receipt.binarySHA256, result.binarySHA256);
  assert.equal(receipt.manifestSHA256, result.manifestSHA256);
  assert.equal(receipt.smokeSHA256, result.smokeSHA256);
  if (source.recipe) assert.equal(receipt.recipeSHA256, engineRecipeDigest(source), 'POSIX receipt recipe changed');
  if (source.verification) assert.equal(receipt.verificationSHA256, engineVerificationDigest(source), 'Windows receipt verification changed');
  if (receipt.mode === 'pinned-artifact') verifyEngineArtifact(directory, source, true);
  else {
    assert.equal(receipt.mode, 'source-build');
    const proofBytes = readFileSync(engineRegularFile(directory, 'source-proof.json'));
    assert.equal(engineDigest(proofBytes), receipt.sourceProofSHA256);
    const proof = JSON.parse(proofBytes.toString('utf8'));
    assert.equal(proof.commit, source.commit); assert.equal(proof.tree, source.tree);
    assert.equal(proof.clean, true); assert.deepEqual(proof.inputs, source.inputs);
    assert(digest.safeParse(proof.sourceSHA256).success && Number.isSafeInteger(proof.files) && proof.files > 0, 'Missing source snapshot');
    if (source.recipe) assert.equal(proof.files, result.manifest.source.inventory.files, 'Consumer and producer source counts differ');
    if (source.sourceInventory) {
      assert.equal(proof.files, source.sourceInventory.files, 'Consumer source count differs from the reviewed source lock');
      assert.equal(proof.sourceSHA256, source.sourceInventory.sha256, 'Consumer source snapshot differs from the reviewed source lock');
    }
  }
  return { source, directory, ...result, receiptSHA256: engineDigest(receiptBytes), ...(source.recipe ? { recipeSHA256: engineRecipeDigest(source) } : {}) };
}
export function findPreparedEngine(start: string, target: EngineTarget = engineTarget()) {
  const source = readEngineSource(start, target);
  let root = resolve(start);
  while (true) {
    if (existsSync(join(root, source.artifactPath))) {
      const result = verifyPreparedEngine(root, target);
      assert.deepEqual(result.source, source, 'Parent runtime source differs from this application');
      return result;
    }
    const parent = dirname(root);
    if (parent === root) throw new Error('Rivloom runtime missing. Run npm run engine:prepare before starting Rivloom.');
    root = parent;
  }
}
