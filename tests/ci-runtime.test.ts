import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  parseRuntimeArguments,
  runtimeManifestSchema,
  verifyRuntime,
  type CargoPackage,
  type RuntimeProfile,
} from '../scripts/ci-verify-runtime.ts';
import { collectDependencyNotices } from '../scripts/notices.ts';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function executable(label: string) {
  // Deliberately tiny PE structure fixtures, never executable release binaries.
  const bytes = Buffer.alloc(256);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(0x20b, 152);
  bytes.write(`TEST FIXTURE ONLY ${label}`, 180);
  return bytes;
}
async function fixture(t: TestContext, profile: RuntimeProfile = 'conversation-preview', optionalEngines = false) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'rivloom-ci-runtime-test-'));
  t.after(async () => {
    const rel = relative(parent, await realpath(root));
    assert(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
    await rm(root, { recursive: true, force: true });
  });
  const runtimeRoot = join(root, 'runtime');
  async function put(base: string, path: string, bytes: string | Buffer) {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const source = (path: string, bytes: string | Buffer) => put(root, path, bytes);
  const bundled = (path: string, bytes: string | Buffer) => put(runtimeRoot, path, bytes);
  const both = async (path: string, bytes: string | Buffer) => {
    await source(path, bytes);
    await bundled(path, bytes);
  };
  const installedDependencies = {
    '@opencode-ai/sdk': '1.18.31',
    '@opencode-ai/plugin': '1.18.31',
    'fixture-module': '1.0.0',
  };
  const dependencies: Record<string, string> = { ...installedDependencies };
  const optionalDependencies = optionalEngines ? {
    'opencode-linux-x64-baseline': '1.18.25', 'opencode-linux-arm64': '1.18.25',
  } : undefined;
  const packageRows = Object.entries(installedDependencies).map(([name, version]) => ({
    path: `node_modules/${name}`,
    version,
    integrity: `sha512-TEST-FIXTURE-${name}`,
  }));
  const app = { name: 'rivloom-opencode', version: '0.1.3', dependencies, optionalDependencies };
  const lock = {
    version: app.version,
    packages: {
      '': { version: app.version, dependencies, optionalDependencies },
      ...Object.fromEntries(
        packageRows.map((row) => [row.path, { version: row.version, integrity: row.integrity }]),
      ),
      ...(optionalEngines ? Object.fromEntries(['x64-baseline', 'arm64'].map(arch => [`node_modules/opencode-linux-${arch}`,
        { version: '1.18.25', optional: true, os: ['linux'], cpu: [arch === 'arm64' ? 'arm64' : 'x64'], integrity: `sha512-TEST-FIXTURE-linux-${arch}` }])) : {}),
    },
  };
  await source('package.json', encode(app));
  await source('package-lock.json', encode(lock));
  await source(
    'src-tauri/tauri.conf.json',
    encode({ identifier: 'com.rivloom.desktop', version: app.version }),
  );
  await source(
    'src-tauri/tauri.preview.conf.json',
    encode({ identifier: 'com.rivloom.conversationpreview' }),
  );
  await source('src-tauri/Cargo.toml', '[package]\nname = "rivloom-desktop"\nversion = "0.1.3"\n');
  await bundled(
    'package.json',
    encode({
      name: 'rivloom-desktop-runtime',
      version: app.version,
      private: true,
      type: 'module',
      dependencies,
      optionalDependencies,
    }),
  );
  for (const [name, version] of Object.entries(installedDependencies))
    await bundled(`node_modules/${name}/package.json`, encode({ name, version }));
  const original = 'LICENSE ORIGINAL: CI TEST DATA ONLY, not a third-party release license.\n';
  await bundled('node_modules/fixture-module/LICENSE', original);
  await both('docs/licenses/fixture-module.txt', original);
  await both('docs/licenses/OpenCode-MIT.txt', 'MIT ORIGINAL: CI TEST DATA ONLY\n');
  await source('DESKTOP-README.md', 'CI fixture desktop README\n');
  await bundled('README.md', 'CI fixture desktop README\n');
  await both('SECURITY.md', 'CI fixture security boundaries\n');
  await both('THIRD_PARTY_NOTICES.md', 'CI fixture notices\n');
  await both('LICENSE', 'CI fixture Apache-2.0 license\n');
  await both('NOTICE', 'CI fixture Rivloom contributors\n');
  await source('.data/desktop-downloads/Node-LICENSE.txt', 'CI fixture Node original\n');
  await bundled('Node-LICENSE.txt', 'CI fixture Node original\n');
  const npmInventory = packageRows.map((row) => ({
    name: row.path.slice('node_modules/'.length),
    version: row.version,
    integrity: row.integrity,
    license: 'MIT',
    developmentOnly: false,
    licenseFile: row.path.endsWith('fixture-module')
      ? 'licenses/fixture-module.txt'
      : 'licenses/OpenCode-MIT.txt',
  }));
  // Existing inventories repeat identical rows for the same version at nested package paths.
  await both('docs/dependency-licenses.json', encode([...npmInventory, npmInventory[2]]));
  const archive = Buffer.from('CRATE ARCHIVE FIXTURE ONLY');
  const rustPackages = [
    {
      name: 'fixture-rust',
      version: '1.0.0',
      license: 'MPL-2.0',
      licenseFiles: ['LICENSE'],
      upstreamNotices: [],
      bundledSource: 'fixture-rust-1.0.0.crate',
    },
    {
      name: 'fixture-transitive',
      version: '2.0.0',
      license: 'MIT',
      licenseFiles: ['LICENSE'],
      upstreamNotices: [],
      bundledSource: null,
    },
  ];
  const cargoPackages: CargoPackage[] = [];
  for (const row of rustPackages) {
    const text = `RUST LICENSE ORIGINAL FOR TEST ONLY: ${row.name}\n`;
    await both(`docs/licenses/rust/${row.name}-${row.version}/LICENSE`, text);
    await source(`cargo-source/${row.name}/Cargo.toml`, '[package]\n');
    await source(`cargo-source/${row.name}/LICENSE`, text);
    cargoPackages.push({
      name: row.name,
      version: row.version,
      license: row.license,
      manifestPath: join(root, `cargo-source/${row.name}/Cargo.toml`),
    });
  }
  await both('docs/licenses/rust/fixture-rust-1.0.0/fixture-rust-1.0.0.crate', archive);
  const rustInventory = {
    date: '2026-09-05T00:00:00.000Z',
    scope: 'TEST FIXTURES ONLY',
    packages: rustPackages,
  };
  await both('docs/desktop-dependency-licenses.json', encode(rustInventory));
  const cargoLock =
    `version = 4\n\n[[package]]\nname = "rivloom-desktop"\nversion = "0.1.3"\n\n` +
    rustPackages
      .map(
        (row) =>
          `[[package]]\nname = "${row.name}"\nversion = "${row.version}"\nchecksum = "${sha(archive)}"\n`,
      )
      .join('\n');
  await source('src-tauri/Cargo.lock', cargoLock);
  const node = executable('node'),
    engine = executable('opencode');
  await bundled('node.exe', node);
  const engineLicense = 'MIT ORIGINAL: CI TEST DATA ONLY\n';
  const engineSource = {
    schemaVersion: 1,
    kind: 'rivloom-source',
    repository: 'https://github.com/rivloom/rivloom-opencode-runtime.git',
    commit: 'c'.repeat(40), tree: 'e'.repeat(40),
    version: `1.18.31-rivloom.${'c'.repeat(12)}`, packageVersion: '1.18.31',
    target: 'windows-x64', artifactPath: `vendor/rivloom-opencode/windows-x64/${'c'.repeat(12)}`,
    upstream: { repository: 'anomalyco/opencode', tag: 'v1.18.31', commit: 'f'.repeat(40), version: '1.18.31' },
    toolchain: { node: '24.19.0', bun: '1.3.14', bunArchiveSHA256: 'b'.repeat(64) },
    inputs: Object.fromEntries(['bun.lock', 'rivloom/runtime.json', 'rivloom/build.mjs', 'rivloom/build.ps1',
      'rivloom/smoke.mjs', 'rivloom/models.json', 'LICENSE'].map(path => [path, sha(path === 'LICENSE' ? engineLicense : path)])),
    approvedArtifact: { binarySHA256: sha(engine), manifestSHA256: '', smokeSHA256: '' },
  };
  const engineManifest = {
    schemaVersion: 1, version: engineSource.version, target: 'windows-x64', channel: 'rivloom',
    source: { repository: engineSource.repository, commit: engineSource.commit, tree: engineSource.tree, dirty: false },
    upstream: engineSource.upstream, toolchain: engineSource.toolchain,
    packageVersions: { opencode: '1.18.31', sdk: '1.18.31', plugin: '1.18.31' },
    inputs: { bunLockSHA256: engineSource.inputs['bun.lock'], modelsSHA256: engineSource.inputs['rivloom/models.json'] },
    profile: { embedWebUI: false }, binary: { file: 'opencode.exe', bytes: engine.length, sha256: sha(engine) },
  };
  const engineSmoke = {
    schemaVersion: 1, version: engineSource.version, binarySHA256: sha(engine), passed: true,
    checks: Array.from({ length: 10 }, (_, index) => ({ name: `synthetic-check-${index}`, passed: true })),
  };
  engineSource.approvedArtifact.manifestSHA256 = sha(encode(engineManifest));
  engineSource.approvedArtifact.smokeSHA256 = sha(encode(engineSmoke));
  const engineReceipt = {
    schemaVersion: 1, kind: 'rivloom-engine-build', mode: 'pinned-artifact',
    sourceLockSHA256: sha(encode(engineSource)), commit: engineSource.commit, tree: engineSource.tree,
    binarySHA256: sha(engine), manifestSHA256: sha(encode(engineManifest)), smokeSHA256: sha(encode(engineSmoke)),
  };
  await both('shared/engine-source.json', encode(engineSource));
  const artifact = (path: string, bytes: string | Buffer) => bundled(`${engineSource.artifactPath}/${path}`, bytes);
  for (const [path, bytes] of Object.entries({
    'opencode.exe': engine, 'runtime-manifest.json': encode(engineManifest), 'smoke-report.json': encode(engineSmoke),
    'engine-build.json': encode(engineReceipt), 'SHA256SUMS': `${sha(engine)}  opencode.exe\n`, 'LICENSE': engineLicense,
  })) await artifact(path, bytes);
  await source(`${engineSource.artifactPath}/LICENSE`, engineLicense);
  await source(
    'scripts/desktop-prepare.ts',
    `const nodeVersion = '24.19.0';\nconst nodeHash = '${sha(node)}';\n`,
  );
  const noticePaths = [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'Node-LICENSE.txt',
    'docs/dependency-licenses.json',
    'docs/desktop-dependency-licenses.json',
    'docs/licenses/OpenCode-MIT.txt',
    'docs/licenses/fixture-module.txt',
    'docs/licenses/rust/fixture-rust-1.0.0/LICENSE',
    'docs/licenses/rust/fixture-rust-1.0.0/fixture-rust-1.0.0.crate',
    'docs/licenses/rust/fixture-transitive-2.0.0/LICENSE',
    `${engineSource.artifactPath}/LICENSE`,
  ];
  const records = async (paths: string[]) =>
    Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: sha(await readFile(join(runtimeRoot, path))),
      })),
    );
  const manifest = runtimeManifestSchema.parse({
    schemaVersion: 1,
    builtAt: '2026-09-05T00:00:00.000Z',
    product: {
      kind: profile,
      identifier: profile === 'desktop' ? 'com.rivloom.desktop' : 'com.rivloom.conversationpreview',
      version: app.version,
    },
    target: { platform: 'win32', arch: 'x64' },
    inputs: { packageLockSha256: sha(encode(lock)), cargoLockSha256: sha(cargoLock) },
    node: {
      version: '24.19.0',
      sha256: sha(node),
      source: 'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt',
    },
    opencode: { version: engineSource.version, sha256: sha(engine), source: `${engineSource.repository}#${engineSource.commit}` },
    documents: await records(['README.md', 'SECURITY.md']),
    notices: await records(noticePaths),
    packages: packageRows,
  });
  const save = (value: unknown = manifest) => bundled('runtime-manifest.json', encode(value));
  await save();
  const calls: string[] = [];
  const tools = {
    binaryVersion: async (file: string) => {
      calls.push(file);
      return basename(file) === 'node.exe' ? 'v24.19.0' : engineSource.version;
    },
    cargoPackages: async () => cargoPackages,
  };
  const verify = () => verifyRuntime({ root, runtimeRoot, profile }, tools);
  const refreshNotice = async (path: string) => {
    manifest.notices.find((row) => row.path === path)!.sha256 = sha(
      await readFile(join(runtimeRoot, path)),
    );
    await save();
  };
  return {
    root,
    runtimeRoot,
    profile,
    manifest,
    node,
    engine,
    engineSource,
    engineManifest,
    engineSmoke,
    engineReceipt,
    artifact,
    npmInventory,
    rustInventory,
    source,
    bundled,
    both,
    save,
    calls,
    tools,
    verify,
    refreshNotice,
  };
}

