import assert from 'node:assert/strict';
import frozenTargets from './reviewed-targets.json' with { type: 'json' };

// Empty until the actual fresh audit and root object-by-object review.
export const exactReviewedKeys = Object.freeze([...frozenTargets.exactKeys]);
export const currentKeys = ['releases/latest.json', 'updates/stable/latest.json', 'releases/linux/latest.json'];
// The current website emits one canonical x64 alias. English pages use the same
// public package URL; neither English aliases nor ARM64 are published.
export const currentLinuxDownloadAliasURLs = [
  'https://rivloom.com/download/linux-x64',
  'https://rivloom.com/download/linux-arm64',
  'https://rivloom.com/en/download/linux-x64',
  'https://rivloom.com/en/download/linux-arm64',
];
export function assertCurrentLinuxDownloadAlias(observed, currentArtifactURL) {
  assert(currentLinuxDownloadAliasURLs.includes(observed.url), 'Unknown Linux download alias');
  const canonical = observed.url === currentLinuxDownloadAliasURLs[0];
  assert.equal(observed.status, canonical ? 302 : 404, 'Linux download alias status changed');
  assert.equal(observed.location, canonical ? currentArtifactURL : null, 'Linux download alias target changed');
}
const fullCommit = /^(?!0{40}$)[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;

export function validateManifest(manifest, now, frozen = frozenTargets) {
  assert.equal(frozen.status, 'fresh-exact-objects-reviewed');
  assert.equal(frozen.version, '0.1.31');
  assert.equal(frozen.windows.version, '0.1.31');
  assert.equal(frozen.linux.version, '0.1.30');
  assert.equal(frozen.linux.sourceCommit, '4a359ea99380678db66688732fb82672979ff036');
  assert(fullCommit.test(frozen.windows.sourceCommit ?? ''));
  assert(fullCommit.test(frozen.websiteCommit ?? ''));
  assert(digest.test(frozen.policyReportSHA256 ?? ''));
  assert.equal(manifest.releaseSourceCommit, frozen.windows.sourceCommit);
  assert.equal(manifest.websiteCommit, frozen.websiteCommit);
  assert.deepEqual(manifest.expectedPlatforms, { windows: frozen.windows, linux: frozen.linux });
  assert(Array.isArray(frozen.exactKeys) && frozen.exactKeys.length > 0);
  assert.equal(new Set(frozen.exactKeys).size, frozen.exactKeys.length);
  assert.deepEqual(manifest.candidates.map(item => item.key).sort(), [...frozen.exactKeys].sort());
  assert.deepEqual(manifest.candidates, frozen.reviewedObjects);
  assert.equal(manifest.readinessEvidence.policyReportSHA256, frozen.policyReportSHA256);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.reviewReady, true);
  assert.equal(manifest.purpose, 'Rivloom 0.1.31 one-time exact-object R2 retention cleanup');
  assert.equal(manifest.version, '0.1.31'); assert.equal(manifest.bucket, 'rivloom-downloads');
  assert(fullCommit.test(manifest.releaseSourceCommit ?? '')); assert(fullCommit.test(manifest.websiteCommit ?? ''));
  const issued = Date.parse(manifest.issuedAt), expires = Date.parse(manifest.expiresAt);
  assert(Number.isFinite(now) && Number.isFinite(issued) && issued <= now && Number.isFinite(expires) && now < expires);
  assert(expires > issued && expires - issued <= 4 * 3600000, 'Manifest must expire within 4 hours');
  assert.equal(manifest.maximumObjects, frozen.exactKeys.length);
  assert.equal(manifest.readinessEvidence?.status, 'passed'); assert.equal(manifest.readinessEvidence?.version, manifest.version);
  assert.equal(manifest.readinessEvidence?.sourceCommit, manifest.releaseSourceCommit); assert.equal(manifest.readinessEvidence?.websiteCommit, manifest.websiteCommit);
  assert.equal(manifest.readinessEvidence?.windowsPublicDownload, 'passed'); assert.equal(manifest.readinessEvidence?.linuxPublicDownloadAndRuntime, 'passed');
  assert.equal(manifest.readinessEvidence?.linuxVersion, frozen.linux.version);
  assert.equal(manifest.readinessEvidence?.linuxSourceCommit, frozen.linux.sourceCommit);
  assert.equal(manifest.readinessEvidence?.originalUpdaterKeySignature, 'passed'); assert.equal(manifest.readinessEvidence?.websiteProductionAndReviewedScreenshots, 'passed');
  assert.equal(manifest.readinessEvidence?.pagesDeployment, 'passed');
  assert.equal(manifest.reviewedInventory?.sourceCommit, manifest.releaseSourceCommit);
  assert(/^[1-9]\d*$/.test(String(manifest.reviewedInventory?.runID ?? '')));
  assert(Number.isSafeInteger(manifest.reviewedInventory?.attempt) && manifest.reviewedInventory.attempt > 0);
  assert(Number.isSafeInteger(manifest.reviewedInventory?.artifactID) && manifest.reviewedInventory.artifactID > 0);
  assert(digest.test(manifest.reviewedInventory?.objectsSHA256 ?? ''));
  const inventoryAt = Date.parse(manifest.reviewedInventory?.checkedAt);
  assert(Number.isFinite(inventoryAt) && inventoryAt <= issued && issued - inventoryAt <= 3600000);
  assert.deepEqual(Object.keys(manifest.currentPointerSHA256).sort(), currentKeys.slice().sort());
  for (const key of currentKeys) assert(digest.test(manifest.currentPointerSHA256[key] ?? ''));
  assert(Array.isArray(manifest.candidates) && manifest.candidates.length > 0 && manifest.candidates.length === frozen.exactKeys.length);
  const keys = manifest.candidates.map(item => item.key); assert.equal(new Set(keys).size, keys.length);
  for (const candidate of manifest.candidates) {
    assert(frozen.exactKeys.includes(candidate.key), 'Unknown or forbidden deletion key');
    assert(Number.isSafeInteger(candidate.bytes) && candidate.bytes > 0);
    assert(/^"[\x21\x23-\x7e]{1,128}"$/.test(candidate.etag ?? ''));
    assert(Number.isFinite(Date.parse(candidate.lastModified)) && Date.parse(candidate.lastModified) <= now);
    assert(Number.isFinite(Date.parse(candidate.releasePublishedAt)) && Date.parse(candidate.releasePublishedAt) <= now);
    assert(digest.test(candidate.formalAssetSHA256 ?? '')); assert(fullCommit.test(candidate.sourceCommit ?? ''));
    const parsed = /^releases\/(linux\/)?((linux-)?v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([a-f0-9]{12})-([1-9]\d*))\/(.+)$/.exec(candidate.key);
    assert(parsed && Boolean(parsed[1]) === Boolean(parsed[3]), 'Unknown canonical platform path');
    const tag = parsed[2], version = parsed[4], filename = parsed[7];
    assert.equal(candidate.releaseTag, tag); assert(candidate.sourceCommit.startsWith(parsed[5]));
    const packageNames = parsed[1] ? [`Rivloom_${version}_linux_x64.tar.gz`, `Rivloom_${version}_linux_arm64.tar.gz`] : [`Rivloom_${version}_x64-setup.exe`];
    assert(filename === 'SHA256SUMS.txt' || packageNames.includes(filename), 'Only formal package/checksum keys may be deleted');
    assert(now - Date.parse(candidate.releasePublishedAt) > 30 * 24 * 3600000);
    assert(now - Date.parse(candidate.lastModified) > 30 * 24 * 3600000);
    const prefix = candidate.key.slice(0, candidate.key.lastIndexOf('/') + 1);
    assert(keys.includes(prefix + 'SHA256SUMS.txt'), 'Package must include its exact checksum');
    assert(keys.some(key => key.startsWith(prefix) && key !== prefix + 'SHA256SUMS.txt'), 'Checksum requires its reviewed package');
  }
  return true;
}

