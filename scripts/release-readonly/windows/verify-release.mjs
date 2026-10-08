import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { source, expectations } from './expected-release.mjs';
import { parseDownloadRecord } from './public-source/download-record.ts';
import { parseSignedUpdate, verifyUpdateArtifact } from './public-source/updater-manifest.ts';
const root = new URL('./', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const save = (name, value) => writeFile(new URL(name, root), JSON.stringify(value, null, 2) + '\n');

const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 ** 2, windowsHide: true }));
const get = async (url, limit = 65536) => {
  // Public acceptance tolerates this host's slow download route; product/CI
  // lifecycle deadlines are unchanged. Always download all bytes in one GET.
  const response = await fetch(url, { redirect: 'error', headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(limit > 1048576 ? 1_200_000 : 60_000) });
  assert.equal(response.status, 200, url); const parts = []; let size = 0;
  let nextProgress = Date.now() + 30000;
  for await (const part of response.body) { size += part.length; assert(size <= limit); parts.push(Buffer.from(part)); if (limit > 1048576 && Date.now() >= nextProgress) { console.log(`Public complete download: ${size}/${limit} bytes`); nextProgress = Date.now() + 30000; } }
  return { bytes: Buffer.concat(parts), headers: Object.fromEntries(response.headers) };
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (await readFile(new URL('./public-source/updater.pub', root), 'utf8')).trim();
const mode = process.argv[2];
if (mode === 'windows' || mode === 'windows-from-wsl') {
  const download = await get('https://downloads.rivloom.com/releases/latest.json');
  const record = parseDownloadRecord(JSON.parse(download.bytes));
  assert.equal(record.version, source.version); assert.equal(record.source.commit, source.commit);
  assert.equal(record.build.runID, String(source.runs.windowsRelease)); assert.equal(record.build.artifactID, String(source.windowsArtifactID));
  assert.match(download.headers['cache-control'], /no-store/);
  const latest = await get('https://downloads.rivloom.com/updates/stable/latest.json');
  assert.match(latest.headers['cache-control'], /no-store/);
  const parsed = parseSignedUpdate(JSON.parse(latest.bytes), key);
  assert.equal(parsed.metadata.version, record.version); assert.equal(parsed.metadata.url, record.artifact.url);
  assert.equal(parsed.metadata.sha256, record.artifact.sha256); assert.equal(parsed.metadata.bytes, record.artifact.bytes);
  for (const phrase of expectations.notesIncludes) assert(parsed.metadata.notes.includes(phrase), `Signed notes missing ${phrase}`);
  const previous = JSON.parse((await get(`https://downloads.rivloom.com/updates/stable/${expectations.previousVersion}.json`)).bytes);
  assert.equal(parseSignedUpdate(previous, key).metadata.version, expectations.previousVersion);
  const immutable = await get(`https://downloads.rivloom.com/updates/stable/${record.version}.json`);
  assert.deepEqual(parseSignedUpdate(JSON.parse(immutable.bytes), key), parsed);
  let installer;
  if (mode === 'windows-from-wsl') {
    const proof = await read('windows-public-wsl-download.json');
    assert.equal(proof.status, 'passed'); assert.equal(proof.method, 'curl-independent-full'); assert.equal(proof.installerExecuted, false);
    assert.equal(proof.sourceCommit, source.commit); assert.equal(proof.version, source.version);
    assert.equal(proof.runID, String(source.runs.windowsRelease)); assert.equal(proof.artifactID, String(source.windowsArtifactID));
    assert.deepEqual(proof.artifact, record.artifact); assert.equal(proof.retainedArtifact, record.artifact.fileName);
    assert.equal(proof.originalKeyArtifactSignature, 'passed'); assert.equal(proof.bytes, record.artifact.bytes); assert.equal(proof.sha256, record.artifact.sha256);
    const retained = new URL(record.artifact.fileName, root), info = await lstat(retained);
    assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.size, record.artifact.bytes);
    installer = { bytes: await readFile(retained) };
  } else {
    await assert.rejects(lstat(new URL(record.artifact.fileName, root)), { code: 'ENOENT' }, 'A retained package already exists; inspect its report before another download.');
    installer = await get(record.artifact.url, record.artifact.bytes);
  }
  assert.equal(installer.bytes.length, record.artifact.bytes); verifyUpdateArtifact(installer.bytes, parsed.metadata, key);
  const sums = await get(record.checksum.url, record.checksum.bytes);
  assert.equal(sums.bytes.length, record.checksum.bytes); assert.equal(digest(sums.bytes), record.checksum.sha256); assert.equal(sums.bytes.toString(), `${record.artifact.sha256}  ${record.artifact.fileName}\n`);
  const release = api(`repos/rivloom/rivloom-desktop/releases/${record.release.id}`);
  assert.equal(release.target_commitish, source.commit); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  const releaseTag = api(`repos/rivloom/rivloom-desktop/git/ref/tags/${record.release.tag}`);
  assert.equal(releaseTag.object.type, 'commit'); assert.equal(releaseTag.object.sha, source.commit);
  for (const item of [record.artifact, record.checksum]) {
    const asset = release.assets.find(a => a.name === item.fileName); assert(asset); assert.equal(asset.size, item.bytes); assert.equal(asset.digest, `sha256:${item.sha256}`);
  }
  await writeFile(new URL('windows-download.json', root), download.bytes); await writeFile(new URL('signed-update.json', root), latest.bytes);
  if (mode === 'windows') await writeFile(new URL(record.artifact.fileName, root), installer.bytes, { flag: 'wx' });
  const report = { at: new Date().toISOString(), status: 'passed', sourceCommit: source.commit, version: source.version, record, releaseURL: release.html_url, bytes: installer.bytes.length, sha256: record.artifact.sha256,
    checks: ['anonymous complete download', 'strict source/version binding', `original trust key also verifies ${expectations.previousVersion}`, 'signed notes', 'installer signature and SHA256', 'immutable update matches latest', 'no-store pointers', 'checksum and GitHub asset digest'], downloadMethod: mode === 'windows-from-wsl' ? 'WSL curl-independent-full; retained bytes independently rehashed and signature reverified' : 'Windows Node single full GET', installerExecuted: false };
  await save('windows-public-verification.json', report); console.log(JSON.stringify({ status: report.status, version: source.version, bytes: report.bytes, sha256: report.sha256, releaseURL: report.releaseURL }));
} else throw new Error('Choose windows or windows-from-wsl; this helper only verifies Windows and never deploys the website.');