test('runtime gate validates bytes, documents, npm originals and independently resolved Rust graph', async (t) => {
  const f = await fixture(t);
  const result = await f.verify();
  assert.equal(result.status, 'passed');
  assert.equal(result.product.kind, 'conversation-preview');
  assert.equal(result.packages, 3);
  assert.equal(result.licenses.rust, 2);
  assert.equal(f.calls.length, 2);
});

test('runtime gate accepts the explicit desktop profile and rejects preview identity promotion', async (t) => {
  const f = await fixture(t, 'desktop');
  assert.equal((await f.verify()).product.identifier, 'com.rivloom.desktop');
  f.manifest.product.identifier = 'com.rivloom.conversationpreview';
  await f.save();
  await assert.rejects(f.verify(), /product identity\/version mismatch/);
});

test('Windows gate excludes official Linux packages and verifies the source-built Windows payload', async (t) => {
  const f = await fixture(t, 'desktop', true);
  const result = await f.verify();
  assert.equal(result.status, 'passed'); assert.equal(result.packages, 3);
  assert.equal(f.calls.length, 2);
  assert(!f.manifest.packages.some(row => row.path === 'node_modules/opencode-windows-x64'));
  assert.equal(result.engineSource.commit, f.engineSource.commit);
  assert.equal(result.engineSource.receiptSha256, sha(encode(f.engineReceipt)));
  assert(!f.manifest.packages.some(row => row.path.startsWith('node_modules/opencode-linux-')));
  f.calls.length = 0;
  const altered = Buffer.from(f.engine); altered[220] ^= 1;
  await f.artifact('opencode.exe', altered);
  await assert.rejects(f.verify(), /Engine binary SHA256 mismatch/);
  assert.equal(f.calls.length, 0, 'No unverified Windows binary can execute');
});

