import assert from 'node:assert/strict';

export const exactLegacyKeys = [
  'releases/v0.1.4-31579065d318-9981226725/Rivloom_0.1.4_x64-setup.exe',
  'releases/v0.1.4-31579065d318-9981226725/SHA256SUMS.txt',
  'releases/v0.1.4-84dfc09fc756-9983464069/Rivloom_0.1.4_x64-setup.exe',
  'releases/v0.1.4-84dfc09fc756-9983464069/SHA256SUMS.txt',
  'releases/v0.1.4-cad78d38a26c-10049753928/Rivloom_0.1.4_x64-setup.exe',
  'releases/v0.1.4-cad78d38a26c-10049753928/SHA256SUMS.txt',
];
export const currentKeys = ['releases/latest.json', 'updates/stable/latest.json', 'releases/linux/latest.json'];
// The 0.1.30 website emits one canonical x64 alias. English pages use the same
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

export function validateManifest(manifest, now) {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.reviewReady, true);
  assert.equal(manifest.purpose, 'Rivloom 0.1.30 one-time exact-object R2 retention cleanup');
  assert.equal(manifest.version, '0.1.30'); assert.equal(manifest.bucket, 'rivloom-downloads');
  assert(fullCommit.test(manifest.releaseSourceCommit ?? '')); assert(fullCommit.test(manifest.websiteCommit ?? ''));
  const issued = Date.parse(manifest.issuedAt), expires = Date.parse(manifest.expiresAt);
  assert(Number.isFinite(now) && Number.isFinite(issued) && issued <= now && Number.isFinite(expires) && now < expires);
  assert(expires > issued && expires - issued <= 24 * 3600000, 'Manifest must expire within 24 hours');
  assert.equal(manifest.maximumObjects, 6);
  assert.equal(manifest.readinessEvidence?.status, 'passed'); assert.equal(manifest.readinessEvidence?.version, manifest.version);
  assert.equal(manifest.readinessEvidence?.sourceCommit, manifest.releaseSourceCommit); assert.equal(manifest.readinessEvidence?.websiteCommit, manifest.websiteCommit);
  assert.equal(manifest.readinessEvidence?.windowsPublicDownload, 'passed'); assert.equal(manifest.readinessEvidence?.linuxPublicDownloadAndRuntime, 'passed');
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
  assert(Array.isArray(manifest.candidates) && manifest.candidates.length > 0 && manifest.candidates.length <= 6);
  const keys = manifest.candidates.map(item => item.key); assert.equal(new Set(keys).size, keys.length);
  for (const candidate of manifest.candidates) {
    assert(exactLegacyKeys.includes(candidate.key), 'Unknown or forbidden deletion key');
    assert(Number.isSafeInteger(candidate.bytes) && candidate.bytes > 0);
    assert(/^"[\x21\x23-\x7e]{1,128}"$/.test(candidate.etag ?? ''));
    assert(Number.isFinite(Date.parse(candidate.lastModified)) && Date.parse(candidate.lastModified) <= now);
    assert(Number.isFinite(Date.parse(candidate.releasePublishedAt)) && Date.parse(candidate.releasePublishedAt) <= now);
    assert(digest.test(candidate.formalAssetSHA256 ?? '')); assert(fullCommit.test(candidate.sourceCommit ?? ''));
    const tag = candidate.key.split('/')[1]; assert.equal(candidate.releaseTag, tag);
    assert(candidate.sourceCommit.startsWith(tag.split('-')[1]));
    const prefix = candidate.key.slice(0, candidate.key.lastIndexOf('/') + 1);
    for (const sibling of exactLegacyKeys.filter(key => key.startsWith(prefix))) assert(keys.includes(sibling), 'Review package and checksum together');
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
