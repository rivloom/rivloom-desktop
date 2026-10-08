import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const evidenceRoot = fileURLToPath(new URL('./', import.meta.url));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitObjectHash = (type, bytes) => createHash('sha1').update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest('hex');
export function sourcePath(value) {
  assert(typeof value === 'string' && value && !/[\\:\u0000-\u001f\u007f]/.test(value));
  assert(value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)));
  assert(!value.startsWith('.git/') && value !== '.git');
  return value;
}
// Reconstruct the exact Git tree from every tracked leaf, so an incomplete
// parent snapshot cannot masquerade as the final release source.
export function sourceTreeHash(files) {
  const root = { files: new Map(), directories: new Map() }, names = new Set();
  for (const file of files) {
    sourcePath(file.path); assert(['100644', '100755'].includes(file.mode)); assert.match(file.gitBlobSHA1, /^[a-f0-9]{40}$/);
    assert(!names.has(file.path.toLowerCase())); names.add(file.path.toLowerCase());
    const parts = file.path.split('/'), name = parts.pop(); let node = root;
    for (const part of parts) {
      assert(!node.files.has(part));
      if (!node.directories.has(part)) node.directories.set(part, { files: new Map(), directories: new Map() });
      node = node.directories.get(part);
    }
    assert(!node.directories.has(name)); node.files.set(name, file);
  }
  const hash = node => {
    const entries = [...node.files].map(([name, file]) => ({ name, mode: file.mode, sha: file.gitBlobSHA1, tree: false }));
    for (const [name, directory] of node.directories) entries.push({ name, mode: '40000', sha: hash(directory), tree: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.tree ? '/' : '')), Buffer.from(b.name + (b.tree ? '/' : ''))));
    return gitObjectHash('tree', Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, 'hex')]))));
  };
  return hash(root);
}
export async function verifyFullSource(expected, frozen = null) {
  assert.match(expected.commit, /^[a-f0-9]{40}$/); assert.match(expected.tree, /^[a-f0-9]{40}$/);
  const directoryName = `full-source-${expected.commit}`, directory = resolve(evidenceRoot, directoryName);
  assert.equal(directory, join(resolve(evidenceRoot), directoryName));
  const info = await lstat(directory); assert(info.isDirectory() && !info.isSymbolicLink()); assert.equal(await realpath(directory), directory);
  const manifestPath = join(directory, 'manifest.json'), manifestInfo = await lstat(manifestPath);
  assert(manifestInfo.isFile() && !manifestInfo.isSymbolicLink());
  const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  if (frozen) { assert.equal(frozen.directory, directoryName); assert.equal(frozen.manifestSHA256, digest(bytes)); }
  assert.equal(manifest.status, 'complete-git-source-snapshot'); assert.equal(manifest.commit, expected.commit); assert.equal(manifest.tree, expected.tree);
  assert.equal(manifest.fileCount, manifest.files.length); assert.equal(sourceTreeHash(manifest.files), expected.tree, 'Snapshot is missing final-commit tracked source');
  const fileRoot = join(directory, 'files'), found = [];
  async function walk(path, prefix = '') {
    const info = await lstat(path); assert(info.isDirectory() && !info.isSymbolicLink());
    for (const name of await readdir(path)) {
      const target = join(path, name), relative = prefix + name, entry = await lstat(target); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) await walk(target, relative + '/');
      else { assert(entry.isFile()); found.push(relative); }
    }
  }
  await walk(fileRoot); assert.deepEqual(found.sort(), manifest.files.map(file => file.path).sort());
  for (const file of manifest.files) {
    const target = join(fileRoot, sourcePath(file.path)), info = await lstat(target); assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, file.bytes); const content = await readFile(target);
    assert.equal(digest(content), file.sha256); assert.equal(gitObjectHash('blob', content), file.gitBlobSHA1, `Git blob changed: ${file.path}`);
  }
  const packageLock = manifest.files.find(file => file.path === 'package-lock.json'); assert(packageLock);
  assert.equal(manifest.packageLockSHA256, packageLock.sha256);
  const lock = JSON.parse(await readFile(join(fileRoot, 'package-lock.json'))); assert.equal(lock.version, expected.version);
  return { directory: directoryName, manifestSHA256: digest(bytes), commit: manifest.commit, tree: manifest.tree, files: manifest.files, packageLockSHA256: packageLock.sha256 };
}
export async function verifyPackagedSource(packageRoot, expected, preparation) {
  const snapshot = await verifyFullSource(expected, preparation.fullSource);
  assert(preparation.fullSource, 'Bind the complete final Git source before running any package');
  const files = snapshot.files.filter(file => /^(?:cli|server|shared)\//.test(file.path)), found = [];
  for (const directory of ['cli', 'server', 'shared']) {
    const walk = async (path, prefix) => {
      const info = await lstat(path); assert(info.isDirectory() && !info.isSymbolicLink());
      for (const name of await readdir(path)) { const target = join(path, name), entry = await lstat(target); assert(!entry.isSymbolicLink());
        if (entry.isDirectory()) await walk(target, prefix + name + '/'); else { assert(entry.isFile()); found.push(prefix + name); } }
    };
    await walk(join(packageRoot, 'app', directory), directory + '/');
  }
  assert.deepEqual(found.sort(), files.map(file => file.path).sort());
  for (const file of files) { const bytes = await readFile(join(packageRoot, 'app', file.path)); assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256, `Packaged source differs from final Git: ${file.path}`); }
  return { status: 'passed', sourceCommit: expected.commit, sourceTree: expected.tree, completeTrackedFiles: snapshot.files.length,
    packagedSourceFiles: files.length, fullSnapshotManifestSHA256: snapshot.manifestSHA256, sourcePackageLockSHA256: snapshot.packageLockSHA256, completeGitTreeReconstructed: true, pathBytesHashMatch: true };
}