test('the prepared source engine is mandatory independently of optional Linux declarations', async (t) => {
  const f = await fixture(t, 'desktop', true);
  await rm(join(f.runtimeRoot, f.engineSource.artifactPath, 'opencode.exe'));
  await assert.rejects(f.verify(), /ENOENT/);
  assert.equal(f.calls.length, 0);
});

test('runtime gate rejects missing or drifted optional dependency declarations before executable probes', async (t) => {
  const f = await fixture(t, 'desktop', true);
  const runtime = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8'));
  const { optionalDependencies: _optional, ...missing } = runtime;
  await f.bundled('package.json', encode(missing));
  await assert.rejects(f.verify(), /Runtime optional dependencies differ/);
  await f.bundled('package.json', encode(runtime));
  const lock = JSON.parse(await readFile(join(f.root, 'package-lock.json'), 'utf8'));
  lock.packages[''].optionalDependencies['opencode-linux-x64-baseline'] = '1.18.24';
  await f.source('package-lock.json', encode(lock));
  f.manifest.inputs.packageLockSha256 = sha(encode(lock)); await f.save();
  await assert.rejects(f.verify(), /Lock root optional dependencies differ/);
  assert.equal(f.calls.length, 0);
});

test('both SDK and plugin must match the reviewed engine package version', async (t) => {
  for (const name of ['@opencode-ai/sdk', '@opencode-ai/plugin']) {
    const f = await fixture(t, 'desktop', true);
    const app = JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8'));
    const runtime = JSON.parse(await readFile(join(f.runtimeRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(f.root, 'package-lock.json'), 'utf8'));
    for (const value of [app, runtime, lock.packages['']]) value.dependencies[name] = '1.18.25';
    await f.source('package.json', encode(app)); await f.bundled('package.json', encode(runtime));
    await f.source('package-lock.json', encode(lock)); f.manifest.inputs.packageLockSha256 = sha(encode(lock)); await f.save();
    await assert.rejects(f.verify(), /OpenCode (SDK|plugin) version differs/);
    assert.equal(f.calls.length, 0);
  }
});

test('source lock, producer identity and complete smoke evidence are required before executable probes', async (t) => {
  for (const variant of ['lock', 'commit', 'dirty', 'target', 'checks', 'cleanup', 'receipt']) {
    const f = await fixture(t);
    if (variant === 'lock') await f.bundled('shared/engine-source.json', encode(f.engineSource) + '\n');
    if (variant === 'commit') f.engineManifest.source.commit = 'a'.repeat(40);
    if (variant === 'dirty') f.engineManifest.source.dirty = true;
    if (variant === 'target') f.engineManifest.target = 'linux-x64';
    if (variant === 'checks') f.engineSmoke.checks.pop();
    if (variant === 'cleanup') Object.assign(f.engineSmoke, { cleanupError: 'fixture cleanup failure' });
    if (variant === 'receipt') f.engineReceipt.sourceLockSHA256 = 'a'.repeat(64);
    await f.artifact('runtime-manifest.json', encode(f.engineManifest));
    await f.artifact('smoke-report.json', encode(f.engineSmoke));
    await f.artifact('engine-build.json', encode(f.engineReceipt));
    await assert.rejects(f.verify(), variant);
    assert.equal(f.calls.length, 0, variant);
  }
});

test('an imported artifact cannot launder changed bytes through consistent producer and receipt hashes', async (t) => {
  const f = await fixture(t);
  const changed = Buffer.from(f.engine); changed[220] ^= 1;
  const changedSHA = sha(changed);
  f.engineManifest.binary.sha256 = changedSHA;
  f.engineSmoke.binarySHA256 = changedSHA;
  Object.assign(f.engineReceipt, {
    binarySHA256: changedSHA,
    manifestSHA256: sha(encode(f.engineManifest)),
    smokeSHA256: sha(encode(f.engineSmoke)),
  });
  await f.artifact('opencode.exe', changed);
  await f.artifact('SHA256SUMS', `${changedSHA}  opencode.exe\n`);
  await f.artifact('runtime-manifest.json', encode(f.engineManifest));
  await f.artifact('smoke-report.json', encode(f.engineSmoke));
  await f.artifact('engine-build.json', encode(f.engineReceipt));
  f.manifest.opencode.sha256 = changedSHA; await f.save();
  await assert.rejects(f.verify(), /Imported engine differs from the reviewed artifact/);
  assert.equal(f.calls.length, 0);
});

test('source builds require a clean source proof bound to the reviewed inputs and receipt digest', async (t) => {
  const f = await fixture(t);
  const proof = {
    commit: f.engineSource.commit, tree: f.engineSource.tree, clean: true,
    inputs: f.engineSource.inputs, sourceSHA256: 'a'.repeat(64), files: 7,
  };
  const receipt = { ...f.engineReceipt, mode: 'source-build', sourceProofSHA256: sha(encode(proof)) };
  await f.artifact('source-proof.json', encode(proof));
  await f.artifact('engine-build.json', encode(receipt));
  const result = await f.verify();
  assert.equal(result.engineSource.receiptSha256, sha(encode(receipt)));
  f.calls.length = 0;
  proof.clean = false;
  receipt.sourceProofSHA256 = sha(encode(proof));
  await f.artifact('source-proof.json', encode(proof));
  await f.artifact('engine-build.json', encode(receipt));
  await assert.rejects(f.verify());
  assert.equal(f.calls.length, 0);
});

test('runtime gate rejects old manifest schema without probing any executable', async (t) => {
  const f = await fixture(t);
  const { schemaVersion: _schema, product: _product, ...old } = f.manifest;
  await f.save(old);
  await assert.rejects(f.verify(), /schemaVersion/);
  assert.equal(f.calls.length, 0);
});

test('runtime gate detects document drift even when the manifest hash is regenerated', async (t) => {
  const f = await fixture(t);
  await f.bundled('README.md', 'Changed bundled README\n');
  await assert.rejects(f.verify(), /Bundled document hash drift/);
  f.manifest.documents.find((row) => row.path === 'README.md')!.sha256 = sha(
    'Changed bundled README\n',
  );
  await f.save();
  await assert.rejects(f.verify(), /Bundled document differs from source/);
});

test('runtime gate rejects missing or changed application notices before executing binaries', async (t) => {
  for (const path of ['LICENSE', 'NOTICE']) {
    const f = await fixture(t);
    await rm(join(f.runtimeRoot, path));
    await assert.rejects(f.verify(), /ENOENT/);
    await f.bundled(path, 'Changed application license\n');
    await assert.rejects(f.verify(), /Bundled notice hash drift/);
    await f.refreshNotice(path);
    await assert.rejects(f.verify(), /Bundled notice differs from source/);
    assert.equal(f.calls.length, 0);
  }
});

test('runtime gate rejects a missing Rust inventory and missing license original', async (t) => {
  const f = await fixture(t);
  await rm(join(f.runtimeRoot, 'docs/desktop-dependency-licenses.json'));
  await assert.rejects(f.verify(), /ENOENT/);
  await f.bundled('docs/desktop-dependency-licenses.json', encode(f.rustInventory));
  await rm(join(f.runtimeRoot, 'docs/licenses/fixture-module.txt'));
  await assert.rejects(f.verify(), /notice files membership differs/);
});

test('runtime gate rejects null runtime license records after a fresh manifest generation', async (t) => {
  const f = await fixture(t);
  await f.both(
    'docs/dependency-licenses.json',
    encode(f.npmInventory.map((row) => ({ ...row, licenseFile: null }))),
  );
  await f.refreshNotice('docs/dependency-licenses.json');
  await assert.rejects(f.verify(), /lack explicit license originals.*@opencode-ai\/sdk/);
});

test('runtime gate catches overwritten npm license text against actual package original', async (t) => {
  const f = await fixture(t);
  await f.both('docs/licenses/fixture-module.txt', 'Different version license original\n');
  await f.refreshNotice('docs/licenses/fixture-module.txt');
  await assert.rejects(f.verify(), /npm license differs from actual installed original/);
});

test('runtime gate rejects omitted Rust transitive dependency and wrong source archive', async (t) => {
  const f = await fixture(t);
  await f.both(
    'docs/desktop-dependency-licenses.json',
    encode({ ...f.rustInventory, packages: f.rustInventory.packages.slice(0, 1) }),
  );
  await f.refreshNotice('docs/desktop-dependency-licenses.json');
  await assert.rejects(f.verify(), /Rust Windows dependency license inventory membership differs/);
  await f.both('docs/desktop-dependency-licenses.json', encode(f.rustInventory));
  await f.refreshNotice('docs/desktop-dependency-licenses.json');
  const archive = 'docs/licenses/rust/fixture-rust-1.0.0/fixture-rust-1.0.0.crate';
  await f.both(archive, 'Wrong published crate archive\n');
  await f.refreshNotice(archive);
  await assert.rejects(f.verify(), /source archive differs from Cargo.lock checksum/);
});

test('runtime gate rejects actual npm version drift and additional installed packages', async (t) => {
  const f = await fixture(t);
  await f.bundled(
    'node_modules/fixture-module/package.json',
    encode({ name: 'fixture-module', version: '9.0.0' }),
  );
  await assert.rejects(f.verify(), /Actual package version differs/);
  await f.bundled(
    'node_modules/fixture-module/package.json',
    encode({ name: 'fixture-module', version: '1.0.0' }),
  );
  await f.bundled(
    'node_modules/unlisted/package.json',
    encode({ name: 'unlisted', version: '1.0.0' }),
  );
  await assert.rejects(f.verify(), /Actual installed runtime packages membership differs/);
});

test('runtime gate hashes both executables before probing and rejects declared hash laundering', async (t) => {
  const f = await fixture(t);
  const altered = Buffer.from(f.engine); altered[220] ^= 1;
  await f.artifact('opencode.exe', altered);
  await assert.rejects(f.verify(), /Engine binary SHA256 mismatch/);
  assert.equal(f.calls.length, 0);
  f.manifest.opencode.sha256 = sha(altered);
  await f.save();
  await assert.rejects(f.verify(), /Engine binary SHA256 mismatch/);
});

test('runtime gate checks executable architecture and actual --version output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyRuntime(
      { root: f.root, runtimeRoot: f.runtimeRoot, profile: f.profile },
      { ...f.tools, binaryVersion: async () => 'v0.0.0' },
    ),
    /Actual node --version mismatch/,
  );
  f.node.writeUInt16LE(0x14c, 132);
  await f.bundled('node.exe', f.node);
  f.manifest.node.sha256 = sha(f.node);
  await f.source(
    'scripts/desktop-prepare.ts',
    `const nodeVersion = '24.19.0';\nconst nodeHash = '${sha(f.node)}';\n`,
  );
  await f.save();
  await assert.rejects(f.verify(), /Runtime binary is not x64/);
});

