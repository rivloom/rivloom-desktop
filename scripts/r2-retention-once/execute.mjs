// Install only on the reviewed temporary branch under scripts/r2-retention-once/execute.mjs.
// No recurring cleanup, bucket policy, bulk delete, metadata mutation or secret export.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateRetention } from './evaluate-retention.mjs';
import { currentKeys, exactLegacyKeys, validateManifest, assertReviewedObject, assertLiveHead, readR2HeadContract, assertReferenceStability, assertProtectedObjectsExist, deletionAccounting, currentLinuxDownloadAliasURLs, assertCurrentLinuxDownloadAlias } from './guard-delete-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = resolve(process.env.GITHUB_WORKSPACE || '.');
const output = resolve(repository, 'test-results/r2-retention-once');
const manifestBytes = await readFile(new URL('manifest.json', import.meta.url));
const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
const manifestSHA256 = digest(manifestBytes), mode = process.env.RETENTION_MODE;
let stage = 'validate';
const report = { schemaVersion: 1, at: new Date().toISOString(), status: 'validating', mode, manifestSHA256, workflowRunID: process.env.GITHUB_RUN_ID, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT, scriptCommit: process.env.GITHUB_SHA, releaseSourceCommit: manifest.releaseSourceCommit, version: manifest.version, storageMutations: 0, deleted: [], alreadyAbsent: [], deferred: [], perKey: [], automaticCleanup: false, limits: ['R2 DeleteObject conditional If-Match is not claimed; deletion relies on publication mutex and immediately preceding object/reference rechecks. Out-of-band operators must avoid this bucket during execution.', 'A timeout/crash after a DELETE request can leave an uncertain outcome; use the stored per-key result and a fresh inventory, never blind retries.'] };
await mkdir(output, { recursive: true });
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n');
const saveReport = () => {
  Object.assign(report, deletionAccounting(report.perKey));
  // An unverified started attempt has an unknown mutation outcome, not zero.
  report.storageMutations = report.deleteAttemptsStarted > report.verifiedDeletedObjects ? null : report.verifiedDeletedObjects;
  return save('result.json', report);
};
const safeFailure = () => { const accounting = deletionAccounting(report.perKey); report.status = accounting.deleteAttemptsStarted ? 'partial-or-uncertain' : 'failed-before-delete-attempt'; report.failedStage = stage; report.finishedAt = new Date().toISOString(); return saveReport(); };
try {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY, 'rivloom/rivloom-desktop'); assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/r2-retention-0130-20261008');
  assert.match(process.env.EXPECTED_COMMIT || '', /^(?!0{40}$)[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_COMMIT);
  assert.match(process.env.EXPECTED_MANIFEST_SHA256 || '', /^[a-f0-9]{64}$/); assert.equal(manifestSHA256, process.env.EXPECTED_MANIFEST_SHA256);
  assert(['plan', 'delete'].includes(mode)); validateManifest(manifest, Date.now());
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim(), process.env.EXPECTED_COMMIT);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim(), '');
  execFileSync('git', ['merge-base', '--is-ancestor', manifest.releaseSourceCommit, 'HEAD'], { cwd: repository, windowsHide: true, stdio: 'pipe' });
  const sourcePaths = ['scripts/ci-r2-storage.ts', 'scripts/linux-download-record.ts', 'scripts/download-record.ts', 'scripts/updater-manifest.ts', 'src-tauri/updater.pub'];
  const sourceBindings = [];
  for (const path of sourcePaths) {
    const actual = await readFile(resolve(repository, path));
    const formal = execFileSync('git', ['show', manifest.releaseSourceCommit + ':' + path], { cwd: repository, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(actual.toString('utf8').replaceAll('\r\n', '\n'), formal.toString('utf8').replaceAll('\r\n', '\n'));
    sourceBindings.push({ path, actualSHA256: digest(actual), releaseBlobSHA256: digest(formal), sourceMatchesRelease: true });
  }
  await save('source-bindings.json', sourceBindings); await save('manifest.json', manifest);
  if (process.argv[2] === 'validate') { report.status = 'validated-without-storage-credentials'; await saveReport(); console.log(JSON.stringify({ status: report.status, mode, manifestSHA256, candidates: manifest.candidates.length })); process.exit(0); }
  assert.equal(process.argv[2], 'execute');
  const loadSource = path => import(pathToFileURL(resolve(repository, path)).href);
  const { r2Configuration, encodedObjectKey, signS3Request } = await loadSource('scripts/ci-r2-storage.ts');
  const { parseDownloadRecord } = await loadSource('scripts/download-record.ts');
  const { parseLinuxDownloadRecord } = await loadSource('scripts/linux-download-record.ts');
  const { parseSignedUpdate, verifyUpdateArtifact } = await loadSource('scripts/updater-manifest.ts');
  const trustKey = (await readFile(resolve(repository, 'src-tauri/updater.pub'), 'utf8')).trim();
  const storage = r2Configuration(process.env); assert.equal(storage.bucket, 'rivloom-downloads');
  const approvedKeys = new Set(manifest.candidates.map(candidate => candidate.key));
  const request = async (method, key) => {
    assert(['GET', 'HEAD', 'DELETE'].includes(method));
    if (method === 'DELETE') { assert.equal(mode, 'delete'); assert(approvedKeys.has(key) && exactLegacyKeys.includes(key)); }
    const url = new URL(`https://${storage.accountID}.r2.cloudflarestorage.com/${storage.bucket}/${encodedObjectKey(key)}`);
    return fetch(url, { method, redirect: 'error', headers: signS3Request({ url, method, payloadSha256: digest(''), accessKeyID: storage.accessKeyID, secretAccessKey: storage.secretAccessKey, date: new Date(), headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' } }), signal: AbortSignal.timeout(60000) });
  };
  const bounded = async (response, limit) => {
    assert.equal(response.status, 200); const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.byteLength; assert(bytes <= limit); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  };
  const publicGet = url => fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(240000) });
  const github = async path => {
    assert(path.startsWith('repos/rivloom/rivloom-desktop/'));
    const response = await fetch('https://api.github.com/' + path, { redirect: 'error', headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60000) });
    return JSON.parse(await bounded(response, 16 * 1024 * 1024));
  };
  const pagesOf = async path => {
    const all = []; for (let page = 1; ; page++) { assert(page < 100); const entries = await github(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page); assert(Array.isArray(entries)); all.push(...entries); if (entries.length < 100) return all; }
  };
  const noActivePublication = async () => {
    for (const workflow of ['windows-candidate.yml', 'linux-release.yml', 'r2-inventory.yml']) for (const status of ['queued', 'in_progress', 'waiting']) {
      const result = await github(`repos/rivloom/rivloom-desktop/actions/workflows/${workflow}/runs?status=${status}&per_page=100`);
      assert(Array.isArray(result.workflow_runs)); assert.equal(result.total_count, result.workflow_runs.length, 'Active-run listing incomplete');
      assert(result.workflow_runs.every(run => String(run.id) === process.env.GITHUB_RUN_ID), 'Concurrent publication or inventory must finish first');
    }
  };
  const head = async key => {
    const response = await request('HEAD', key); const value = readR2HeadContract(response);
    await response.body?.cancel(); return value;
  };
  const verifyProtectedHeads = async state => {
    const heads = [];
    for (const key of state.protectedKeys) heads.push({ key, ...await head(key) });
    assertProtectedObjectsExist(state.protectedKeys, heads); return heads;
  };
  const readState = async () => {
    const pointerBytes = {};
    for (const key of currentKeys) {
      const raw = await bounded(await request('GET', key), 65536); assert.equal(digest(raw), manifest.currentPointerSHA256[key], 'Reviewed current pointer changed');
      const publicRaw = await bounded(await publicGet('https://downloads.rivloom.com/' + key), 65536); assert(raw.equals(publicRaw), 'Public pointer differs from authoritative R2'); pointerBytes[key] = raw;
    }
    const windows = parseDownloadRecord(JSON.parse(pointerBytes['releases/latest.json']));
    const linux = parseLinuxDownloadRecord(JSON.parse(pointerBytes['releases/linux/latest.json']));
    const signed = JSON.parse(pointerBytes['updates/stable/latest.json']), update = parseSignedUpdate(signed, trustKey);
    for (const record of [windows, linux]) { assert.equal(record.version, manifest.version); assert.equal(record.source.commit, manifest.releaseSourceCommit); }
    assert.equal(update.metadata.version, manifest.version); assert.equal(update.metadata.url, windows.artifact.url); assert.equal(update.metadata.sha256, windows.artifact.sha256); assert.equal(update.metadata.bytes, windows.artifact.bytes);
    const protectedKeys = new Set(currentKeys), pages = [], aliases = [];
    const protect = url => { const parsed = new URL(url); assert.equal(parsed.origin, 'https://downloads.rivloom.com'); assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash); protectedKeys.add(decodeURIComponent(parsed.pathname.slice(1))); };
    for (const file of [windows.artifact, windows.checksum, ...Object.values(linux.platforms), linux.checksum]) protect(file.url);
    for (const prefix of ['', '/en']) for (const suffix of ['/', '/download/', '/guide/', '/changelog/', '/how-it-works/', '/security/', '/privacy/', '/support/']) {
      const url = 'https://rivloom.com' + prefix + suffix, html = (await bounded(await publicGet(url), 2 * 1024 * 1024)).toString('utf8');
      if (suffix === '/download/' || suffix === '/') { assert(html.includes(windows.artifact.url)); assert(html.includes(linux.platforms['linux-x64'].url)); }
      const references = [...new Set([...html.matchAll(/https:\/\/downloads\.rivloom\.com\/[^\s"'<>`]+/g)].map(match => match[0].replace(/(?:&#(?:x[0-9a-f]+|\d+);|&apos;|&quot;).*$/i, '').replaceAll('&amp;', '&')))];
      references.forEach(protect); pages.push({ url, bytes: Buffer.byteLength(html), sha256: digest(html), references });
    }
    for (const url of currentLinuxDownloadAliasURLs) {
      const response = await fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60000) });
      const observed = { url, status: response.status, location: response.headers.get('location') };
      assertCurrentLinuxDownloadAlias(observed, linux.platforms['linux-x64'].url);
      aliases.push(observed); await response.body?.cancel();
    }
    const releases = await pagesOf('repos/rivloom/rivloom-desktop/releases');
    for (const record of [windows, linux]) { const formal = releases.find(release => release.tag_name === record.release.tag); assert(formal && !formal.draft && !formal.prerelease); assert.equal(formal.id, record.release.id); assert.equal(formal.published_at, record.release.publishedAt); assert.equal(formal.target_commitish, manifest.releaseSourceCommit); }
    return { at: new Date().toISOString(), windows, linux, signed, protectedKeys: [...protectedKeys], pages, aliases, releases };
  };
  stage = 'publication-mutex-precheck'; await noActivePublication();
  stage = 'fresh-authoritative-inventory';
  const rawInventory = execFileSync('aws', ['s3api', 'list-objects-v2', '--bucket', storage.bucket, '--endpoint-url', `https://${storage.accountID}.r2.cloudflarestorage.com`, '--output', 'json'], { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_ACCESS_KEY_ID: storage.accessKeyID, AWS_SECRET_ACCESS_KEY: storage.secretAccessKey, AWS_DEFAULT_REGION: 'auto', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '' } });
  const inventory = JSON.parse(rawInventory.replace(/^\uFEFF/, '')); assert(!inventory.IsTruncated && !inventory.NextToken && !inventory.NextContinuationToken); assert(Array.isArray(inventory.Contents));
  await save('fresh-inventory.json', { at: new Date().toISOString(), sourceCommit: manifest.releaseSourceCommit, manifestSHA256, readOnly: true, inventory });
  stage = 'fresh-pointers-public-site-and-formal-release-policy';
  const baseline = await readState(); await save('state-before.json', baseline);
  const plan = evaluateRetention({ inventory: inventory.Contents, releases: baseline.releases, protectedKeys: baseline.protectedKeys, evaluatedAt: baseline.at });
  await save('policy-plan.json', plan);
  const ready = [];
  stage = 'reviewed-exact-object-heads';
  for (const reviewed of manifest.candidates) {
    const actual = plan.objects.find(object => object.key === reviewed.key);
    if (!actual) { const missing = await head(reviewed.key); assert.equal(missing.status, 404); report.alreadyAbsent.push(reviewed.key); report.perKey.push({ key: reviewed.key, status: 'already-absent-before-this-run', deleteIntentRecorded: false, deleteAttemptStarted: false }); continue; }
    assertReviewedObject(actual, reviewed); const current = await head(reviewed.key);
    const outcome = { key: reviewed.key, status: 'checking-reviewed-object-head', deleteIntentRecorded: false, deleteAttemptStarted: false, preDeleteHead: current };
    report.perKey.push(outcome); await saveReport();
    try { assertLiveHead(current, reviewed); }
    catch {
      outcome.status = 'deferred-before-delete-attempt';
      outcome.deferReason = current.sha256 === null || current.sha256 === undefined
        ? 'Missing producer x-amz-meta-rivloom-sha256 metadata: preserve; do not substitute another metadata field'
        : 'Authoritative object HEAD differs from reviewed size/ETag/time/formal SHA256: preserve';
      await saveReport(); throw new Error('Reviewed object HEAD failed');
    }
    ready.push(reviewed); outcome.status = 'validated-awaiting-mode';
  }
  await saveReport();
  if (mode === 'delete') for (const reviewed of ready.sort((a, b) => Number(a.key.endsWith('SHA256SUMS.txt')) - Number(b.key.endsWith('SHA256SUMS.txt')))) {
    stage = 'immediate-pre-delete-policy-and-object-recheck'; validateManifest(manifest, Date.now()); await noActivePublication();
    const state = await readState(); assertReferenceStability(baseline.protectedKeys, state.protectedKeys, report.deleted);
    const freshPlan = evaluateRetention({ inventory: inventory.Contents, releases: state.releases, protectedKeys: state.protectedKeys, evaluatedAt: state.at });
    assertReviewedObject(freshPlan.objects.find(object => object.key === reviewed.key), reviewed); assertLiveHead(await head(reviewed.key), reviewed);
    const outcome = report.perKey.find(item => item.key === reviewed.key); outcome.status = 'delete-intent-recorded'; outcome.deleteIntentRecorded = true; outcome.intentAt = new Date().toISOString(); await saveReport();
    stage = 'exact-delete-attempt'; outcome.status = 'delete-attempt-started'; outcome.deleteAttemptStarted = true; outcome.attemptStartedAt = new Date().toISOString(); await saveReport();
    const response = await request('DELETE', reviewed.key); outcome.deleteHTTPStatus = response.status; outcome.responseReceivedAt = new Date().toISOString(); await saveReport(); await response.body?.cancel(); assert.equal(response.status, 204);
    stage = 'authoritative-deletion-verification'; const after = await head(reviewed.key); outcome.postDeleteR2Head = after; assert.equal(after.status, 404);
    outcome.status = 'deleted-and-r2-absence-verified'; outcome.finishedAt = new Date().toISOString(); report.deleted.push(reviewed.key); await saveReport();
  }
  stage = 'post-operation-public-and-signature-recheck';
  const finalState = await readState(); assertReferenceStability(baseline.protectedKeys, finalState.protectedKeys, report.deleted);
  const initialProtectedHeads = await verifyProtectedHeads(finalState); await save('state-after.json', { ...finalState, authoritativeProtectedHeads: initialProtectedHeads });
  const publicDownloads = [];
  for (const file of [finalState.windows.artifact, finalState.windows.checksum, ...Object.values(finalState.linux.platforms), finalState.linux.checksum]) {
    const response = await publicGet(file.url); assert.equal(response.status, 200); const hash = createHash('sha256'); let bytes = 0; const windowsParts = [];
    for await (const chunk of response.body) { bytes += chunk.byteLength; assert(bytes <= file.bytes); hash.update(chunk); if (file.url === finalState.windows.artifact.url) windowsParts.push(Buffer.from(chunk)); }
    assert.equal(bytes, file.bytes); assert.equal(hash.digest('hex'), file.sha256);
    if (file.url === finalState.windows.artifact.url) verifyUpdateArtifact(Buffer.concat(windowsParts), parseSignedUpdate(finalState.signed, trustKey).metadata, trustKey);
    publicDownloads.push({ url: file.url, bytes, sha256: file.sha256, completePublicGET: true, originalKeyArtifactSignature: file.url === finalState.windows.artifact.url ? 'passed' : null });
  }
  stage = 'final-protected-reference-and-authoritative-existence-verification';
  const closingState = await readState(); assertReferenceStability(baseline.protectedKeys, closingState.protectedKeys, report.deleted);
  const closingProtectedHeads = await verifyProtectedHeads(closingState);
  await save('state-after-final.json', { ...closingState, authoritativeProtectedHeads: closingProtectedHeads });
  await save('public-recheck.json', { at: new Date().toISOString(), status: 'passed', pointersUnchanged: true, protectedReferenceSetUnchanged: true, deletedIntersectCurrentReferences: false, allCurrentProtectedObjectsExistInR2: true, authoritativeProtectedHeads: closingProtectedHeads, originalKeySignature: 'passed', websitePages: closingState.pages.length, aliases: closingState.aliases, completeDownloads: publicDownloads });
  if (mode === 'plan') { report.status = 'read-only-plan-passed'; for (const item of report.perKey) if (item.status === 'validated-awaiting-mode') item.status = 'eligible-reviewed-no-delete-request'; }
  else report.status = 'completed';
  report.finishedAt = new Date().toISOString(); report.publicRecheck = 'passed'; report.counts = { planned: manifest.candidates.length, deletedThisRun: report.deleted.length, alreadyAbsent: report.alreadyAbsent.length, deferred: report.deferred.length }; await saveReport();
  console.log(JSON.stringify({ status: report.status, mode, counts: report.counts, storageMutations: report.storageMutations, manifestSHA256 }));
} catch {
  for (const candidate of manifest.candidates || []) if (!report.deleted.includes(candidate.key) && !report.alreadyAbsent.includes(candidate.key)) report.deferred.push({ key: candidate.key, reason: 'Execution stopped at ' + stage + '; retained or outcome requires fresh audit' });
  await safeFailure(); console.log(JSON.stringify({ status: report.status, failedStage: stage, storageMutations: report.storageMutations, deletedVerified: report.deleted.length, deferred: report.deferred.length })); process.exitCode = 1;
}
