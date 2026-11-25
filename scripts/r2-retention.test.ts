import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ciRoot } from './ci-workspace.ts';
import { DOWNLOAD_ORIGIN, parseDownloadRecord, type DownloadRecord } from './download-record.ts';
import { parseLinuxDownloadRecord, type LinuxDownloadRecord } from './linux-download-record.ts';
import {
  applyR2RetentionPlan,
  compareSemver,
  computeRetentionManifestSha256,
  extractDownloadKeysFromText,
  parseUtcTimestamp,
  planR2Retention,
  renderRetentionAuditMarkdown,
  RETENTION_WINDOW_MS,
  verifyPublicDownloadsAndUpdater,
  type GitHubReleaseRecord,
  type LiveRetentionSnapshot,
  type PublicEntryInputs,
  type R2InventoryDocument,
  type R2InventoryObject,
} from './r2-retention.ts';
import { parseCliArgs } from './r2-retention-cli.ts';
import { parseSignedUpdate, type UpdateManifest, type UpdateMetadata } from './updater-manifest.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T12:00:00.000Z');
const isoAgo = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Generate a real synthetic Ed25519/Minisign keypair for updater verification tests (zero mocks).
function createSyntheticMinisignKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyID = Buffer.from('0102030405060708', 'hex');
  const pubPayload = Buffer.concat([Buffer.from('Ed'), keyID, rawPub]).toString('base64');
  const minisignPublicKey = Buffer.from(
    `untrusted comment: synthetic test public key\n${pubPayload}\n`,
    'utf8',
  ).toString('base64');

  const signBytes = (bytes: Buffer) => {
    const fileSig = sign(null, bytes, privateKey);
    const sigLine = Buffer.concat([Buffer.from('Ed'), keyID, fileSig]).toString('base64');
    const trustedComment = 'timestamp:1764072000\tfile:synthetic';
    const globalSig = sign(
      null,
      Buffer.concat([fileSig, Buffer.from(trustedComment, 'utf8')]),
      privateKey,
    ).toString('base64');
    return Buffer.from(
      `untrusted comment: synthetic sig\n${sigLine}\ntrusted comment: ${trustedComment}\n${globalSig}\n`,
      'utf8',
    ).toString('base64');
  };
  return { publicKey: minisignPublicKey, signBytes };
}

const syntheticSigner = createSyntheticMinisignKeypair();

interface BuiltWindowsRelease {
  version: string;
  tag: string;
  commit: string;
  runID: string;
  artifactID: string;
  exeKey: string;
  sumsKey: string;
  exeBytes: Buffer;
  sumsBytes: Buffer;
  publishedAt: string;
  release: GitHubReleaseRecord;
  downloadRecord: DownloadRecord;
  updater: { manifest: UpdateManifest; metadata: UpdateMetadata };
  objects: R2InventoryObject[];
}

function makeWindowsRelease(options: {
  version: string;
  publishedAt: string;
  lastModified?: string;
  commitChar?: string;
  artifactID?: string;
  releaseID?: number;
  draft?: boolean;
  prerelease?: boolean;
  etagSuffix?: string;
}): BuiltWindowsRelease {
  const commit = (options.commitChar ?? 'a').repeat(40);
  const artifactID = options.artifactID ?? String(10000 + (options.releaseID ?? 1));
  const runID = String(20000 + (options.releaseID ?? 1));
  const tag = `v${options.version}-${commit.slice(0, 12)}-${artifactID}`;
  const exeName = `Rivloom_${options.version}_x64-setup.exe`;
  const exeBytes = Buffer.from(`synthetic-windows-exe-${tag}`);
  const exeSha = sha(exeBytes.toString('utf8'));
  const sumsBytes = Buffer.from(`${exeSha}  ${exeName}\n`, 'utf8');
  const sumsSha = sha(sumsBytes.toString('utf8'));
  const exeKey = `releases/${tag}/${exeName}`;
  const sumsKey = `releases/${tag}/SHA256SUMS.txt`;
  const lastModified = options.lastModified ?? options.publishedAt;
  const suffix = options.etagSuffix ?? tag;

  const release: GitHubReleaseRecord = {
    id: options.releaseID ?? 1,
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: options.publishedAt,
    target_commitish: commit,
    assets: [
      { name: exeName, size: exeBytes.length, digest: `sha256:${exeSha}`, state: 'uploaded' },
      { name: 'SHA256SUMS.txt', size: sumsBytes.length, digest: `sha256:${sumsSha}`, state: 'uploaded' },
    ],
  };

  const downloadRecord = parseDownloadRecord({
    schemaVersion: 1,
    kind: 'rivloom-download',
    status: 'published',
    version: options.version,
    product: { kind: 'desktop', identifier: 'com.rivloom.desktop' },
    source: { commit },
    build: { runID, artifactID },
    release: { id: release.id, tag, publishedAt: options.publishedAt },
    artifact: {
      fileName: exeName,
      bytes: exeBytes.length,
      sha256: exeSha,
      url: `${DOWNLOAD_ORIGIN}/${exeKey}`,
    },
    checksum: {
      fileName: 'SHA256SUMS.txt',
      bytes: sumsBytes.length,
      sha256: sumsSha,
      url: `${DOWNLOAD_ORIGIN}/${sumsKey}`,
    },
    signing: { authenticode: 'unsigned', tauriUpdater: 'not-configured' },
    verification: {
      ci: 'passed',
      installation: 'passed',
      publicDownload: 'passed',
      checkedAt: options.publishedAt,
    },
  });

  const artifactSignature = syntheticSigner.signBytes(exeBytes);
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    product: 'com.rivloom.desktop',
    version: options.version,
    publishedAt: options.publishedAt,
    notes: `Synthetic release ${options.version}`,
    url: `${DOWNLOAD_ORIGIN}/${exeKey}`,
    signature: artifactSignature,
    bytes: exeBytes.length,
    sha256: exeSha,
  };
  const payloadBuffer = Buffer.from(JSON.stringify(metadata) + '\n', 'utf8');
  const metadataSignature = syntheticSigner.signBytes(payloadBuffer);
  const manifest: UpdateManifest = {
    version: options.version,
    notes: metadata.notes,
    pub_date: options.publishedAt,
    platforms: { 'windows-x86_64': { url: metadata.url, signature: artifactSignature } },
    rivloom: { payload: payloadBuffer.toString('base64'), signature: metadataSignature },
  };
  const updater = parseSignedUpdate(manifest, syntheticSigner.publicKey);

  return {
    version: options.version,
    tag,
    commit,
    runID,
    artifactID,
    exeKey,
    sumsKey,
    exeBytes,
    sumsBytes,
    publishedAt: options.publishedAt,
    release,
    downloadRecord,
    updater,
    objects: [
      { Key: exeKey, Size: exeBytes.length, LastModified: lastModified, ETag: `"exe-${suffix}"` },
      { Key: sumsKey, Size: sumsBytes.length, LastModified: lastModified, ETag: `"sum-${suffix}"` },
    ],
  };
}