test('runtime gate rejects lock drift, document omission and escaping manifest paths', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, 'package-lock.json'), 'utf8');
  await f.source('package-lock.json', original + '\n');
  await assert.rejects(f.verify(), /package-lock input hash drift/);
  await f.source('package-lock.json', original);
  f.manifest.documents[1].path = 'OTHER.md';
  await f.save();
  await assert.rejects(f.verify(), /Required documents membership differs/);
  f.manifest.documents[1].path = 'SECURITY.md';
  f.manifest.notices[0].path = '../outside.txt';
  await f.save();
  await assert.rejects(f.verify(), /Invalid manifest path/);
});

test('runtime CLI has no skip switches and emits structured nonzero failures', async (t) => {
  for (const args of [
    ['--skip-binaries'],
    ['--profile', 'preview'],
    ['--root'],
    ['--profile', 'desktop', '--profile', 'desktop'],
  ])
    assert.throws(() => parseRuntimeArguments(args));
  const f = await fixture(t);
  await f.save({ builtAt: '2026-09-05T00:00:00.000Z' });
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, '../scripts/ci-verify-runtime.ts'),
      '--root',
      f.root,
      '--runtime',
      f.runtimeRoot,
      '--profile',
      f.profile,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'failed');
  assert.equal(report.schemaVersion, 1);
  assert(report.errors.length > 0);
});

