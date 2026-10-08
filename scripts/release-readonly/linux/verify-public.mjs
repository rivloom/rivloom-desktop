import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { source } from './expected-release.mjs';
import { parseLinuxDownloadRecord, linuxChecksums } from './public-source/linux-download-record.ts';
const root = new URL('./', import.meta.url), execute = promisify(execFile);
const api = async path => JSON.parse((await execute('gh', ['api', `repos/rivloom/rivloom-desktop/${path}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 ** 2 })).stdout);
const save = (name, value) => writeFile(new URL(name, root), JSON.stringify(value, null, 2) + '\n');
async function get(url) {
  const response = await fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, url); const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length < 65536);
  return { bytes, headers: Object.fromEntries(response.headers) };
}
async function sha(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
const mode = process.argv[2]; assert(['gate', 'runtime'].includes(mode));
const workflowID = process.argv[3]; assert.match(workflowID || '', /^[1-9]\d+$/);
const report = { at: new Date().toISOString(), sourceCommit: source.commit, version: source.version, status: 'checking', mode };
try {
  const workflow = await api(`actions/runs/${workflowID}`);
  assert.equal(workflow.head_sha, source.commit); assert.equal(workflow.head_branch, 'main'); assert.equal(workflow.event, 'workflow_dispatch');
  assert.equal(workflow.path, '.github/workflows/linux-release.yml'); assert.equal(workflow.status, 'completed'); assert.equal(workflow.conclusion, 'success');
  assert.equal(workflow.repository.full_name, 'rivloom/rivloom-desktop');
  const jobs = await api(`actions/runs/${workflowID}/attempts/${workflow.run_attempt}/jobs?per_page=100`);
  assert.equal(jobs.total_count, 3); assert.equal(jobs.jobs.length, 3);
  assert.deepEqual(jobs.jobs.map(job => job.name).sort(), ['publish', 'verify', 'website-download']);
  assert(jobs.jobs.every(job => job.status === 'completed' && job.conclusion === 'success'));
  report.workflow = { id: workflow.id, url: workflow.html_url, headSha: workflow.head_sha, status: workflow.status, conclusion: workflow.conclusion, attempt: workflow.run_attempt, jobs: jobs.jobs };
  const download = await get('https://downloads.rivloom.com/releases/linux/latest.json');
  const record = parseLinuxDownloadRecord(JSON.parse(download.bytes));
  assert.equal(record.source.commit, source.commit); assert.equal(record.version, source.version);
  assert.equal(record.build.runID, String(source.runs.linux)); assert.equal(record.build.artifactIDs['linux-x64'], String(source.linuxArtifactID));
  assert.deepEqual(Object.keys(record.platforms), ['linux-x64']); assert.match(download.headers['cache-control'], /no-store/);
  const artifact = record.platforms['linux-x64'], sums = await get(record.checksum.url);
  assert.equal(sums.bytes.toString(), linuxChecksums(record)); assert.equal(sums.bytes.length, record.checksum.bytes);
  assert.equal(createHash('sha256').update(sums.bytes).digest('hex'), record.checksum.sha256);
  const release = await api(`releases/${record.release.id}`), tag = await api(`git/ref/tags/${record.release.tag}`);
  assert.equal(release.target_commitish, source.commit); assert.equal(release.tag_name, record.release.tag); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.equal(tag.object.type, 'commit'); assert.equal(tag.object.sha, source.commit); assert.equal(release.assets.length, 2);
  for (const item of [artifact, record.checksum]) {
    const asset = release.assets.find(value => value.name === item.fileName); assert(asset); assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, item.bytes); assert.equal(asset.digest, `sha256:${item.sha256}`);
  }
  report.record = record; report.cacheControl = download.headers['cache-control']; report.releaseURL = release.html_url;
  await save('linux-download.json', record); await save('github-release.json', release); await save('github-release-tag.json', tag);
  if (mode === 'runtime') {
    const proofPath = process.argv[4]; assert.match(proofPath || '', /^public-wsl-[A-Za-z0-9]+\/report\.json$/);
    const info = await lstat(new URL(proofPath, root)); assert(info.isFile() && !info.isSymbolicLink() && info.size < 65536);
    const proof = JSON.parse(await readFile(new URL(proofPath, root), 'utf8'));
    assert(['passed', 'download-runtime-passed-awaiting-website'].includes(proof.status));
    assert(['curl-and-wget-independent-full', 'wget-single-full-after-curl-low-speed', 'windows-public-full-get-wsl-native'].includes(proof.downloadMethod)); assert.equal(proof.release.commit, source.commit);
    const downloadTools = proof.downloadMethod === 'windows-public-full-get-wsl-native' ? ['windows-fetch'] : proof.downloadMethod === 'wget-single-full-after-curl-low-speed' ? ['wget'] : ['curl', 'wget'];
    assert.deepEqual(proof.downloadTools || ['curl', 'wget'], downloadTools);
    if (downloadTools.length === 1) {
      assert.equal(proof.curlCoverage?.status, 'not-completed-low-speed-interrupted'); assert.equal(proof.curlCoverage.passed, false); assert.equal(proof.curlCoverage.partialReused, false);
      assert.match(proof.curlCoverage.interruptionEvidence, /^public-wsl-[A-Za-z0-9]+\/curl-low-speed-interruption\.json$/);
      const interruption = await json(proof.curlCoverage.interruptionEvidence);
      assert.equal(interruption.sourceCommit, source.commit); assert.equal(interruption.curlPassed, false); assert.equal(interruption.partialReusable, false);
    }
    if (downloadTools[0] === 'windows-fetch') {
      assert.match(proof.windowsDownloadEvidence, /^public-wsl-[A-Za-z0-9]+\/windows-download\.json$/);
      const transfer = await json(proof.windowsDownloadEvidence);
      assert.equal(transfer.status, 'public-get-complete-awaiting-wsl-native'); assert.equal(transfer.sourceCommit, source.commit); assert.equal(transfer.sourceTree, source.tree);
      assert.equal(transfer.downloader.platform, 'win32'); assert.equal(transfer.downloader.anonymousPublicGet, true); assert.equal(transfer.downloader.requests, 1);
      assert.equal(transfer.downloader.retries, 0); assert.equal(transfer.downloader.rangeRequested, false); assert.equal(transfer.downloader.partialResumed, false);
      assert.deepEqual(transfer.artifact, artifact); assert.equal(transfer.bytes, artifact.bytes); assert.equal(transfer.sha256, artifact.sha256);
      assert.equal(proof.wgetCoverage?.passed, false); assert.equal(proof.wgetCoverage.status, 'not-completed-low-speed-interrupted');
      assert.equal(proof.checks['windows-fetch-download'].WSLFullCopyHashMatch, true);
    }
    assert.equal(proof.release.version, source.version); assert.equal(proof.release.runID, String(source.runs.linux)); assert.deepEqual(proof.release.artifact, artifact);
    for (const tool of downloadTools) {
      const check = proof.checks[`${tool}-download`]; assert.equal(check.singleCommandCompleteDownload, true);
      assert.equal(check.bytes, artifact.bytes); assert.equal(check.sha256, artifact.sha256); assert.equal(check.checksum, 'passed'); assert.equal(check.extraction, 'passed');
    }
    assert.equal(proof.checks['runtime-integrity'].sourceCommit, source.commit); assert.equal(proof.checks['runtime-integrity'].sourceDirty, false);
    assert.equal(proof.checks['runtime-integrity'].cliVersion, source.version); assert(proof.checks['runtime-integrity'].files > 0);
    assert.equal(proof.checks['app-source-integrity']?.status, 'passed'); assert.equal(proof.checks['app-source-integrity'].sourceCommit, source.commit);
    assert.equal(proof.checks['app-source-integrity'].sourceTree, source.tree); assert.equal(proof.checks['app-source-integrity'].completeGitTreeReconstructed, true);
    assert.equal(proof.checks['app-source-integrity'].pathBytesHashMatch, true);
    for (const tool of downloadTools) {
      assert.equal(proof.checks[`${tool}-extraction-boundary`]?.pathsConfined, true);
      assert.equal(proof.checks[`${tool}-extraction-boundary`].links, 0); assert.equal(proof.checks[`${tool}-extraction-boundary`].specialFiles, 0);
    }
    for (const key of ['engine-provenance', 'node-integrity', 'license-inventory', 'package-dependencies']) assert.equal(proof.checks[key]?.status, 'passed', `Missing new-package verification: ${key}`);
    assert.equal(proof.checks['engine-provenance'].producerSchemaVersion, 2);
    assert.equal(proof.checks['engine-provenance'].completeSourceInventory, true);
    assert.equal(proof.checks['engine-provenance'].receiptVerified, true);
    assert.equal(proof.checks['license-inventory'].completePackageCoverage, true);
    assert.equal(proof.checks['node-integrity'].binaryMatchesOfficialPinnedArchive, true);
    assert.equal(proof.checks['dependency-inventory'].pluginVersion, proof.checks['engine-provenance'].packageVersion);
    assert.equal(proof.checks.startup.dataMode, '0700'); assert.equal(proof.checks.startup.controlMode, '0600'); assert.equal(proof.checks.startup.defaultExecutionDisabled, true);
    assert.equal(proof.checks['restart-sigterm'].identityPreserved, true); assert.equal(proof.checks['restart-sigterm'].firstExit.code, 0); assert.equal(proof.checks['restart-sigterm'].secondExit.code, 0);
    assert.equal(proof.checks['dependency-inventory'].status, 'passed'); assert.equal(proof.checks['dependency-inventory'].schemaVersion, 1);
    assert.equal(proof.checks['dependency-inventory'].completeFileSet, true); assert.equal(proof.checks['dependency-inventory'].pathBytesHashMatch, true);
    assert.equal(proof.checks['dependency-inventory'].exactPluginDeclaration, true); assert.equal(proof.checks['dependency-inventory'].afterRuntimeStopped, true);
    assert(proof.checks['dependency-inventory'].files > 0 && proof.checks['dependency-inventory'].bytes > 0);
    const retainedArtifact = `${proofPath.split('/')[0]}/${artifact.fileName}`, retained = new URL(retainedArtifact, root), archiveInfo = await lstat(retained);
    assert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink()); assert.equal(archiveInfo.size, artifact.bytes); assert.equal(await sha(retained), artifact.sha256);
    report.downloadEvidence = proofPath; report.retainedArtifact = retainedArtifact; report.runtimeFiles = proof.checks['runtime-integrity'].files;
    report.status = 'passed'; report.bytes = artifact.bytes; report.sha256 = artifact.sha256;
    report.downloadMethod = proof.downloadMethod; report.curlCoverage = proof.curlCoverage || { status: 'completed', passed: true };
    report.wgetCoverage = proof.wgetCoverage; report.windowsDownloadEvidence = proof.windowsDownloadEvidence;
    report.scope = proof.scope;
  } else report.status = 'passed-ready-for-public-package-acceptance';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
await save(mode === 'gate' ? 'linux-public-gate.json' : 'linux-public-verification.json', report);
console.log(JSON.stringify({ status: report.status, version: report.version, workflowID, bytes: report.bytes,
  sha256: report.sha256, runtimeFiles: report.runtimeFiles, releaseURL: report.releaseURL, error: report.error }));