interface BuiltLinuxRelease {
  version: string;
  tag: string;
  tarKey: string;
  sumsKey: string;
  tarBytes: Buffer;
  sumsBytes: Buffer;
  publishedAt: string;
  release: GitHubReleaseRecord;
  downloadRecord: LinuxDownloadRecord;
  objects: R2InventoryObject[];
}

function makeLinuxRelease(options: {
  version: string;
  publishedAt: string;
  lastModified?: string;
  commitChar?: string;
  runID?: string;
  releaseID?: number;
}): BuiltLinuxRelease {
  const commit = (options.commitChar ?? 'b').repeat(40);
  const runID = options.runID ?? String(30000 + (options.releaseID ?? 1));
  const artifactID = String(40000 + (options.releaseID ?? 1));
  const tag = `linux-v${options.version}-${commit.slice(0, 12)}-${runID}`;
  const tarName = `Rivloom_${options.version}_linux_x64.tar.gz`;
  const tarBytes = Buffer.from(`synthetic-linux-tar-${tag}`);
  const tarSha = sha(tarBytes.toString('utf8'));
  const sumsBytes = Buffer.from(`${tarSha}  ${tarName}\n`, 'utf8');
  const sumsSha = sha(sumsBytes.toString('utf8'));
  const tarKey = `releases/linux/${tag}/${tarName}`;
  const sumsKey = `releases/linux/${tag}/SHA256SUMS.txt`;
  const lastModified = options.lastModified ?? options.publishedAt;

  const release: GitHubReleaseRecord = {
    id: options.releaseID ?? 501,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: options.publishedAt,
    target_commitish: commit,
    assets: [
      { name: tarName, size: tarBytes.length, digest: `sha256:${tarSha}`, state: 'uploaded' },
      { name: 'SHA256SUMS.txt', size: sumsBytes.length, digest: `sha256:${sumsSha}`, state: 'uploaded' },
    ],
  };

  const downloadRecord = parseLinuxDownloadRecord({
    schemaVersion: 1,
    kind: 'rivloom-linux-download',
    status: 'published',
    version: options.version,
    product: { kind: 'headless', identifier: 'com.rivloom.headless' },
    source: { commit },
    build: { runID, artifactIDs: { 'linux-x64': artifactID } },
    release: { id: release.id, tag, publishedAt: options.publishedAt },
    platforms: {
      'linux-x64': {
        fileName: tarName,
        bytes: tarBytes.length,
        sha256: tarSha,
        url: `${DOWNLOAD_ORIGIN}/${tarKey}`,
      },
    },
    checksum: {
      fileName: 'SHA256SUMS.txt',
      bytes: sumsBytes.length,
      sha256: sumsSha,
      url: `${DOWNLOAD_ORIGIN}/${sumsKey}`,
    },
    verification: {
      ci: 'passed',
      startup: 'passed',
      publicDownload: 'passed',
      checkedAt: options.publishedAt,
    },
  });

  return {
    version: options.version,
    tag,
    tarKey,
    sumsKey,
    tarBytes,
    sumsBytes,
    publishedAt: options.publishedAt,
    release,
    downloadRecord,
    objects: [
      { Key: tarKey, Size: tarBytes.length, LastModified: lastModified, ETag: `"tar-${tag}"` },
      { Key: sumsKey, Size: sumsBytes.length, LastModified: lastModified, ETag: `"lsum-${tag}"` },
    ],
  };
}