export function assertReviewedObject(actual, reviewed) {
  for (const property of ['key', 'bytes', 'etag', 'releaseTag', 'releasePublishedAt', 'formalAssetSHA256', 'sourceCommit']) assert.equal(actual[property], reviewed[property], 'Reviewed object changed: ' + property);
  assert.equal(Date.parse(actual.lastModified), Date.parse(reviewed.lastModified), 'Reviewed object last-modified changed');
  assert.equal(actual.decision, 'eligible', 'Fresh policy still protects this object');
}

export function assertLiveHead(head, reviewed) {
  assert.equal(head.status, 200); assert.equal(head.bytes, reviewed.bytes); assert.equal(head.etag, reviewed.etag);
  assert.equal(Date.parse(head.lastModified), Math.floor(Date.parse(reviewed.lastModified) / 1000) * 1000);
  assert.equal(head.sha256, reviewed.formalAssetSHA256, 'R2 digest metadata must equal formal asset digest');
}

// This is the metadata key written and read by the existing release producer.
// A generic sha256 metadata field is not an acceptable substitute.
export const publishedObjectDigestHeader = 'x-amz-meta-rivloom-sha256';
export function readR2HeadContract(response) {
  const value = { status: response.status };
  if (response.status === 200) Object.assign(value, {
    bytes: Number(response.headers.get('content-length')),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    sha256: response.headers.get(publishedObjectDigestHeader),
  });
  return value;
}

export function assertReferenceStability(baselineKeys, currentKeys, deletedKeys) {
  assert.deepEqual([...new Set(currentKeys)].sort(), [...new Set(baselineKeys)].sort(), 'Protected references changed during cleanup');
  for (const key of deletedKeys) assert(!currentKeys.includes(key), 'A deleted object became a current protected reference');
}

export function assertProtectedObjectsExist(protectedKeys, heads) {
  assert.equal(new Set(heads.map(item => item.key)).size, heads.length, 'Duplicate protected object HEAD records');
  for (const key of protectedKeys) {
    const head = heads.find(item => item.key === key);
    assert(head, 'Missing authoritative HEAD for current protected object');
    assert.equal(head.status, 200, 'Current protected object is absent or unavailable in R2');
    assert(Number.isSafeInteger(head.bytes) && head.bytes > 0, 'Current protected object size is invalid');
  }
}

export function deletionAccounting(outcomes) {
  return {
    deleteIntentsRecorded: outcomes.filter(item => item.deleteIntentRecorded === true).length,
    deleteAttemptsStarted: outcomes.filter(item => item.deleteAttemptStarted === true).length,
    deleteResponsesReceived: outcomes.filter(item => Number.isSafeInteger(item.deleteHTTPStatus)).length,
    deleteRequestsAcknowledged: outcomes.filter(item => item.deleteHTTPStatus === 204).length,
    verifiedDeletedObjects: outcomes.filter(item => item.status === 'deleted-and-r2-absence-verified' && item.deleteHTTPStatus === 204 && item.postDeleteR2Head?.status === 404).length,
  };
}
