// Static files only. Never launches the installed application or its bundled runtime.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expectations } from './expected-release.mjs';
const base = import.meta.dirname;
const [runID, artifactID, mode = '--pending'] = process.argv.slice(2);
assert(/^[1-9]\d+$/.test(runID) && /^[1-9]\d+$/.test(artifactID));
assert(['--pending', '--complete-public'].includes(mode));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async name => JSON.parse((await readFile(join(base, name), 'utf8')).replace(/^\uFEFF/, ''));
const source = await json('release-source.json');
assert.equal(source.version, expectations.version);
assert.equal(String(source.runs.windowsRelease), runID); assert.equal(String(source.windowsArtifactID), artifactID);
const candidateRoot = join(base, `candidate-${runID}-${artifactID}`);
async function regular(path, directory = false) {
  const within = relative(base, resolve(path));
  assert(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`));
  let current = base;
  for (const part of within.split(sep)) {
    current = join(current, part); assert(!(await lstat(current)).isSymbolicLink(), 'Linked evidence is not accepted');
  }
  const info = await lstat(path); assert(directory ? info.isDirectory() : info.isFile()); return info;
}
const candidatePath = join(candidateRoot, 'candidate-verification.json');
await regular(candidatePath);
const candidateBytes = await readFile(candidatePath), candidate = JSON.parse(candidateBytes);
assert.equal(candidate.status, 'passed'); assert.equal(candidate.commit, source.commit); assert.equal(candidate.version, source.version);
assert.equal(candidate.runID, runID); assert.equal(candidate.artifactID, artifactID);
assert.equal(candidate.originalHostedInstallationSmokeVerified, true);
assert.equal(candidate.installerExecuted, false); assert.equal(candidate.runtimeExecuted, false);
const executablePath = join(candidateRoot, 'extracted', 'Rivloom.exe');
const executableStat = await regular(executablePath);
const version = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(base, 'read-executable-version.ps1'), '-Executable', executablePath],
  { windowsHide: true, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/^\uFEFF/, ''));
assert.equal(version.fileVersion, source.version); assert.equal(version.productVersion, source.version);
assert.equal(version.productName, 'Rivloom');
const distPath = join(candidateRoot, 'extracted', 'runtime', 'dist'); await regular(distPath, true);
const fileManifest = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); assert(!entry.isSymbolicLink(), 'Dist links are not accepted');
    if (entry.isDirectory()) { await regular(path, true); await walk(path); }
    else {
      const info = await regular(path), bytes = await readFile(path);
      assert(info.size === bytes.length && bytes.length > 0);
      fileManifest.push({ path: relative(distPath, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes),
        containsVersionLiteral: /\.(?:js|mjs|css|html|json)$/.test(entry.name) && bytes.includes(Buffer.from(source.version)) });
    }
  }
}
await walk(distPath); fileManifest.sort((a, b) => a.path.localeCompare(b.path));
assert(fileManifest.length > 0 && fileManifest.some(file => file.path === 'index.html'));
const installerName = candidate.installer.name; assert.equal(basename(installerName), installerName);
assert.equal(installerName, `Rivloom_${source.version}_x64-setup.exe`);
const installerCopies = [];
async function measureInstaller(path) {
  const info = await regular(path), bytes = await readFile(path), sha256 = digest(bytes);
  assert.equal(info.size, candidate.installer.bytes); assert.equal(sha256, candidate.installer.sha256);
  installerCopies.push({ path, bytes: info.size, sha256 });
}
await measureInstaller(join(candidateRoot, 'proof', 'test-results', 'candidate', installerName));
if (mode === '--complete-public') {
  const publicReport = await json('windows-public-verification.json');
  assert.equal(publicReport.status, 'passed'); assert.equal(publicReport.sourceCommit, source.commit); assert.equal(publicReport.version, source.version);
  assert.equal(String(publicReport.record.build.runID), runID); assert.equal(String(publicReport.record.build.artifactID), artifactID);
  assert.equal(publicReport.record.artifact.fileName, installerName);
  assert.equal(publicReport.bytes, candidate.installer.bytes); assert.equal(publicReport.sha256, candidate.installer.sha256);
  await measureInstaller(join(base, installerName));
}
const report = { schemaVersion: 1, status: mode === '--complete-public' ? 'passed' : 'pending-public-comparison', at: new Date().toISOString(),
  commit: source.commit, version: source.version, runID, artifactID, candidateVerificationSHA256: digest(candidateBytes),
  executable: { path: executablePath, bytes: executableStat.size, sha256: digest(await readFile(executablePath)), ...version },
  dist: { path: distPath, files: fileManifest.length, bytes: fileManifest.reduce((total, file) => total + file.bytes, 0), fileManifest,
    versionLiteralFiles: fileManifest.filter(file => file.containsVersionLiteral).map(file => file.path) },
  installerCopies, publicDownloadByteMatch: mode === '--complete-public', installerExecuted: false, runtimeExecuted: false,
  uiScreenshotClaimed: false, note: 'Static package evidence only. Website screenshot fields must be added from separately completed browser verification of this exact dist.' };
await writeFile(join(base, mode === '--complete-public' ? 'packaged-ui-verification.json' : 'packaged-ui-verification-pending.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, commit: source.commit, nativeVersion: version.fileVersion, frontendFiles: report.dist.files,
  frontendBytes: report.dist.bytes, publicDownloadByteMatch: report.publicDownloadByteMatch, dist: distPath }));