function pointerObjects(winVersion: string): R2InventoryObject[] {
  const ts = isoAgo(DAY_MS);
  return [
    { Key: 'releases/latest.json', Size: 1200, LastModified: ts, ETag: '"win-latest"' },
    { Key: 'releases/linux/latest.json', Size: 1200, LastModified: ts, ETag: '"linux-latest"' },
    { Key: 'updates/stable/latest.json', Size: 900, LastModified: ts, ETag: '"upd-latest"' },
    { Key: `updates/stable/${winVersion}.json`, Size: 900, LastModified: ts, ETag: `"upd-${winVersion}"` },
    { Key: 'audits/0.1.31-r2-retention.md', Size: 4200, LastModified: isoAgo(45 * DAY_MS), ETag: '"audit-31"' },
  ];
}

test('fewer than 3 versions per platform keeps everything and reports zero deletions', () => {
  const w1 = makeWindowsRelease({ version: '0.1.1', publishedAt: isoAgo(90 * DAY_MS), releaseID: 1 });
  const w2 = makeWindowsRelease({ version: '0.1.2', publishedAt: isoAgo(60 * DAY_MS), releaseID: 2 });
  const l1 = makeLinuxRelease({ version: '0.1.1', publishedAt: isoAgo(80 * DAY_MS), releaseID: 101 });

  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [...pointerObjects('0.1.2'), ...w1.objects, ...w2.objects, ...l1.objects],
    },
    releases: [w1.release, w2.release, l1.release],
    entries: {
      windowsDownload: w2.downloadRecord,
      updaterManifest: w2.updater,
      linuxDownload: l1.downloadRecord,
      websiteReferences: [w2.downloadRecord.artifact.url, l1.downloadRecord.platforms['linux-x64'].url],
    },
    metadata: { triggerVersion: '0.1.2' },
  });

  assert.equal(plan.counts.deleteCandidate, 0);
  assert.equal(plan.counts.defer, 0);
  assert.equal(plan.counts.keep, plan.counts.total);
  assert.deepEqual(plan.protectedSummary.windowsRecentVersions, ['0.1.2', '0.1.1']);
  assert.deepEqual(plan.protectedSummary.linuxRecentVersions, ['0.1.1']);

  const markdown = renderRetentionAuditMarkdown(plan);
  assert.match(markdown, /检查完成，删除 0 个/);
  assert.match(markdown, /已提供只读计划与受控人工执行工具，尚未启用无人值守自动清理/);
});

test('exact 30-day UTC boundary keeps at <= 30d, deletes at 30d+1ms, and defers recently modified old objects', () => {
  const wExact30 = makeWindowsRelease({
    version: '0.1.6',
    publishedAt: isoAgo(RETENTION_WINDOW_MS),
    releaseID: 6,
  });
  const wPast30 = makeWindowsRelease({
    version: '0.1.5',
    publishedAt: isoAgo(RETENTION_WINDOW_MS + 1),
    releaseID: 5,
  });
  const wReuploaded = makeWindowsRelease({
    version: '0.1.4',
    publishedAt: isoAgo(45 * DAY_MS),
    lastModified: isoAgo(5 * DAY_MS),
    releaseID: 4,
  });
  const w7 = makeWindowsRelease({ version: '0.1.7', publishedAt: isoAgo(10 * DAY_MS), releaseID: 7 });
  const w8 = makeWindowsRelease({ version: '0.1.8', publishedAt: isoAgo(5 * DAY_MS), releaseID: 8 });
  const w9 = makeWindowsRelease({ version: '0.1.9', publishedAt: isoAgo(2 * DAY_MS), releaseID: 9 });
  const w10 = makeWindowsRelease({ version: '0.1.10', publishedAt: isoAgo(1 * DAY_MS), releaseID: 10 });
  const l1 = makeLinuxRelease({ version: '0.1.10', publishedAt: isoAgo(2 * DAY_MS), releaseID: 110 });

  assert.equal(compareSemver('0.1.10', '0.1.9'), 1);

  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [
        ...pointerObjects('0.1.10'),
        ...wReuploaded.objects,
        ...wPast30.objects,
        ...wExact30.objects,
        ...w7.objects,
        ...w8.objects,
        ...w9.objects,
        ...w10.objects,
        ...l1.objects,
      ],
    },
    releases: [
      wReuploaded.release,
      wPast30.release,
      wExact30.release,
      w7.release,
      w8.release,
      w9.release,
      w10.release,
      l1.release,
    ],
    entries: {
      windowsDownload: w10.downloadRecord,
      updaterManifest: w10.updater,
      linuxDownload: l1.downloadRecord,
      websiteReferences: [w10.downloadRecord.artifact.url, l1.downloadRecord.platforms['linux-x64'].url],
    },
  });

  // Canonical SemVer top 3 must be 0.1.10, 0.1.9, 0.1.8 (NOT lexicographical 0.1.9, 0.1.8, 0.1.7).
  assert.deepEqual(plan.protectedSummary.windowsRecentVersions, ['0.1.10', '0.1.9', '0.1.8']);

  const byKey = new Map(plan.decisions.map((item) => [item.key, item]));
  assert.equal(byKey.get(wExact30.exeKey)?.decision, 'keep');
  assert.equal(byKey.get(wExact30.sumsKey)?.decision, 'keep');
  assert.equal(byKey.get(wPast30.exeKey)?.decision, 'delete-candidate');
  assert.equal(byKey.get(wPast30.sumsKey)?.decision, 'delete-candidate');
  assert.equal(byKey.get(wReuploaded.exeKey)?.decision, 'defer');
  assert.equal(byKey.get(wReuploaded.sumsKey)?.decision, 'defer');
  assert.deepEqual(
    plan.candidates.map((c) => c.key),
    [wPast30.exeKey, wPast30.sumsKey].sort(),
  );
});