test('notice generation separates package versions and merges matching duplicate identities', async (t) => {
  const f = await fixture(t);
  const rows = [
    { path: 'node_modules/example', version: '1.0.0', text: 'Version one copyright original\n' },
    {
      path: 'node_modules/parent/node_modules/example',
      version: '2.0.0',
      text: 'Version two copyright original\n',
    },
    {
      path: 'node_modules/other/node_modules/example',
      version: '2.0.0',
      text: 'Version two copyright original\n',
    },
  ];
  await f.source(
    'package-lock.json',
    encode({
      packages: Object.fromEntries(
        rows.map((row) => [
          row.path,
          { version: row.version, license: 'MIT', integrity: `sha512-${row.version}` },
        ]),
      ),
    }),
  );
  for (const row of rows) {
    await f.source(`${row.path}/package.json`, encode({ name: 'example', version: row.version }));
    await f.source(`${row.path}/LICENSE`, row.text);
  }
  const notices = await collectDependencyNotices(f.root);
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].licenseFile, notices[1].licenseFile);
  assert.equal(notices.find((row) => row.version === '2.0.0')!.packagePaths.length, 2);
  assert.equal(await readFile(join(f.root, 'docs', notices[0].licenseFile), 'utf8'), rows[0].text);
  assert.equal(await readFile(join(f.root, 'docs', notices[1].licenseFile), 'utf8'), rows[1].text);
});

