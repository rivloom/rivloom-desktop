// Exact owned acceptance sandbox only. inspect/preflight never deletes anything.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { source } from './expected-release.mjs';

assert.equal(process.platform, 'linux');
const mode = process.argv[2]; assert(['inspect', 'preflight', 'delete'].includes(mode));
const root = fileURLToPath(new URL('./', import.meta.url));
const selected = process.argv[3];
assert.match(selected || '', /^public-wsl-[A-Za-z0-9]+\/report\.json$/);
const reportPath = join(root, selected);
const proof = JSON.parse(await readFile(reportPath, 'utf8'));
const target = proof.sandbox;
const ownerUID = proof.environment.uid; assert(Number.isSafeInteger(ownerUID) && ownerUID > 0);
assert([0, ownerUID].includes(process.getuid()), 'Inspect only this hosted consumer owner');
assert.match(target, /^\/var\/tmp\/rivloom-public-x64-[A-Za-z0-9]+$/);
assert.equal(proof.evidence, join(root, selected.split('/')[0]));
assert(['passed', 'download-runtime-passed-awaiting-website'].includes(proof.status)); assert.equal(proof.sandbox, target);
assert.equal(proof.release.commit, source.commit); assert.equal(proof.release.version, source.version);
assert.equal(proof.checks['restart-sigterm'].identityPreserved, true);
assert.equal(proof.checks['retained-archive'].sha256, proof.release.artifact.sha256);
assert.equal(proof.checks['runtime-integrity'].sourceCommit, source.commit);
assert(!/[\/\\]/.test(proof.release.artifact.fileName));
const retained = join(root, selected.split('/')[0], proof.release.artifact.fileName);
const within = path => path === target || path.startsWith(target + '/');
const gone = error => ['ENOENT', 'ESRCH'].includes(error.code);
async function sha(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
async function boundary() {
  assert.equal(await realpath('/var/tmp'), '/var/tmp');
  const info = await lstat(target);
  assert(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.uid, ownerUID);
  assert.equal(await realpath(target), target);
  return info;
}
await boundary();
async function processes() {
  const active = [], unreadable = []; let inspected = 0;
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      const info = await lstat(`/proc/${pid}`);
      if (info.uid !== ownerUID) continue;
      inspected++;
      for (const kind of ['exe', 'cwd']) {
        try { const path = await readlink(`/proc/${pid}/${kind}`); if (within(path.replace(/ \(deleted\)$/, ''))) active.push({ pid, kind, path }); }
        catch (error) { if (!gone(error)) unreadable.push({ pid, kind, code: error.code }); }
      }
      try {
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          try { const path = await readlink(`/proc/${pid}/fd/${fd}`); if (within(path.replace(/ \(deleted\)$/, ''))) active.push({ pid, kind: 'fd', fd, path }); }
          catch (error) { if (!gone(error)) unreadable.push({ pid, kind: 'fd', code: error.code }); }
        }
      } catch (error) { if (!gone(error)) unreadable.push({ pid, kind: 'fd-directory', code: error.code }); }
      try { if ((await readFile(`/proc/${pid}/maps`, 'utf8')).includes(target + '/')) active.push({ pid, kind: 'memory-map', path: target }); }
      catch (error) { if (!gone(error)) unreadable.push({ pid, kind: 'memory-map', code: error.code }); }
    } catch (error) { if (!gone(error)) throw error; }
  }
  return { inspectedSameOwnerProcesses: inspected, inspectorUID: process.getuid(), active, unreadable, complete: unreadable.length === 0 };
}
const processCheck = await processes();
if (mode === 'inspect') {
  await writeFile(join(root, `linux-process-inspection-uid${process.getuid()}.json`), JSON.stringify({ at: new Date().toISOString(), target, ...processCheck }, null, 2) + '\n');
  console.log(JSON.stringify(processCheck)); process.exit(processCheck.active.length || !processCheck.complete ? 2 : 0);
}
assert.equal(processCheck.complete, true, 'Cannot prove process ownership; leave sandbox untouched.');
assert.deepEqual(processCheck.active, [], 'Sandbox is still used by a process.');
const artifact = proof.release.artifact;
const retainedInfo = await lstat(retained); assert(retainedInfo.isFile() && !retainedInfo.isSymbolicLink());
assert.equal(retainedInfo.size, artifact.bytes); assert.equal(await sha(retained), artifact.sha256);
const inventoryPath = join(root, 'linux-cleanup-preflight.json');
if (mode === 'preflight') {
  const files = [], directories = [];
  async function walk(path) {
    assert(within(path)); const info = await lstat(path);
    assert.equal(info.uid, ownerUID); assert(!info.isSymbolicLink());
    if (info.isDirectory()) { directories.push({ path, dev: info.dev, ino: info.ino }); for (const name of await readdir(path)) await walk(join(path, name)); }
    else {
      assert(info.isFile()); assert.equal(info.nlink, 1);
      const digest = await sha(path), after = await lstat(path);
      for (const field of ['dev', 'ino', 'size', 'mtimeMs']) assert.equal(after[field], info[field]);
      files.push({ path, relative: relative(target, path), bytes: info.size, sha256: digest, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs });
    }
  }
  await walk(target);
  const result = { at: new Date().toISOString(), status: 'prepared', sourceCommit: source.commit, target, bytes: files.reduce((sum, file) => sum + file.bytes, 0), fileCount: files.length, directoryCount: directories.length, files, directories, processCheck, retained: { path: retained, bytes: artifact.bytes, sha256: artifact.sha256 }, boundary: { uid: ownerUID, symlinks: 0, hardLinks: 0, specialFiles: 0, linksFollowed: false }, reason: 'Full public download and isolated hosted native lifecycle completed; website acceptance remains separate; retain reports and an archive until the consumer readers finish.' };
  await writeFile(inventoryPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, target, bytes: result.bytes, files: files.length, directories: directories.length, processCheck }));
} else {
  const previous = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.equal(previous.target, target); assert.equal(previous.sourceCommit, source.commit); assert.equal(previous.status, 'prepared');
  await boundary();
  for (const item of previous.files) {
    assert(within(item.path)); const info = await lstat(item.path);
    assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.nlink, 1); assert.equal(info.uid, ownerUID);
    for (const field of ['dev', 'ino', 'mtimeMs']) assert.equal(info[field], item[field]);
    assert.equal(info.size, item.bytes); assert.equal(await sha(item.path), item.sha256);
  }
  for (const item of previous.directories) { assert(within(item.path)); const info = await lstat(item.path); assert(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.dev, item.dev); assert.equal(info.ino, item.ino); }
  const finalProcessCheck = await processes(); assert.equal(finalProcessCheck.complete, true); assert.deepEqual(finalProcessCheck.active, []);
  // Delete only entries already measured, never recursive traversal or a glob.
  for (const file of previous.files) await unlink(file.path);
  for (const directory of previous.directories.sort((left, right) => right.path.length - left.path.length)) await rmdir(directory.path);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  assert.equal(await sha(retained), artifact.sha256);
  const result = { at: new Date().toISOString(), status: 'completed', sourceCommit: source.commit, target, deletedBytes: previous.bytes, deletedFiles: previous.fileCount, deletedDirectories: previous.directoryCount, inventory: 'linux-cleanup-preflight.json', processCheck: finalProcessCheck, retained: previous.retained, boundary: previous.boundary, userInstallationChanged: false, oldSandboxesTouched: false };
  await writeFile(join(root, 'linux-cleanup.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