test('stale top 3 versions older than 30 days remain kept, including multi-build versions and independent Linux top 3', () => {
  // All releases are 120–200 days old; Windows has 5 versions (with 2 builds for 0.1.33), Linux has 4 versions.
  const w30 = makeWindowsRelease({ version: '0.1.30', publishedAt: isoAgo(200 * DAY_MS), releaseID: 30 });
  const w31 = makeWindowsRelease({ version: '0.1.31', publishedAt: isoAgo(180 * DAY_MS), releaseID: 31 });
  const w32 = makeWindowsRelease({ version: '0.1.32', publishedAt: isoAgo(160 * DAY_MS), releaseID: 32 });
  const w33a = makeWindowsRelease({ version: '0.1.33', publishedAt: isoAgo(140 * DAY_MS), artifactID: '10331', releaseID: 331 });
  const w33b = makeWindowsRelease({ version: '0.1.33', publishedAt: isoAgo(139 * DAY_MS), artifactID: '10332', releaseID: 332 });
  const w34 = makeWindowsRelease({ version: '0.1.34', publishedAt: isoAgo(120 * DAY_MS), releaseID: 34 });

  // Linux stayed on older versions while Windows shipped ahead; Linux top 3 must NOT be evicted by Windows.
  const l26 = makeLinuxRelease({ version: '0.1.26', publishedAt: isoAgo(210 * DAY_MS), releaseID: 126 });
  const l27 = makeLinuxRelease({ version: '0.1.27', publishedAt: isoAgo(190 * DAY_MS), releaseID: 127 });
  const l28 = makeLinuxRelease({ version: '0.1.28', publishedAt: isoAgo(170 * DAY_MS), releaseID: 128 });
  const l29 = makeLinuxRelease({ version: '0.1.29', publishedAt: isoAgo(150 * DAY_MS), releaseID: 129 });

  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [
        ...pointerObjects('0.1.34'),
        ...w30.objects,
        ...w31.objects,
        ...w32.objects,
        ...w33a.objects,
        ...w33b.objects,
        ...w34.objects,
        ...l26.objects,
        ...l27.objects,
        ...l28.objects,
        ...l29.objects,
      ],
    },
    releases: [
      w30.release,
      w31.release,
      w32.release,
      w33a.release,
      w33b.release,
      w34.release,
      l26.release,
      l27.release,
      l28.release,
      l29.release,
    ],
    entries: {
      windowsDownload: w34.downloadRecord,
      updaterManifest: w34.updater,
      linuxDownload: l29.downloadRecord,
      websiteReferences: [w34.downloadRecord.artifact.url, l29.downloadRecord.platforms['linux-x64'].url],
    },
  });

  assert.deepEqual(plan.protectedSummary.windowsRecentVersions, ['0.1.34', '0.1.33', '0.1.32']);
  assert.deepEqual(plan.protectedSummary.linuxRecentVersions, ['0.1.29', '0.1.28', '0.1.27']);

  const byKey = new Map(plan.decisions.map((item) => [item.key, item]));
  for (const kept of [w34, w33a, w33b, w32]) {
    assert.equal(byKey.get(kept.exeKey)?.decision, 'keep');
    assert.equal(byKey.get(kept.sumsKey)?.decision, 'keep');
  }
  for (const keptLinux of [l29, l28, l27]) {
    assert.equal(byKey.get(keptLinux.tarKey)?.decision, 'keep');
    assert.equal(byKey.get(keptLinux.sumsKey)?.decision, 'keep');
  }
  assert.deepEqual(
    plan.candidates.map((c) => c.key),
    [...w30.objects, ...w31.objects, ...l26.objects].map((o) => o.Key).sort(),
  );
});

