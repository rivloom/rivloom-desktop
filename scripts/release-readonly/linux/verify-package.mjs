// Read-only verification of the downloaded package, bound to the accepted Git source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparation, source as expectedSource } from './expected-release.mjs';
import { verifyPackagedSource } from './verify-full-source.mjs';

const root = new URL('./', import.meta.url);
const snapshot = name => new URL(`public-source/${name}`, root);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const frozen = name => preparation.files.find(file => file.destination === `public-source/${name}`);
const relativePath = value => {
  assert(typeof value === 'string' && value && !/[\\:\u0000-\u001f\u007f]/.test(value));
  assert(value.split('/').every(part => part && part !== '.' && part !== '..'));
  return value;
};

export async function verifyPackage({ packageRoot, runtime, run, sha, save }) {
  const appSourceProof = await verifyPackagedSource(packageRoot, expectedSource, preparation);
  const appRoot = join(packageRoot, 'app');
  assert.equal(runtime.schemaVersion, 1); assert.equal(runtime.kind, 'rivloom-headless-runtime');
  const source = await json(snapshot('engine-source-linux.json'));
  assert.equal(source.producerSchemaVersion, 2);
  assert.deepEqual(await json(join(appRoot, 'shared/engine-source-linux.json')), source);
  assert.equal(await sha(join(appRoot, 'shared/engine-source-linux.json')), frozen('engine-source-linux.json').sha256);
  assert.equal(await sha(join(appRoot, 'server/engine-artifact.ts')), frozen('engine-artifact.ts').sha256);
  const build = await readFile(snapshot('linux-build.ts'), 'utf8');
  const nodeVersion = /export const LINUX_NODE_VERSION = '([^']+)';/.exec(build)?.[1];
  const nodeArchiveSha256 = /x64: \{ nodeSha256: '([a-f0-9]{64})', machine: 62 \}/.exec(build)?.[1];
  assert(nodeVersion && nodeArchiveSha256, 'Immutable Node toolchain identity not found');
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(runtime.node.version, nodeVersion); assert.equal(runtime.node.archiveSha256, nodeArchiveSha256);
  const nodeName = `node-v${nodeVersion}-linux-x64`;
  assert.equal(runtime.node.source, `https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.xz`);
  const toolRoot = '/var/tmp/rivloom-linux-20260918/tools';
  const nodeArchive = join(toolRoot, `${nodeName}.tar.xz`);
  const archiveInfo = await lstat(nodeArchive); assert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink());
  assert.equal(await sha(nodeArchive), nodeArchiveSha256);
  const license = (await run('/usr/bin/tar', ['-xOf', nodeArchive, `${nodeName}/LICENSE`])).stdout;
  assert.equal(digest(await readFile(join(packageRoot, 'Node-LICENSE.txt'))), digest(license));
  assert.equal(await sha(join(packageRoot, 'runtime/node')), runtime.node.sha256);
  const upstreamNodeSha256 = (await run('/bin/sh', ['-c', `/usr/bin/tar -xOf '${nodeArchive}' '${nodeName}/bin/node' | /usr/bin/sha256sum`])).stdout.trim().split(/\s+/)[0];
  assert.match(upstreamNodeSha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.node.sha256, upstreamNodeSha256, 'Packaged Node differs from the pinned official archive binary');
  const nodeOutput = (await run(join(packageRoot, 'runtime/node'), ['--version'])).stdout.trim();
  assert.equal(nodeOutput, `v${nodeVersion}`);

  const fullLockBytes = await readFile(snapshot('source-package-lock.json')), fullLock = JSON.parse(fullLockBytes);
  assert.equal(runtime.packageLockSha256, digest(fullLockBytes));
  const shippedLock = await json(join(appRoot, 'package-lock.json'));
  const packages = new Map();
  for (const item of runtime.packages) {
    const path = relativePath(item.path); assert(path.startsWith('node_modules/'));
    assert(!path.split('/').some(part => part.startsWith('opencode-')));
    assert(!packages.has(path)); packages.set(path, item);
    const locked = fullLock.packages[path], shipped = shippedLock.packages[path];
    assert(locked && !locked.dev && shipped && !shipped.dev);
    assert.equal(item.version, locked.version); assert.equal(item.integrity, locked.integrity);
    assert.equal(shipped.version, item.version); assert.equal(shipped.integrity, item.integrity);
    assert.equal((await json(join(appRoot, path, 'package.json'))).version, item.version);
  }
  for (const name of ['@opencode-ai/sdk', '@opencode-ai/plugin']) assert.equal(packages.get(`node_modules/${name}`)?.version, source.packageVersion);
  for (const [path, value] of Object.entries(fullLock.packages)) if (path && !value.dev && !value.optional) assert(packages.has(path), `Missing required production package: ${path}`);

  const notices = await json(join(appRoot, 'docs/dependency-licenses.json'));
  assert.equal(notices.length, runtime.notices); assert(notices.length > 0);
  const covered = new Set(); let licenseFiles = 0;
  for (const row of notices) {
    assert(row.name && row.version && row.license && row.integrity);
    assert.equal(row.developmentOnly, false);
    assert(Array.isArray(row.packagePaths) && row.packagePaths.length > 0);
    assert(Array.isArray(row.licenseFiles) && row.licenseFiles.length > 0);
    assert.equal(row.licenseFiles.length, row.licenseSources.length); assert(row.licenseFiles.includes(row.licenseFile));
    for (const path of row.packagePaths) {
      relativePath(path); const item = packages.get(path); assert(item && !covered.has(path)); covered.add(path);
      assert.equal(row.version, item.version); assert.equal(row.integrity, item.integrity);
      assert.equal((await json(join(appRoot, path, 'package.json'))).name, row.name);
    }
    for (const [index, value] of row.licenseFiles.entries()) {
      const path = relativePath(value); assert(path.startsWith('licenses/npm/'));
      const filename = join(appRoot, 'docs', path), info = await lstat(filename);
      assert(info.isFile() && !info.isSymbolicLink() && info.size > 0);
      const licenseSource = row.licenseSources[index]; assert(['installed-package', 'distribution', 'upstream'].includes(licenseSource.kind));
      assert.equal(await sha(filename), licenseSource.sha256);
      if (licenseSource.kind === 'installed-package') {
        relativePath(licenseSource.file);
        for (const packagePath of row.packagePaths) assert.equal(await sha(join(appRoot, packagePath, licenseSource.file)), licenseSource.sha256);
      } else {
        assert.match(licenseSource.url, /^https:\/\//); assert(licenseSource.revision && licenseSource.packageVersionSource);
        if (licenseSource.kind === 'upstream') {
          assert.match(licenseSource.gitBlobSha1, /^[a-f0-9]{40}$/);
          const bytes = await readFile(filename);
          const gitBlobSha1 = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
          assert.equal(gitBlobSha1, licenseSource.gitBlobSha1, 'License original differs from the reviewed upstream Git blob');
        }
      }
      licenseFiles++;
    }
  }
  assert.deepEqual([...covered].sort(), [...packages.keys()].sort());
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) {
    const info = await lstat(join(packageRoot, name)); assert(info.isFile() && !info.isSymbolicLink() && info.size > 0);
    assert.equal(await sha(join(packageRoot, name)), frozen(name).sha256);
  }
  // The exact Git helper and every shipped dependency/lock/license declaration
  // are checked before import; importing this helper also evaluates zod.
  // The caller already verified every runtime path/byte/hash and the full source.
  const helper = await import(pathToFileURL(join(appRoot, 'server/engine-artifact.ts')).href);
  const engine = helper.verifyPreparedEngine(appRoot, 'linux-x64');
  assert.deepEqual(engine.source, source);
  assert.deepEqual(runtime.engineSource, { commit: source.commit, tree: source.tree,
    lockSha256: frozen('engine-source-linux.json').sha256, receiptSha256: engine.receiptSHA256, recipeSha256: engine.recipeSHA256 });
  assert.deepEqual(runtime.opencode, { version: source.version, sha256: engine.binarySHA256, source: `${source.repository}#${source.commit}` });
  assert.equal(await sha(join(engine.directory, 'LICENSE')), source.inputs.LICENSE);
  const engineProof = { status: 'passed', commit: source.commit, tree: source.tree, version: source.version,
    packageVersion: source.packageVersion, producerSchemaVersion: 2, inventoryFiles: source.sourceInventory.files,
    canonicalInventorySha256: source.sourceInventory.sha256, completeSourceInventory: true, receiptVerified: true,
    binarySha256: engine.binarySHA256, manifestSha256: engine.manifestSHA256, smokeSha256: engine.smokeSHA256,
    receiptSha256: engine.receiptSHA256, recipeSha256: engine.recipeSHA256, sourceLockSha256: runtime.engineSource.lockSha256 };
  await save('engine-provenance.json', engineProof);
  const result = {
    'app-source-integrity': appSourceProof,
    'engine-provenance': engineProof,
    'node-integrity': { status: 'passed', version: nodeVersion, archiveSha256: nodeArchiveSha256, binarySha256: runtime.node.sha256, officialArchiveBinarySha256: upstreamNodeSha256, binaryMatchesOfficialPinnedArchive: true, licenseMatchesOfficialPinnedArchive: true },
    'license-inventory': { status: 'passed', uniquePackages: notices.length, licenseFiles, completePackageCoverage: true, originalsSha256Verified: true, topLevelNoticesMatchImmutableSource: true, engineLicenseMatchesCoreInput: true },
    'package-dependencies': { status: 'passed', packages: packages.size, sourceLockSha256: runtime.packageLockSha256, sdkVersion: source.packageVersion, pluginVersion: source.packageVersion, installedAndLockedVersionsMatched: true, officialOpenCodeBinaryPackages: 0 },
  };
  await save('package-verification.json', result);
  return result;
}