test('notice generation rejects conflicting originals for the same identity before writing', async (t) => {
  const f = await fixture(t);
  const paths = ['node_modules/example', 'node_modules/parent/node_modules/example'];
  await f.source(
    'package-lock.json',
    encode({
      packages: Object.fromEntries(
        paths.map((path) => [
          path,
          { version: '1.0.0', license: 'MIT', integrity: 'sha512-fixture' },
        ]),
      ),
    }),
  );
  for (const [i, path] of paths.entries()) {
    await f.source(`${path}/package.json`, encode({ name: 'example', version: '1.0.0' }));
    await f.source(`${path}/LICENSE`, `Conflicting license original ${i}\n`);
  }
  await assert.rejects(
    collectDependencyNotices(f.root),
    /Conflicting notices for identical npm package/,
  );
  await assert.rejects(readFile(join(f.root, 'docs/licenses/npm/example/1.0.0/LICENSE')), /ENOENT/);
});

test('notice generation cannot invent an upstream license for an unreviewed version', async (t) => {
  const f = await fixture(t);
  const path = 'node_modules/@tauri-apps/api';
  await f.source(
    'package-lock.json',
    encode({
      packages: {
        [path]: { version: '99.0.0', license: 'MIT', integrity: 'sha512-fixture' },
      },
    }),
  );
  await f.source(`${path}/package.json`, encode({ name: '@tauri-apps/api', version: '99.0.0' }));
  await assert.rejects(
    collectDependencyNotices(f.root),
    /Missing license original without a reviewed version source/,
  );
});