test('current entries protect versions outside top 3 even when multiple entries point to different versions', () => {
  const w20 = makeWindowsRelease({ version: '0.1.20', publishedAt: isoAgo(150 * DAY_MS), releaseID: 20 });
  const w21 = makeWindowsRelease({ version: '0.1.21', publishedAt: isoAgo(140 * DAY_MS), releaseID: 21 });
  const w22 = makeWindowsRelease({ version: '0.1.22', publishedAt: isoAgo(130 * DAY_MS), releaseID: 22 });
  const w23 = makeWindowsRelease({ version: '0.1.23', publishedAt: isoAgo(120 * DAY_MS), releaseID: 23 });
  const w32 = makeWindowsRelease({ version: '0.1.32', publishedAt: isoAgo(50 * DAY_MS), releaseID: 32 });
  const w33 = makeWindowsRelease({ version: '0.1.33', publishedAt: isoAgo(45 * DAY_MS), releaseID: 33 });
  const w34 = makeWindowsRelease({ version: '0.1.34', publishedAt: isoAgo(40 * DAY_MS), releaseID: 34 });

  const l20 = makeLinuxRelease({ version: '0.1.20', publishedAt: isoAgo(150 * DAY_MS), releaseID: 120 });
  const l28 = makeLinuxRelease({ version: '0.1.28', publishedAt: isoAgo(50 * DAY_MS), releaseID: 128 });
  const l29 = makeLinuxRelease({ version: '0.1.29', publishedAt: isoAgo(45 * DAY_MS), releaseID: 129 });
  const l30 = makeLinuxRelease({ version: '0.1.30', publishedAt: isoAgo(40 * DAY_MS), releaseID: 130 });

  // Divergent live entries:
  // - releases/latest.json -> w21 (outside top 3!)
  // - updates/stable/latest.json -> w22 (outside top 3!)
  // - website download HTML -> w23 (outside top 3!) & l20 (outside Linux top 3!)
  // - releases/linux/latest.json -> l30
  const websiteHtml = `<a href="${w23.downloadRecord.artifact.url}">Win</a><a href="${l20.downloadRecord.platforms['linux-x64'].url}">Linux</a>`;
  const extractedRefs = extractDownloadKeysFromText(websiteHtml);
  assert.deepEqual(extractedRefs, [l20.tarKey, w23.exeKey].sort());

  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [
        ...pointerObjects('0.1.22'),
        ...w20.objects,
        ...w21.objects,
        ...w22.objects,
        ...w23.objects,
        ...w32.objects,
        ...w33.objects,
        ...w34.objects,
        ...l20.objects,
        ...l28.objects,
        ...l29.objects,
        ...l30.objects,
      ],
    },
    releases: [
      w20.release,
      w21.release,
      w22.release,
      w23.release,
      w32.release,
      w33.release,
      w34.release,
      l20.release,
      l28.release,
      l29.release,
      l30.release,
    ],
    entries: {
      windowsDownload: w21.downloadRecord,
      updaterManifest: w22.updater,
      linuxDownload: l30.downloadRecord,
      websiteReferences: extractedRefs,
    },
  });

  const byKey = new Map(plan.decisions.map((item) => [item.key, item]));
  for (const protectedWin of [w21, w22, w23, w32, w33, w34]) {
    assert.equal(byKey.get(protectedWin.exeKey)?.decision, 'keep', `Expected ${protectedWin.version} exe kept`);
    assert.equal(byKey.get(protectedWin.sumsKey)?.decision, 'keep', `Expected ${protectedWin.version} sums kept`);
  }
  assert.equal(byKey.get(l20.tarKey)?.decision, 'keep');
  assert.equal(byKey.get(l20.sumsKey)?.decision, 'keep');
  // Only w20 is outside top 3, > 30d, and unreferenced by every entry.
  assert.deepEqual(
    plan.candidates.map((c) => c.key),
    [w20.exeKey, w20.sumsKey].sort(),
  );
});

test('unknown paths, anomalous timestamps, incomplete release metadata and truncated inventories are preserved/rejected safely', () => {
  const w32 = makeWindowsRelease({ version: '0.1.32', publishedAt: isoAgo(50 * DAY_MS), releaseID: 32 });
  const w33 = makeWindowsRelease({ version: '0.1.33', publishedAt: isoAgo(45 * DAY_MS), releaseID: 33 });
  const w34 = makeWindowsRelease({ version: '0.1.34', publishedAt: isoAgo(40 * DAY_MS), releaseID: 34 });
  const l30 = makeLinuxRelease({ version: '0.1.30', publishedAt: isoAgo(40 * DAY_MS), releaseID: 130 });

  // Draft release, future release timestamp, missing assets, size mismatch, unrecorded upload, unknown paths.
  const wDraft = makeWindowsRelease({ version: '0.1.10', publishedAt: isoAgo(90 * DAY_MS), draft: true, releaseID: 10 });
  const wFuture = makeWindowsRelease({ version: '0.1.11', publishedAt: isoAgo(-5 * DAY_MS), lastModified: isoAgo(90 * DAY_MS), releaseID: 11 });
  const wBadSize = makeWindowsRelease({ version: '0.1.12', publishedAt: isoAgo(90 * DAY_MS), releaseID: 12 });
  wBadSize.objects[0] = { ...wBadSize.objects[0], Size: wBadSize.objects[0].Size + 99 };
  const wBadMod = makeWindowsRelease({ version: '0.1.13', publishedAt: isoAgo(90 * DAY_MS), releaseID: 13 });
  wBadMod.objects[0] = { ...wBadMod.objects[0], LastModified: 'not-a-date' };
  const wOrphan = makeWindowsRelease({ version: '0.1.14', publishedAt: isoAgo(90 * DAY_MS), releaseID: 14 });
  const unknownObjects: R2InventoryObject[] = [
    { Key: 'previews/0.1.3/Rivloom_0.1.3_x64-setup.exe', Size: 1000, LastModified: isoAgo(120 * DAY_MS) },
    { Key: 'releases/v0.1.9-aaaaaaaaaaaa-1009/Rivloom_0.1.8_x64-setup.exe', Size: 1000, LastModified: isoAgo(120 * DAY_MS) },
    { Key: 'misc/notes.txt', Size: 42, LastModified: isoAgo(120 * DAY_MS) },
  ];

  const entries: PublicEntryInputs = {
    windowsDownload: w34.downloadRecord,
    updaterManifest: w34.updater,
    linuxDownload: l30.downloadRecord,
    websiteReferences: [w34.downloadRecord.artifact.url, l30.downloadRecord.platforms['linux-x64'].url],
  };

  // Truncated inventory must be rejected hard before computing any candidate.
  assert.throws(
    () =>
      planR2Retention({
        now: NOW,
        inventory: { IsTruncated: true, NextToken: 'tok-1', Contents: [] },
        releases: [w34.release, l30.release],
        entries,
      }),
    /incomplete-inventory/,
  );

  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [
        ...pointerObjects('0.1.34'),
        ...w32.objects,
        ...w33.objects,
        ...w34.objects,
        ...l30.objects,
        ...wDraft.objects,
        ...wFuture.objects,
        ...wBadSize.objects,
        ...wBadMod.objects,
        ...wOrphan.objects,
        ...unknownObjects,
      ],
    },
    // Omit wOrphan.release intentionally to simulate in-progress upload or missing GitHub Release.
    releases: [w32.release, w33.release, w34.release, l30.release, wDraft.release, wFuture.release, wBadSize.release, wBadMod.release],
    entries,
  });

  const byKey = new Map(plan.decisions.map((item) => [item.key, item]));
  for (const deferredKey of [
    wDraft.exeKey,
    wDraft.sumsKey,
    wFuture.exeKey,
    wFuture.sumsKey,
    wBadSize.exeKey,
    wBadMod.exeKey,
    wOrphan.exeKey,
    wOrphan.sumsKey,
    ...unknownObjects.map((o) => o.Key),
  ]) {
    assert.equal(byKey.get(deferredKey)?.decision, 'defer', `Expected ${deferredKey} to defer`);
  }
  // Only the intact checksums of wBadSize and wBadMod (which matched assets & old timestamps) are candidates; none of the anomalous/unknown objects are candidates.
  for (const candidate of plan.candidates) {
    assert(!unknownObjects.some((o) => o.Key === candidate.key));
    assert.notEqual(candidate.key, wDraft.exeKey);
    assert.notEqual(candidate.key, wFuture.exeKey);
    assert.notEqual(candidate.key, wBadSize.exeKey);
    assert.notEqual(candidate.key, wBadMod.exeKey);
    assert.notEqual(candidate.key, wOrphan.exeKey);
  }
});

