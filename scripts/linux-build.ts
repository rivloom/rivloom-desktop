// Native headless packaging. Downloads are pinned; no user data is copied.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDependencyNotices } from './notices.ts';

export const LINUX_NODE_VERSION = '24.19.0';
export const LINUX_ENGINE_VERSION = '1.18.25';
export const LINUX_TARGETS = {
  x64: { nodeSha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647', enginePackage: 'opencode-linux-x64-baseline', machine: 62 },
  arm64: { nodeSha256: '01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc', enginePackage: 'opencode-linux-arm64', machine: 183 },
} as const;
export type LinuxArch = keyof typeof LINUX_TARGETS;
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function verifyEnginePackagePath(path: string, arch: LinuxArch) {
  assert(!path.startsWith('node_modules/opencode-') || path === `node_modules/${LINUX_TARGETS[arch].enginePackage}`, 'Wrong platform OpenCode dependency');
}
export function bundledLinuxReadme(source: string, commit: string) {
  assert(/^[0-9a-f]{40}$/.exec(commit)?.[0] === commit);
  return source.replace(/\]\((CI|RELEASING|R2-RETENTION)\.md\)/g, (_match, name: string) => `](https://github.com/rivloom/rivloom-desktop/blob/${commit}/docs/${name}.md)`);
}
export function linuxArch(value: string): LinuxArch {
  assert(value === 'x64' || value === 'arm64', 'Linux supports x64 and arm64 only');
  return value;
}
export function verifyElf(bytes: Buffer, arch: LinuxArch) {
  assert(bytes.length > 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'Expected ELF executable');
  assert.equal(bytes[4], 2, 'Expected ELF64');
  assert.equal(bytes[5], 1, 'Expected little-endian ELF');
  assert.equal(bytes.readUInt16LE(18), LINUX_TARGETS[arch].machine, 'ELF architecture differs');
}
export function verifyIntegrity(bytes: Buffer, integrity: string) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), integrity, 'Pinned npm archive integrity differs');
}
export function linuxLauncher() {
  return '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport RIVLOOM_CLI_EXECUTABLE="$ROOT/bin/rivloom"\nexec "$ROOT/runtime/node" "$ROOT/app/cli/index.ts" "$@"\n';
}
async function download(url: string, path: string, verify: (bytes: Buffer) => void) {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(240_000) });
    assert.equal(response.status, 200, 'Pinned upstream archive download failed');
    bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes);
    await writeFile(path, bytes, { flag: 'wx' });
  }
  verify(bytes);
}
async function files(path: string, base = path): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const source = join(path, entry.name);
    assert(!entry.isSymbolicLink(), 'Package cannot contain symbolic links');
    if (entry.isDirectory()) result.push(...await files(source, base));
    else {
      assert(entry.isFile(), 'Package contains a special file');
      const bytes = await readFile(source);
      result.push({ path: relative(base, source).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function buildLinux(root: string, arch = linuxArch(process.arch)) {
  assert.equal(process.platform, 'linux', 'Linux packages must be built and verified on native Linux');
  assert.equal(process.arch, arch, 'Cross-building is not supported; use the native matrix runner');
  assert.equal(process.versions.node, LINUX_NODE_VERSION, 'Use the pinned Node toolchain');
  const target = LINUX_TARGETS[arch];
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  const engineLock = lock.packages[`node_modules/${target.enginePackage}`];
  assert.equal(engineLock.version, LINUX_ENGINE_VERSION);
  const cache = join(root, '.data', 'linux-downloads');
  await mkdir(cache, { recursive: true });
  const nodeName = `node-v${LINUX_NODE_VERSION}-linux-${arch}`;
  const nodeArchive = join(cache, `${nodeName}.tar.xz`);
  await download(`https://nodejs.org/dist/v${LINUX_NODE_VERSION}/${nodeName}.tar.xz`, nodeArchive, (bytes) => assert.equal(hash(bytes), target.nodeSha256, 'Pinned Node archive digest differs'));
  const engineArchive = join(cache, `${target.enginePackage}-${LINUX_ENGINE_VERSION}.tgz`);
  const engineUrl = `https://registry.npmjs.org/${target.enginePackage}/-/${target.enginePackage}-${LINUX_ENGINE_VERSION}.tgz`;
  assert.equal(engineLock.resolved, engineUrl);
  await download(engineUrl, engineArchive, (bytes) => verifyIntegrity(bytes, engineLock.integrity));
  const work = await mkdtemp(join(cache, `stage-${arch}-`));
  const upstream = join(work, 'upstream');
  await mkdir(upstream);
  execFileSync('tar', ['-xJf', nodeArchive, '-C', upstream, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
  execFileSync('tar', ['-xzf', engineArchive, '-C', upstream, 'package/bin/opencode', 'package/package.json']);
  const node = await readFile(join(upstream, nodeName, 'bin/node'));
  const engine = await readFile(join(upstream, 'package/bin/opencode'));
  verifyElf(node, arch); verifyElf(engine, arch);
  assert.equal(hash(engine), hash(await readFile(join(root, 'node_modules', target.enginePackage, 'bin/opencode'))), 'Installed OpenCode differs from pinned published archive');
  const destination = join(work, 'rivloom');
  await mkdir(join(destination, 'app'), { recursive: true });
  await mkdir(join(destination, 'runtime'));
  await mkdir(join(destination, 'bin'));
  for (const directory of ['cli', 'server', 'shared']) await cp(join(root, directory), join(destination, 'app', directory), { recursive: true });
  await writeFile(join(destination, 'runtime/node'), node, { mode: 0o755 });
  await chmod(join(destination, 'runtime/node'), 0o755);
  await writeFile(join(destination, 'bin/rivloom'), linuxLauncher(), { mode: 0o755 });
  await cp(join(upstream, nodeName, 'LICENSE'), join(destination, 'Node-LICENSE.txt'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) await cp(join(root, name), join(destination, name));
  await writeFile(join(destination, 'README.md'), bundledLinuxReadme(await readFile(join(root, 'docs/LINUX.md'), 'utf8'), commit));
  const packages = [];
  for (const [path, value] of Object.entries(lock.packages) as [string, any][]) {
    if (!path || value.dev) continue;
    assert(path.startsWith('node_modules/') && !path.split('/').includes('..'));
    const source = join(root, path);
    try { await lstat(source); } catch (error) {
      if (value.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    verifyEnginePackagePath(path, arch);
    const to = join(destination, 'app', path);
    await mkdir(dirname(to), { recursive: true });
    await cp(source, to, { recursive: true, dereference: true, filter: (input) => !relative(source, input).split(/[\\/]/).includes('node_modules') });
    packages.push({ path, version: value.version, integrity: value.integrity });
  }
  const app = { name: 'rivloom-headless', version: manifest.version, private: true, license: manifest.license, type: 'module' };
  await writeFile(join(destination, 'app/package.json'), JSON.stringify(app, null, 2) + '\n');
  // Collect only the shipped production tree. Every notice is bound to its installed
  // original or a reviewed upstream blob; no Windows/Rust inventory is reused as Linux proof.
  const shippedLock = { ...lock, packages: Object.fromEntries(Object.entries(lock.packages).filter(([path, value]: [string, any]) => !path || !value.dev)) };
  await writeFile(join(destination, 'app/package-lock.json'), JSON.stringify(shippedLock));
  const notices = await collectDependencyNotices(join(destination, 'app'));
  await writeFile(join(destination, 'app/docs/dependency-licenses.json'), JSON.stringify(notices, null, 2) + '\n');
  const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const runtime = { schemaVersion: 1, kind: 'rivloom-headless-runtime', version: manifest.version, sourceCommit: commit, sourceDirty, target: { platform: 'linux', arch }, packageLockSha256: hash(lockBytes), node: { version: LINUX_NODE_VERSION, sha256: hash(node), archiveSha256: target.nodeSha256, source: `https://nodejs.org/dist/v${LINUX_NODE_VERSION}/${nodeName}.tar.xz` }, opencode: { version: LINUX_ENGINE_VERSION, sha256: hash(engine), package: target.enginePackage, integrity: engineLock.integrity, source: engineUrl }, packages, notices: notices.length, files: await files(destination) };
  await writeFile(join(destination, 'runtime-manifest.json'), JSON.stringify(runtime, null, 2) + '\n');
  const output = join(root, 'test-results', 'linux', arch);
  await mkdir(output, { recursive: true });
  const fileName = `Rivloom_${manifest.version}_linux_${arch}.tar.gz`;
  const archive = join(output, fileName);
  execFileSync('tar', ['-czf', archive, '-C', work, 'rivloom']);
  const bytes = await readFile(archive);
  const record = { schemaVersion: 1, kind: 'rivloom-linux-build', version: manifest.version, sourceCommit: commit, sourceDirty, runID: process.env.GITHUB_RUN_ID || 'local', target: { platform: 'linux', arch }, artifact: { fileName, bytes: bytes.length, sha256: hash(bytes) }, runtimeManifestSha256: hash(await readFile(join(destination, 'runtime-manifest.json'))), nodeVersion: LINUX_NODE_VERSION, engineVersion: LINUX_ENGINE_VERSION };
  await writeFile(join(output, 'build.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`Linux ${arch} built: ${fileName}. Native startup verification is still required.`);
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildLinux(resolve(import.meta.dirname, '..'));