test('controlled apply enforces explicit approval, digest, expiry, idempotency, concurrency mutex, live drift and partial failure without touching pointers', async () => {
  const w10 = makeWindowsRelease({ version: '0.1.10', publishedAt: isoAgo(90 * DAY_MS), releaseID: 10 });
  const w11 = makeWindowsRelease({ version: '0.1.11', publishedAt: isoAgo(85 * DAY_MS), releaseID: 11 });
  const w32 = makeWindowsRelease({ version: '0.1.32', publishedAt: isoAgo(50 * DAY_MS), releaseID: 32 });
  const w33 = makeWindowsRelease({ version: '0.1.33', publishedAt: isoAgo(45 * DAY_MS), releaseID: 33 });
  const w34 = makeWindowsRelease({ version: '0.1.34', publishedAt: isoAgo(40 * DAY_MS), releaseID: 34 });
  const l30 = makeLinuxRelease({ version: '0.1.30', publishedAt: isoAgo(40 * DAY_MS), releaseID: 130 });

  const entries: PublicEntryInputs = {
    windowsDownload: w34.downloadRecord,
    updaterManifest: w34.updater,
    linuxDownload: l30.downloadRecord,
    websiteReferences: [w34.downloadRecord.artifact.url, l30.downloadRecord.platforms['linux-x64'].url],
  };
  const allReleases = [w10.release, w11.release, w32.release, w33.release, w34.release, l30.release];
  const plan = planR2Retention({
    now: NOW,
    inventory: {
      IsTruncated: false,
      Contents: [
        ...pointerObjects('0.1.34'),
        ...w10.objects,
        ...w11.objects,
        ...w32.objects,
        ...w33.objects,
        ...w34.objects,
        ...l30.objects,
      ],
    },
    releases: allReleases,
    entries,
  });
  assert.equal(plan.candidates.length, 4);

  // In-memory R2 store + public CDN read simulator.
  const store = new Map<string, { body: Buffer; etag: string; lastModified: string }>();
  const seed = (key: string, body: Buffer, etag: string, lastModified: string) =>
    store.set(key, { body, etag, lastModified });
  seed('releases/latest.json', Buffer.from(JSON.stringify(w34.downloadRecord)), '"win-latest"', isoAgo(DAY_MS));
  seed('releases/linux/latest.json', Buffer.from(JSON.stringify(l30.downloadRecord)), '"linux-latest"', isoAgo(DAY_MS));
  seed('updates/stable/latest.json', Buffer.from(JSON.stringify(w34.updater.manifest)), '"upd-latest"', isoAgo(DAY_MS));
  for (const w of [w10, w11, w32, w33, w34]) {
    seed(w.exeKey, w.exeBytes, w.objects[0].ETag!, w.objects[0].LastModified);
    seed(w.sumsKey, w.sumsBytes, w.objects[1].ETag!, w.objects[1].LastModified);
  }
  seed(l30.tarKey, l30.tarBytes, l30.objects[0].ETag!, l30.objects[0].LastModified);
  seed(l30.sumsKey, l30.sumsBytes, l30.objects[1].ETag!, l30.objects[1].LastModified);

  let failDeleteKey: string | null = null;
  let pointerMutations = 0;
  const storage = async (request: { method: string; key: string }) => {
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      ['releases/latest.json', 'releases/linux/latest.json', 'updates/stable/latest.json'].includes(request.key)
    ) {
      pointerMutations += 1;
      throw new Error('Pointers must never be mutated by retention cleanup');
    }
    const item = store.get(request.key);
    if (request.method === 'HEAD') {
      if (!item) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(item.body.length),
          etag: item.etag,
          'last-modified': new Date(item.lastModified).toUTCString(),
        },
      });
    }
    if (request.method === 'DELETE') {
      if (failDeleteKey === request.key) return new Response(null, { status: 500 });
      if (!item) return new Response(null, { status: 404 });
      store.delete(request.key);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected method ${request.method}`);
  };
  const publicRead = async (key: string) => {
    const item = store.get(key);
    if (!item) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(item.body), {
      status: 200,
      headers: { 'content-length': String(item.body.length) },
    });
  };
  const liveSnapshot = (): LiveRetentionSnapshot => ({ entries, releases: allReleases });
  const verifyPostDelete = (deletedKeys: readonly string[], live: LiveRetentionSnapshot) =>
    verifyPublicDownloadsAndUpdater({
      live,
      deletedKeys,
      updaterPublicKey: syntheticSigner.publicKey,
      publicRead,
      verifyFullBytes: true,
    });

  // 1. Refuse without explicit approval, wrong digest, tampered plan, or expired manifest.
  await assert.rejects(
    () =>
      applyR2RetentionPlan({
        plan,
        approvedManifestSha256: plan.manifestSha256,
        explicitApproval: false,
        now: () => NOW,
        services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
      }),
    /explicit-approval-required/,
  );
  await assert.rejects(
    () =>
      applyR2RetentionPlan({
        plan,
        approvedManifestSha256: '0'.repeat(64),
        explicitApproval: true,
        now: () => NOW,
        services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
      }),
    /manifest-digest-mismatch/,
  );
  await assert.rejects(
    () =>
      applyR2RetentionPlan({
        plan: { ...plan, candidates: plan.candidates.slice(0, 1) },
        approvedManifestSha256: plan.manifestSha256,
        explicitApproval: true,
        now: () => NOW,
        services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
      }),
    /manifest-digest-mismatch/,
  );
  await assert.rejects(
    () =>
      applyR2RetentionPlan({
        plan,
        approvedManifestSha256: plan.manifestSha256,
        explicitApproval: true,
        now: () => new Date(Date.parse(plan.expiresAt) + 1000),
        services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
      }),
    /manifest-expired/,
  );

  // 2. Concurrent publication mutex blocks execution before any DELETE.
  await assert.rejects(
    () =>
      applyR2RetentionPlan({
        plan,
        approvedManifestSha256: plan.manifestSha256,
        explicitApproval: true,
        now: () => NOW,
        services: {
          storage,
          acquireLock: async () => {
            throw new Error('public-rivloom-download lock held by active release');
          },
          loadLiveState: async () => liveSnapshot(),
          verifyPostDelete,
        },
      }),
    /concurrent-publication-active/,
  );
  assert.equal(store.has(w10.exeKey), true);

  // 3. Live pointer drift between plan and apply aborts safely with 0 deletions.
  const driftedResult = await applyR2RetentionPlan({
    plan,
    approvedManifestSha256: plan.manifestSha256,
    explicitApproval: true,
    now: () => NOW,
    services: {
      storage,
      loadLiveState: async () => ({
        entries: { ...entries, windowsDownload: w33.downloadRecord },
        releases: allReleases,
      }),
      verifyPostDelete,
    },
  });
  assert.equal(driftedResult.status, 'aborted-stale-state');
  assert.equal(driftedResult.counts.deleted, 0);
  assert.equal(driftedResult.counts.deferred, 4);
  assert.equal(store.has(w10.exeKey), true);

  // 4. Partial delete failure: fail one key, succeed on remaining 3, pointers untouched, post-delete verification passes.
  failDeleteKey = w11.exeKey;
  const partialResult = await applyR2RetentionPlan({
    plan,
    approvedManifestSha256: plan.manifestSha256,
    explicitApproval: true,
    now: () => NOW,
    services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
  });
  assert.equal(partialResult.status, 'partial-failure');
  assert.equal(partialResult.counts.deleted, 3);
  assert.equal(partialResult.counts.failed, 1);
  assert.equal(partialResult.pointersUntouched, true);
  assert.equal(pointerMutations, 0);
  assert.equal(partialResult.postDeleteVerification?.passed, true);
  assert.equal(partialResult.postDeleteVerification?.updaterSignature, true);
  assert.equal(store.has(w11.exeKey), true);
  assert.equal(store.has(w10.exeKey), false);

  // 5. Repeat execution after fixing failure is idempotent: already deleted keys become already-absent, remaining 1 deletes cleanly.
  failDeleteKey = null;
  const retryResult = await applyR2RetentionPlan({
    plan,
    approvedManifestSha256: plan.manifestSha256,
    explicitApproval: true,
    now: () => NOW,
    services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
  });
  assert.equal(retryResult.status, 'completed');
  assert.equal(retryResult.counts.alreadyAbsent, 3);
  assert.equal(retryResult.counts.deleted, 1);
  assert.equal(retryResult.counts.failed, 0);
  assert.equal(retryResult.postDeleteVerification?.passed, true);

  // 6. Third repeat execution: all 4 already-absent, 0 errors, idempotent completed.
  const idempotentResult = await applyR2RetentionPlan({
    plan,
    approvedManifestSha256: plan.manifestSha256,
    explicitApproval: true,
    now: () => NOW,
    services: { storage, loadLiveState: async () => liveSnapshot(), verifyPostDelete },
  });
  assert.equal(idempotentResult.status, 'completed');
  assert.equal(idempotentResult.counts.alreadyAbsent, 4);
  assert.equal(idempotentResult.counts.deleted, 0);
  assert.equal(pointerMutations, 0);

  const reportMd = renderRetentionAuditMarkdown(plan, retryResult);
  assert.match(reportMd, /实际删除 1 个/);
  assert.match(reportMd, /pointersUntouched=true/);
  assert.match(reportMd, /删除后公开入口复核：通过/);
});

test('CLI defaults to read-only plan mode and generates verified manifest.json + audit.md offline', () => {
  const parsedDefault = parseCliArgs(['--inventory', 'objects.json']);
  assert.equal(parsedDefault.mode, 'plan');
  assert.equal(parsedDefault.approveDelete, false);

  const base = join(ciRoot, 'test-results');
  mkdirSync(base, { recursive: true });
  const tempDir = mkdtempSync(join(base, 'r2-retention-cli-'));

  const w34 = makeWindowsRelease({ version: '0.1.34', publishedAt: isoAgo(5 * DAY_MS), releaseID: 34 });
  const l30 = makeLinuxRelease({ version: '0.1.30', publishedAt: isoAgo(10 * DAY_MS), releaseID: 130 });
  const inventoryDoc: R2InventoryDocument = {
    IsTruncated: false,
    Contents: [...pointerObjects('0.1.34'), ...w34.objects, ...l30.objects],
  };

  const inventoryPath = join(tempDir, 'objects.json');
  const releasesPath = join(tempDir, 'releases.json');
  const winLatestPath = join(tempDir, 'win-latest.json');
  const linuxLatestPath = join(tempDir, 'linux-latest.json');
  const updaterLatestPath = join(tempDir, 'updater-latest.json');
  const websiteRefsPath = join(tempDir, 'website-refs.json');
  const pubKeyPath = join(tempDir, 'updater.pub');
  const outDir = join(tempDir, 'out');

  writeFileSync(inventoryPath, JSON.stringify(inventoryDoc));
  writeFileSync(releasesPath, JSON.stringify([w34.release, l30.release]));
  writeFileSync(winLatestPath, JSON.stringify(w34.downloadRecord));
  writeFileSync(linuxLatestPath, JSON.stringify(l30.downloadRecord));
  writeFileSync(updaterLatestPath, JSON.stringify(w34.updater.manifest));
  writeFileSync(
    websiteRefsPath,
    JSON.stringify([w34.downloadRecord.artifact.url, l30.downloadRecord.platforms['linux-x64'].url]),
  );
  writeFileSync(pubKeyPath, syntheticSigner.publicKey);

  const run = spawnSync(
    process.execPath,
    [
      join(ciRoot, 'scripts/r2-retention-cli.ts'),
      '--inventory',
      inventoryPath,
      '--releases',
      releasesPath,
      '--windows-latest',
      winLatestPath,
      '--linux-latest',
      linuxLatestPath,
      '--updater-latest',
      updaterLatestPath,
      '--website-refs',
      websiteRefsPath,
      '--updater-pub-key',
      pubKeyPath,
      '--now',
      NOW.toISOString(),
      '--trigger-version',
      '0.1.34',
      '--out-dir',
      outDir,
    ],
    { cwd: ciRoot, encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  const auditMd = readFileSync(join(outDir, 'audit.md'), 'utf8');
  assert.equal(manifest.readOnly, true);
  assert.equal(manifest.counts.deleteCandidate, 0);
  assert.equal(manifest.manifestSha256, computeRetentionManifestSha256(manifest));
  assert.match(auditMd, /检查完成，删除 0 个/);
});

test('parseUtcTimestamp accepts ISO-8601 and RFC-7231 GMT Last-Modified headers while rejecting invalid dates', () => {
  assert.equal(parseUtcTimestamp('2026-09-21T17:30:51.238Z'), Date.parse('2026-09-21T17:30:51.238Z'));
  assert.equal(parseUtcTimestamp('2026-09-21T17:30:51.238000+00:00'), Date.parse('2026-09-21T17:30:51.238Z'));
  // Cloudflare R2 S3 HEAD returns RFC-7231 GMT headers containing "T" in "GMT".
  assert.equal(parseUtcTimestamp('Mon, 21 Sep 2026 17:30:51 GMT'), Date.parse('2026-09-21T17:30:51Z'));
  assert.equal(parseUtcTimestamp('Fri, 18 Sep 2026 14:49:13 GMT'), Date.parse('2026-09-18T14:49:13Z'));
  assert.equal(parseUtcTimestamp('2026-02-30T00:00:00Z'), null);
  assert.equal(parseUtcTimestamp('Mon, 31 Feb 2026 17:30:51 GMT'), null);
  assert.equal(parseUtcTimestamp('Tue, 21 Sep 2026 17:30:51 GMT'), null);
});
