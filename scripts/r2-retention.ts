// Pure R2 retention audit, controlled cleanup manifest generation, Markdown report rendering,
// and explicit-approval cleanup execution. Never enables unattended bucket expiration or deletion.
import { createHash } from 'node:crypto';
import {
  deletableReleaseObjectKey,
  discard,
  strongEtag,
  type ObjectTransport,
} from './ci-r2-storage.ts';
import { DOWNLOAD_ORIGIN, parseDownloadRecord, type DownloadRecord } from './download-record.ts';
import {
  availableLinuxPlatforms,
  parseLinuxDownloadRecord,
  type LinuxDownloadRecord,
} from './linux-download-record.ts';
import {
  parseSignedUpdate,
  type UpdateManifest,
  type UpdateMetadata,
} from './updater-manifest.ts';

export const RETENTION_WINDOW_HOURS = 30 * 24;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_HOURS * 60 * 60 * 1000;
export const RECENT_VERSIONS_PER_PLATFORM = 3;
export const DEFAULT_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MANIFEST_TTL_MS = 72 * 60 * 60 * 1000;

export type ReleasePlatform = 'windows' | 'linux';
export type RetentionDecision = 'keep' | 'delete-candidate' | 'defer';
export type ObjectCategory = 'metadata' | 'audit' | 'release-package' | 'release-checksum' | 'unknown';

export interface R2InventoryObject {
  Key: string;
  Size: number;
  LastModified: string;
  ETag?: string;
}

export interface R2InventoryDocument {
  Contents?: R2InventoryObject[];
  IsTruncated?: boolean;
  NextToken?: string;
  KeyCount?: number;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  digest?: string | null;
  state?: string;
}

export interface GitHubReleaseRecord {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  target_commitish?: string;
  assets?: GitHubReleaseAsset[];
}

export interface PublicEntryInputs {
  windowsDownload: DownloadRecord;
  updaterManifest: { manifest: UpdateManifest; metadata: UpdateMetadata };
  linuxDownload: LinuxDownloadRecord;
  websiteReferences: readonly string[];
}

export interface RetentionPlanMetadata {
  sourceCommit?: string;
  inventoryRunID?: string;
  triggerVersion?: string;
  websiteCommit?: string;
  manifestTtlMs?: number;
}

export interface RetentionPlanInput {
  inventory: R2InventoryDocument;
  releases: readonly GitHubReleaseRecord[];
  entries: PublicEntryInputs;
  now: Date | string;
  metadata?: RetentionPlanMetadata;
}

export interface RetentionObjectDecision {
  key: string;
  bytes: number | null;
  lastModified: string | null;
  etag: string | null;
  category: ObjectCategory;
  platform: ReleasePlatform | null;
  version: string | null;
  releaseTag: string | null;
  publishedAt: string | null;
  decision: RetentionDecision;
  reasons: string[];
}

export interface RetentionDeleteCandidate {
  key: string;
  bytes: number;
  lastModified: string;
  etag: string | null;
  platform: ReleasePlatform;
  version: string;
  releaseTag: string;
  publishedAt: string;
  expectedSha256: string | null;
}

export interface RetentionProtectedSummary {
  windowsRecentVersions: string[];
  linuxRecentVersions: string[];
  windowsCurrentVersion: string;
  updaterCurrentVersion: string;
  linuxCurrentVersion: string;
  currentEntryKeys: string[];
  websiteReferenceKeys: string[];
}

export interface R2RetentionPlan {
  schemaVersion: 1;
  kind: 'rivloom-r2-retention-plan';
  mode: 'plan';
  readOnly: true;
  generatedAt: string;
  expiresAt: string;
  sourceCommit: string | null;
  inventoryRunID: string | null;
  triggerVersion: string | null;
  websiteCommit: string | null;
  policy: {
    recentVersionsPerPlatform: number;
    retentionWindowHours: number;
    unionRule: true;
    autoCleanupEnabled: false;
  };
  protectedSummary: RetentionProtectedSummary;
  counts: {
    total: number;
    keep: number;
    defer: number;
    deleteCandidate: number;
    totalBytes: number;
    deleteCandidateBytes: number;
  };
  candidates: RetentionDeleteCandidate[];
  decisions: RetentionObjectDecision[];
  manifestSha256: string;
}

export interface RetentionApplyItem {
  key: string;
  bytes: number;
  status: 'deleted' | 'already-absent' | 'deferred' | 'failed';
  reason: string;
  httpStatus?: number;
}

export interface PostDeleteVerificationResult {
  passed: boolean;
  windowsPublicDownload: boolean;
  linuxPublicDownload: boolean;
  updaterSignature: boolean;
  deletedKeysDisjointFromLive: boolean;
  details: string[];
}

export interface R2RetentionApplyResult {
  schemaVersion: 1;
  kind: 'rivloom-r2-retention-apply';
  mode: 'apply';
  status: 'completed' | 'partial-failure' | 'aborted-stale-state' | 'failed';
  executedAt: string;
  manifestSha256: string;
  pointersUntouched: true;
  autoCleanupEnabled: false;
  error?: string;
  counts: {
    planned: number;
    deleted: number;
    alreadyAbsent: number;
    deferred: number;
    failed: number;
    deletedBytes: number;
  };
  items: RetentionApplyItem[];
  postDeleteVerification: PostDeleteVerificationResult | null;
}

export interface LiveRetentionSnapshot {
  entries: PublicEntryInputs;
  releases?: readonly GitHubReleaseRecord[];
}

export interface RetentionApplyServices {
  storage: ObjectTransport;
  loadLiveState: () => Promise<LiveRetentionSnapshot>;
  acquireLock?: () => Promise<() => Promise<void> | void>;
  verifyPostDelete: (deletedKeys: readonly string[], live: LiveRetentionSnapshot) => Promise<PostDeleteVerificationResult>;
}

export interface RetentionApplyInput {
  plan: R2RetentionPlan;
  approvedManifestSha256: string;
  explicitApproval: boolean;
  now?: () => Date;
  services: RetentionApplyServices;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const windowsTagPattern = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{12})-([1-9]\d{0,15})$/;
const linuxTagPattern = /^linux-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{12})-([1-9]\d{0,15})$/;
const windowsObjectPattern =
  /^releases\/(v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{12})-([1-9]\d{0,15}))\/(Rivloom_((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))_x64-setup\.exe|SHA256SUMS\.txt)$/;
const linuxObjectPattern =
  /^releases\/linux\/(linux-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{12})-([1-9]\d{0,15}))\/(Rivloom_((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))_linux_(x64|arm64)\.tar\.gz|SHA256SUMS\.txt)$/;
const permanentMetadataPattern =
  /^(?:releases\/(?:latest\.json|linux\/latest\.json)|updates\/stable\/(?:latest|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.json)$/;
const auditRecordPattern =
  /^(?:audit|audits|retention)\/(?!.*\.\.)[0-9A-Za-z._/-]{1,200}\.(?:json|md)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class RetentionPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
  }
}

export function compareSemver(left: string, right: string): number {
  if (!semverPattern.test(left) || !semverPattern.test(right)) {
    throw new RetentionPolicyError('invalid-semver', `Expected canonical SemVer, got "${left}" vs "${right}"`);
  }
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] > rightParts[i] ? 1 : -1;
  }
  return 0;
}

export function parseUtcTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const isIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(trimmed);
  const isHttpDate = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed);
  if (!isIso && !isHttpDate) {
    return null;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const check = new Date(ms);
  if (isIso) {
    const isoDate = trimmed.slice(0, 10);
    if (check.toISOString().slice(0, 10) !== isoDate) return null;
  } else if (check.toUTCString() !== trimmed) {
    return null;
  }
  return ms;
}

export function normalizeDownloadReferenceToKey(reference: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(`${DOWNLOAD_ORIGIN}/`)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.origin !== DOWNLOAD_ORIGIN || url.search || url.hash) return null;
    const rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rawPath || rawPath.includes('..') || rawPath.includes('\\')) return null;
    return rawPath;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) return null;
  const key = trimmed.replace(/^\/+/, '');
  if (!key || key.includes('..') || key.includes('\\') || /[?#\s]/.test(key)) return null;
  return key;
}

export function extractDownloadKeysFromText(content: string): string[] {
  const originEscaped = DOWNLOAD_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${originEscaped}/[A-Za-z0-9._%+~/-]+`, 'g');
  const keys = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const cleaned = match[0].replace(/[),.;'"`]+$/, '');
    const key = normalizeDownloadReferenceToKey(cleaned);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

function siblingChecksumKey(key: string): string | null {
  const win = windowsObjectPattern.exec(key);
  if (win) return `releases/${win[1]}/SHA256SUMS.txt`;
  const linux = linuxObjectPattern.exec(key);
  if (linux) return `releases/linux/${linux[1]}/SHA256SUMS.txt`;
  return null;
}

function parseReleaseObjectKey(key: string): {
  category: 'release-package' | 'release-checksum';
  platform: ReleasePlatform;
  tag: string;
  version: string;
  fileName: string;
  versionConsistent: boolean;
} | null {
  const win = windowsObjectPattern.exec(key);
  if (win) {
    const tag = win[1];
    const tagVersion = win[2];
    const fileName = win[5];
    const fileVersion = win[6];
    const isChecksum = fileName === 'SHA256SUMS.txt';
    return {
      category: isChecksum ? 'release-checksum' : 'release-package',
      platform: 'windows',
      tag,
      version: tagVersion,
      fileName,
      versionConsistent: isChecksum || fileVersion === tagVersion,
    };
  }
  const linux = linuxObjectPattern.exec(key);
  if (linux) {
    const tag = linux[1];
    const tagVersion = linux[2];
    const fileName = linux[5];
    const fileVersion = linux[6];
    const isChecksum = fileName === 'SHA256SUMS.txt';
    return {
      category: isChecksum ? 'release-checksum' : 'release-package',
      platform: 'linux',
      tag,
      version: tagVersion,
      fileName,
      versionConsistent: isChecksum || fileVersion === tagVersion,
    };
  }
  return null;
}

function parseOfficialReleaseTag(tag: string): { platform: ReleasePlatform; version: string } | null {
  const win = windowsTagPattern.exec(tag);
  if (win) return { platform: 'windows', version: win[1] };
  const linux = linuxTagPattern.exec(tag);
  if (linux) return { platform: 'linux', version: linux[1] };
  return null;
}

function normalizeEtag(etag: unknown): string | null {
  if (typeof etag !== 'string' || !etag.trim()) return null;
  const trimmed = etag.trim();
  const quoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `"${trimmed}"`;
  try {
    return strongEtag(quoted);
  } catch {
    return null;
  }
}

export function buildProtectedEntryMap(entries: PublicEntryInputs): {
  byKey: Map<string, string[]>;
  websiteReferenceKeys: string[];
  windowsCurrentVersion: string;
  updaterCurrentVersion: string;
  linuxCurrentVersion: string;
} {
  // Validate the structured Windows and Linux download records strictly.
  const winRecord = parseDownloadRecord(entries.windowsDownload);
  const linuxRecord = parseLinuxDownloadRecord(entries.linuxDownload);
  const updaterMeta = entries.updaterManifest?.metadata;
  const updaterPlatform = entries.updaterManifest?.manifest?.platforms?.['windows-x86_64'];
  if (
    !updaterMeta ||
    !updaterPlatform ||
    typeof updaterMeta.url !== 'string' ||
    !semverPattern.test(updaterMeta.version) ||
    updaterPlatform.url !== updaterMeta.url ||
    entries.updaterManifest.manifest.version !== updaterMeta.version
  ) {
    throw new RetentionPolicyError('invalid-updater-entry', 'Updater manifest metadata is missing or invalid');
  }

  const byKey = new Map<string, Set<string>>();
  const protect = (key: string | null, source: string) => {
    if (!key) throw new RetentionPolicyError('invalid-entry-reference', `Unrecognized protected reference from ${source}`);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(source);
    const sibling = siblingChecksumKey(key);
    if (sibling) {
      if (!byKey.has(sibling)) byKey.set(sibling, new Set());
      byKey.get(sibling)!.add(`${source}（配套校验文件）`);
    }
  };

  protect('releases/latest.json', 'releases/latest.json');
  protect(normalizeDownloadReferenceToKey(winRecord.artifact.url), 'releases/latest.json');
  protect(normalizeDownloadReferenceToKey(winRecord.checksum.url), 'releases/latest.json');

  protect('updates/stable/latest.json', 'updates/stable/latest.json');
  protect(`updates/stable/${updaterMeta.version}.json`, 'updates/stable/latest.json');
  protect(normalizeDownloadReferenceToKey(updaterMeta.url), 'updates/stable/latest.json');

  protect('releases/linux/latest.json', 'releases/linux/latest.json');
  for (const platform of availableLinuxPlatforms(linuxRecord)) {
    protect(normalizeDownloadReferenceToKey(linuxRecord.platforms[platform]!.url), 'releases/linux/latest.json');
  }
  protect(normalizeDownloadReferenceToKey(linuxRecord.checksum.url), 'releases/linux/latest.json');

  const websiteKeys = new Set<string>();
  for (const rawRef of entries.websiteReferences) {
    const key = normalizeDownloadReferenceToKey(rawRef);
    if (!key) {
      throw new RetentionPolicyError('invalid-website-reference', `Cannot resolve website reference "${rawRef}"`);
    }
    websiteKeys.add(key);
    protect(key, '官网下载页 / CLI 入口');
  }

  return {
    byKey: new Map([...byKey.entries()].map(([k, v]) => [k, [...v].sort()])),
    websiteReferenceKeys: [...websiteKeys].sort(),
    windowsCurrentVersion: winRecord.version,
    updaterCurrentVersion: updaterMeta.version,
    linuxCurrentVersion: linuxRecord.version,
  };
}

export function computeRetentionManifestSha256(
  plan: Pick<R2RetentionPlan, 'schemaVersion' | 'kind' | 'generatedAt' | 'expiresAt' | 'protectedSummary' | 'candidates'>,
): string {
  const canonical = JSON.stringify({
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    generatedAt: plan.generatedAt,
    expiresAt: plan.expiresAt,
    protectedSummary: plan.protectedSummary,
    candidates: plan.candidates,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function planR2Retention(input: RetentionPlanInput): R2RetentionPlan {
  const nowDate = input.now instanceof Date ? input.now : new Date(input.now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RetentionPolicyError('invalid-now-timestamp', 'Evaluation timestamp is invalid');
  }
  const generatedAt = nowDate.toISOString();

  const ttlMs = input.metadata?.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_MANIFEST_TTL_MS) {
    throw new RetentionPolicyError('invalid-manifest-ttl', 'Manifest TTL must be between 1ms and 72h');
  }
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  if (!input.inventory || typeof input.inventory !== 'object') {
    throw new RetentionPolicyError('invalid-inventory', 'R2 inventory document is missing');
  }
  if (input.inventory.IsTruncated === true || Boolean(input.inventory.NextToken)) {
    throw new RetentionPolicyError('incomplete-inventory', 'R2 object inventory is truncated; refusing to evaluate');
  }
  if (!Array.isArray(input.inventory.Contents)) {
    throw new RetentionPolicyError('invalid-inventory', 'R2 inventory Contents must be an array');
  }

  const protectedEntries = buildProtectedEntryMap(input.entries);

  // Index published official releases (excluding drafts and prereleases) and compute independent top-3 SemVer per platform.
  const releasesByTag = new Map<string, GitHubReleaseRecord>();
  const officialVersions: Record<ReleasePlatform, Set<string>> = {
    windows: new Set(),
    linux: new Set(),
  };
  for (const release of input.releases) {
    if (!release || typeof release.tag_name !== 'string') continue;
    if (release.draft || release.prerelease) continue;
    const parsedTag = parseOfficialReleaseTag(release.tag_name);
    if (!parsedTag) continue;
    if (releasesByTag.has(release.tag_name)) {
      throw new RetentionPolicyError('duplicate-release-tag', `Duplicate release tag: ${release.tag_name}`);
    }
    releasesByTag.set(release.tag_name, release);
    officialVersions[parsedTag.platform].add(parsedTag.version);
  }

  const top3Windows = [...officialVersions.windows]
    .sort((a, b) => compareSemver(b, a))
    .slice(0, RECENT_VERSIONS_PER_PLATFORM);
  const top3Linux = [...officialVersions.linux]
    .sort((a, b) => compareSemver(b, a))
    .slice(0, RECENT_VERSIONS_PER_PLATFORM);
  const top3Sets: Record<ReleasePlatform, Set<string>> = {
    windows: new Set(top3Windows),
    linux: new Set(top3Linux),
  };

  const seenKeys = new Set<string>();
  const sortedObjects = [...input.inventory.Contents].sort((a, b) =>
    String(a?.Key ?? '').localeCompare(String(b?.Key ?? '')),
  );

  const decisions: RetentionObjectDecision[] = [];
  const candidates: RetentionDeleteCandidate[] = [];
  let totalBytes = 0;

  for (const item of sortedObjects) {
    const key = typeof item?.Key === 'string' ? item.Key : '';
    if (!key) {
      throw new RetentionPolicyError('invalid-inventory-key', 'Inventory contains an object without a valid Key');
    }
    if (seenKeys.has(key)) {
      throw new RetentionPolicyError('duplicate-inventory-key', `Duplicate R2 inventory key: ${key}`);
    }
    seenKeys.add(key);

    const bytesValid = typeof item.Size === 'number' && Number.isSafeInteger(item.Size) && item.Size >= 0;
    const bytes = bytesValid ? item.Size : null;
    if (bytes !== null) totalBytes += bytes;
    const lastModifiedMs = parseUtcTimestamp(item.LastModified);
    const lastModified = lastModifiedMs !== null ? new Date(lastModifiedMs).toISOString() : null;
    const etag = normalizeEtag(item.ETag);
    const currentSources = protectedEntries.byKey.get(key) ?? [];

    // 1. Permanent metadata & versioned updater manifests.
    if (permanentMetadataPattern.test(key)) {
      const reasons: string[] = [];
      if (currentSources.length > 0) {
        reasons.push(`当前公开入口引用保护（${currentSources.join('、')}）`);
      }
      reasons.push('版本元数据、当前指针或签名清单，按策略长期保留');
      decisions.push({
        key,
        bytes,
        lastModified,
        etag,
        category: 'metadata',
        platform: key.startsWith('releases/linux/') ? 'linux' : 'windows',
        version: null,
        releaseTag: null,
        publishedAt: null,
        decision: 'keep',
        reasons,
      });
      continue;
    }

    // 2. Historical audit records stored in bucket.
    if (auditRecordPattern.test(key)) {
      decisions.push({
        key,
        bytes,
        lastModified,
        etag,
        category: 'audit',
        platform: null,
        version: null,
        releaseTag: null,
        publishedAt: null,
        decision: 'keep',
        reasons: ['历史清理审计记录，按策略长期保留'],
      });
      continue;
    }

    // 3. Recognized Windows or Linux release package / checksum.
    const parsed = parseReleaseObjectKey(key);
    if (!parsed) {
      const reasons: string[] = [];
      if (currentSources.length > 0) {
        reasons.push(`当前公开入口引用保护（${currentSources.join('、')}）`);
      }
      reasons.push('未知对象路径或非标准发行文件格式，来源无法可靠确认，暂缓并保留');
      decisions.push({
        key,
        bytes,
        lastModified,
        etag,
        category: 'unknown',
        platform: null,
        version: null,
        releaseTag: null,
        publishedAt: null,
        decision: 'defer',
        reasons,
      });
      continue;
    }

    const platformLabel = parsed.platform === 'windows' ? 'Windows' : 'Linux';
    const keepReasons: string[] = [];
    const deferReasons: string[] = [];
    const anomalyNotes: string[] = [];
    let modifiedWithinWindow = false;

    if (currentSources.length > 0) {
      keepReasons.push(`当前公开入口引用保护（${currentSources.join('、')}）`);
    }

    if (!parsed.versionConsistent) {
      anomalyNotes.push('对象文件名版本号与路径发行标签不一致，暂缓并保留');
    }
    if (bytes === null) {
      anomalyNotes.push('对象大小缺失或异常，信息不完整，暂缓并保留');
    }
    if (lastModifiedMs === null) {
      anomalyNotes.push('对象修改时间缺失或格式异常，暂缓并保留');
    } else if (lastModifiedMs > nowMs) {
      anomalyNotes.push('对象修改时间晚于当前检查时间（时间异常），暂缓并保留');
    } else if (nowMs - lastModifiedMs <= RETENTION_WINDOW_MS) {
      modifiedWithinWindow = true;
      deferReasons.push('对象近 30 天内有修改或重传，按策略暂缓删除');
    }

    const release = releasesByTag.get(parsed.tag);
    let publishedAt: string | null = null;
    let expectedSha256: string | null = null;

    if (!release) {
      anomalyNotes.push(`未找到对应的已发布正式 GitHub Release（${parsed.tag}），暂缓并保留`);
    } else {
      const publishedMs = parseUtcTimestamp(release.published_at);
      if (publishedMs === null) {
        anomalyNotes.push(`正式 Release（${parsed.tag}）发布时间缺失或格式异常，暂缓并保留`);
      } else if (publishedMs > nowMs) {
        anomalyNotes.push(`正式 Release（${parsed.tag}）发布时间晚于当前检查时间（时间异常），暂缓并保留`);
      } else {
        publishedAt = new Date(publishedMs).toISOString();
        if (nowMs - publishedMs <= RETENTION_WINDOW_MS) {
          keepReasons.push(`距正式 Release 发布时间（${publishedAt}）不超过 30 天 UTC`);
        }
      }

      if (top3Sets[parsed.platform].has(parsed.version)) {
        const topList = (parsed.platform === 'windows' ? top3Windows : top3Linux).join('、');
        keepReasons.push(`属于 ${platformLabel} 最近 ${RECENT_VERSIONS_PER_PLATFORM} 个正式版本（${topList}）`);
      }

      if (!Array.isArray(release.assets) || release.assets.length === 0) {
        anomalyNotes.push(`正式 Release（${parsed.tag}）缺少附件元数据，无法可靠核对对象，暂缓并保留`);
      } else {
        const asset = release.assets.find((entry) => entry.name === parsed.fileName);
        if (!asset) {
          anomalyNotes.push(`正式 Release（${parsed.tag}）中未找到匹配附件 ${parsed.fileName}，暂缓并保留`);
        } else if (bytes === null || asset.size !== bytes) {
          anomalyNotes.push(`对象字节数与正式 Release 附件（${asset.size} B）不一致，暂缓并保留`);
        } else if (asset.state && asset.state !== 'uploaded') {
          anomalyNotes.push(`正式 Release 附件状态为 ${asset.state}（非 uploaded），暂缓并保留`);
        } else if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
          const hex = asset.digest.slice('sha256:'.length);
          if (sha256Pattern.test(hex)) expectedSha256 = hex;
        }
      }
    }

    if (keepReasons.length > 0) {
      decisions.push({
        key,
        bytes,
        lastModified,
        etag,
        category: parsed.category,
        platform: parsed.platform,
        version: parsed.version,
        releaseTag: parsed.tag,
        publishedAt,
        decision: 'keep',
        reasons: [...keepReasons, ...anomalyNotes],
      });
      continue;
    }

    const allDeferReasons = [...anomalyNotes, ...(modifiedWithinWindow ? deferReasons : [])];
    if (allDeferReasons.length > 0) {
      decisions.push({
        key,
        bytes,
        lastModified,
        etag,
        category: parsed.category,
        platform: parsed.platform,
        version: parsed.version,
        releaseTag: parsed.tag,
        publishedAt,
        decision: 'defer',
        reasons: allDeferReasons,
      });
      continue;
    }

    // Double-check against low-level deletable object key constraint.
    deletableReleaseObjectKey(key);
    const candidateReason = `不属于 ${platformLabel} 最近 3 个正式版本、距正式发布（${publishedAt!}）超过 30 天 UTC、近 30 天无修改且未被当前入口引用`;
    decisions.push({
      key,
      bytes,
      lastModified,
      etag,
      category: parsed.category,
      platform: parsed.platform,
      version: parsed.version,
      releaseTag: parsed.tag,
      publishedAt,
      decision: 'delete-candidate',
      reasons: [candidateReason],
    });
    candidates.push({
      key,
      bytes: bytes!,
      lastModified: lastModified!,
      etag,
      platform: parsed.platform,
      version: parsed.version,
      releaseTag: parsed.tag,
      publishedAt: publishedAt!,
      expectedSha256,
    });
  }

  const protectedSummary: RetentionProtectedSummary = {
    windowsRecentVersions: top3Windows,
    linuxRecentVersions: top3Linux,
    windowsCurrentVersion: protectedEntries.windowsCurrentVersion,
    updaterCurrentVersion: protectedEntries.updaterCurrentVersion,
    linuxCurrentVersion: protectedEntries.linuxCurrentVersion,
    currentEntryKeys: [...protectedEntries.byKey.keys()].sort(),
    websiteReferenceKeys: protectedEntries.websiteReferenceKeys,
  };

  const keepCount = decisions.filter((item) => item.decision === 'keep').length;
  const deferCount = decisions.filter((item) => item.decision === 'defer').length;
  const deleteCandidateCount = candidates.length;
  const deleteCandidateBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);

  const partial = {
    schemaVersion: 1 as const,
    kind: 'rivloom-r2-retention-plan' as const,
    mode: 'plan' as const,
    readOnly: true as const,
    generatedAt,
    expiresAt,
    sourceCommit: input.metadata?.sourceCommit ?? null,
    inventoryRunID: input.metadata?.inventoryRunID ?? null,
    triggerVersion: input.metadata?.triggerVersion ?? null,
    websiteCommit: input.metadata?.websiteCommit ?? null,
    policy: {
      recentVersionsPerPlatform: RECENT_VERSIONS_PER_PLATFORM,
      retentionWindowHours: RETENTION_WINDOW_HOURS,
      unionRule: true as const,
      autoCleanupEnabled: false as const,
    },
    protectedSummary,
    counts: {
      total: decisions.length,
      keep: keepCount,
      defer: deferCount,
      deleteCandidate: deleteCandidateCount,
      totalBytes,
      deleteCandidateBytes,
    },
    candidates,
    decisions,
  };

  return {
    ...partial,
    manifestSha256: computeRetentionManifestSha256(partial),
  };
}

function decisionLabel(decision: RetentionDecision): string {
  if (decision === 'keep') return '保留';
  if (decision === 'defer') return '暂缓并保留';
  return '可删除候选';
}

export function renderRetentionAuditMarkdown(
  plan: R2RetentionPlan,
  applyResult?: R2RetentionApplyResult,
): string {
  const headingVersion = plan.triggerVersion ? ` ${plan.triggerVersion}` : '';
  const deletedCount = applyResult ? applyResult.counts.deleted : 0;
  const deletedBytes = applyResult ? applyResult.counts.deletedBytes : 0;
  const lines: string[] = [];

  lines.push(`# Rivloom${headingVersion} R2 保留检查`);
  lines.push('');

  const metaParts: string[] = [`检查时间：${plan.generatedAt}`];
  if (plan.sourceCommit) metaParts.push(`源码提交：\`${plan.sourceCommit}\``);
  if (plan.inventoryRunID) {
    metaParts.push(
      `[只读清单任务](https://github.com/rivloom/rivloom-desktop/actions/runs/${plan.inventoryRunID})`,
    );
  }
  if (plan.websiteCommit) metaParts.push(`官网提交：\`${plan.websiteCommit}\``);
  lines.push(
    `${metaParts.join(' · ')}。Windows 当前版本 \`${plan.protectedSummary.windowsCurrentVersion}\`（更新频道 \`${plan.protectedSummary.updaterCurrentVersion}\`），Linux 当前版本 \`${plan.protectedSummary.linuxCurrentVersion}\`，共审计 ${plan.counts.total} 个对象。`,
  );
  lines.push('');

  if (deletedCount === 0) {
    lines.push(
      `**检查完成，删除 0 个。** 保留 ${plan.counts.keep}、暂缓并保留 ${plan.counts.defer}、符合清理条件待处理 ${plan.counts.deleteCandidate}、实际删除 0 个。已提供只读计划与受控人工执行工具，尚未启用无人值守自动清理。`,
    );
  } else {
    lines.push(
      `**受控清理执行完成，实际删除 ${deletedCount} 个**（共 ${deletedBytes.toLocaleString('en-US')} 字节；已不存在 ${applyResult!.counts.alreadyAbsent}、暂缓 ${applyResult!.counts.deferred}、失败 ${applyResult!.counts.failed}，状态：\`${applyResult!.status}\`）。已提供只读计划与受控人工执行工具，尚未启用无人值守自动清理。`,
    );
  }
  lines.push('');

  lines.push('| 结果 | 对象数 |');
  lines.push('| --- | ---: |');
  lines.push(`| 符合保留规则 | ${plan.counts.keep} |`);
  lines.push(`| 暂缓并保留 | ${plan.counts.defer} |`);
  lines.push(`| 符合清理条件，待处理 | ${plan.counts.deleteCandidate} |`);
  lines.push(`| 实际删除 | ${deletedCount} |`);
  lines.push('');

  const winRecent = plan.protectedSummary.windowsRecentVersions.join('、') || '无';
  const linuxRecent = plan.protectedSummary.linuxRecentVersions.join('、') || '无';
  lines.push(
    `Windows 独立保留最近正式版本：${winRecent}；Linux 独立保留最近正式版本：${linuxRecent}。同时按并集保留距正式发布不超过 30 天 UTC 的包、近 30 天修改的对象、当前下载页/更新清单/CLI 入口引用的全部文件、各版本签名清单与历史审计记录，信息不完整或未知对象一律暂缓保留。清单摘要：\`${plan.manifestSha256}\`（有效期至 \`${plan.expiresAt}\`）。 [保留策略](../R2-RETENTION.md)`,
  );
  lines.push('');

  if (plan.counts.deleteCandidate > 0 && !applyResult) {
    const buildCount = new Set(plan.candidates.map((item) => item.releaseTag)).size;
    lines.push(
      `待处理的 ${plan.counts.deleteCandidate} 个对象来自 ${buildCount} 个旧构建，均为发行包及配套校验文件，共 ${plan.counts.deleteCandidateBytes.toLocaleString('en-US')} 字节。本轮仅生成只读计划清单，未执行存储删除，这些文件仍保留在 R2。`,
    );
    lines.push('');
  }

  if (applyResult) {
    lines.push('## 受控清理执行结果');
    lines.push('');
    lines.push(
      `执行时间：${applyResult.executedAt} · 绑定清单摘要：\`${applyResult.manifestSha256}\` · 当前下载与更新指针保持未回滚（\`pointersUntouched=${applyResult.pointersUntouched}\`）。`,
    );
    lines.push('');
    if (applyResult.error) {
      lines.push(`终止/异常说明：\`${applyResult.error}\``);
      lines.push('');
    }
    if (applyResult.items.length > 0) {
      lines.push('| 对象 | 字节数 | 执行状态 | 说明 |');
      lines.push('| --- | ---: | --- | --- |');
      for (const item of applyResult.items) {
        lines.push(`| \`${item.key}\` | ${item.bytes} | ${item.status} | ${item.reason} |`);
      }
      lines.push('');
    }
    if (applyResult.postDeleteVerification) {
      const check = applyResult.postDeleteVerification;
      lines.push(
        `删除后公开入口复核：${check.passed ? '通过' : '失败'}（Windows 公开下载=${check.windowsPublicDownload}、Linux 公开下载=${check.linuxPublicDownload}、更新签名=${check.updaterSignature}、已删键与当前引用无交集=${check.deletedKeysDisjointFromLive}）。`,
      );
      lines.push('');
    }
  }

  lines.push('## 逐对象判定明细');
  lines.push('');
  lines.push('| 对象 | 字节数 | 处理 | 理由 |');
  lines.push('| --- | ---: | --- | --- |');
  for (const item of plan.decisions) {
    const byteText = item.bytes === null ? '未知' : String(item.bytes);
    const reasonText = item.reasons.join('；').replaceAll('|', '\\|');
    lines.push(`| \`${item.key}\` | ${byteText} | ${decisionLabel(item.decision)} | ${reasonText} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function applyR2RetentionPlan(input: RetentionApplyInput): Promise<R2RetentionApplyResult> {
  const nowFn = input.now ?? (() => new Date());
  const executedAt = nowFn().toISOString();
  const nowMs = Date.parse(executedAt);
  const plan = input.plan;

  if (!input.explicitApproval) {
    throw new RetentionPolicyError(
      'explicit-approval-required',
      'Refusing to delete R2 objects without explicit human approval',
    );
  }
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'rivloom-r2-retention-plan') {
    throw new RetentionPolicyError('invalid-retention-plan', 'Retention plan schema is invalid');
  }

  const computedDigest = computeRetentionManifestSha256(plan);
  if (
    !sha256Pattern.test(input.approvedManifestSha256) ||
    plan.manifestSha256 !== computedDigest ||
    input.approvedManifestSha256 !== computedDigest
  ) {
    throw new RetentionPolicyError(
      'manifest-digest-mismatch',
      'Approved manifest SHA-256 does not match the exact retention plan contents',
    );
  }

  const expiresMs = parseUtcTimestamp(plan.expiresAt);
  if (expiresMs === null || !Number.isFinite(nowMs) || nowMs > expiresMs) {
    throw new RetentionPolicyError(
      'manifest-expired',
      'Retention manifest has expired; regenerate a fresh read-only plan before applying',
    );
  }

  for (const candidate of plan.candidates) {
    deletableReleaseObjectKey(candidate.key);
  }

  let releaseLock: (() => Promise<void> | void) | undefined;
  if (input.services.acquireLock) {
    try {
      releaseLock = await input.services.acquireLock();
    } catch (error) {
      throw new RetentionPolicyError(
        'concurrent-publication-active',
        error instanceof Error ? error.message : 'Unable to acquire publication mutex',
      );
    }
  }

  try {
    // Re-read live pointers and references before mutating anything.
    const live = await input.services.loadLiveState();
    const liveProtected = buildProtectedEntryMap(live.entries);
    const liveEntryKeys = [...liveProtected.byKey.keys()].sort();

    const pointersChanged =
      liveProtected.windowsCurrentVersion !== plan.protectedSummary.windowsCurrentVersion ||
      liveProtected.updaterCurrentVersion !== plan.protectedSummary.updaterCurrentVersion ||
      liveProtected.linuxCurrentVersion !== plan.protectedSummary.linuxCurrentVersion ||
      !sameStringArray(liveEntryKeys, plan.protectedSummary.currentEntryKeys);

    if (pointersChanged) {
      return {
        schemaVersion: 1,
        kind: 'rivloom-r2-retention-apply',
        mode: 'apply',
        status: 'aborted-stale-state',
        executedAt,
        manifestSha256: computedDigest,
        pointersUntouched: true,
        autoCleanupEnabled: false,
        error: 'live-pointers-changed-since-plan',
        counts: {
          planned: plan.candidates.length,
          deleted: 0,
          alreadyAbsent: 0,
          deferred: plan.candidates.length,
          failed: 0,
          deletedBytes: 0,
        },
        items: plan.candidates.map((candidate) => ({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'deferred',
          reason: '删除前二次回读发现公开入口指针或引用集合已变化，停止使用旧清单，请重新生成只读计划',
        })),
        postDeleteVerification: null,
      };
    }

    // If live releases are provided, recompute protected recent versions & 30-day window to guard against concurrent releases.
    const liveRecentWindows = new Set<string>();
    const liveRecentLinux = new Set<string>();
    const liveReleaseByTag = new Map<string, GitHubReleaseRecord>();
    if (live.releases) {
      const winVers = new Set<string>();
      const linuxVers = new Set<string>();
      for (const rel of live.releases) {
        if (!rel || rel.draft || rel.prerelease) continue;
        const parsed = parseOfficialReleaseTag(rel.tag_name);
        if (!parsed) continue;
        liveReleaseByTag.set(rel.tag_name, rel);
        if (parsed.platform === 'windows') winVers.add(parsed.version);
        else linuxVers.add(parsed.version);
      }
      const nextWinTop3 = [...winVers]
        .sort((a, b) => compareSemver(b, a))
        .slice(0, RECENT_VERSIONS_PER_PLATFORM);
      const nextLinuxTop3 = [...linuxVers]
        .sort((a, b) => compareSemver(b, a))
        .slice(0, RECENT_VERSIONS_PER_PLATFORM);
      if (
        !sameStringArray(nextWinTop3, plan.protectedSummary.windowsRecentVersions) ||
        !sameStringArray(nextLinuxTop3, plan.protectedSummary.linuxRecentVersions)
      ) {
        return {
          schemaVersion: 1,
          kind: 'rivloom-r2-retention-apply',
          mode: 'apply',
          status: 'aborted-stale-state',
          executedAt,
          manifestSha256: computedDigest,
          pointersUntouched: true,
          autoCleanupEnabled: false,
          error: 'live-releases-changed-since-plan',
          counts: {
            planned: plan.candidates.length,
            deleted: 0,
            alreadyAbsent: 0,
            deferred: plan.candidates.length,
            failed: 0,
            deletedBytes: 0,
          },
          items: plan.candidates.map((candidate) => ({
            key: candidate.key,
            bytes: candidate.bytes,
            status: 'deferred',
            reason: '删除前二次回读发现正式 Release 最近 3 个版本序列已变化（存在并发发布），停止使用旧清单',
          })),
          postDeleteVerification: null,
        };
      }
      for (const v of nextWinTop3) liveRecentWindows.add(v);
      for (const v of nextLinuxTop3) liveRecentLinux.add(v);
    }

    const items: RetentionApplyItem[] = [];
    const deletedKeys: string[] = [];
    let deletedBytes = 0;

    for (const candidate of plan.candidates) {
      deletableReleaseObjectKey(candidate.key);

      // Re-verify live entry protection per key.
      if (liveProtected.byKey.has(candidate.key)) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'deferred',
          reason: '二次回读发现该键已进入当前公开引用集合，暂缓删除',
        });
        continue;
      }

      if (live.releases) {
        const recentSet = candidate.platform === 'windows' ? liveRecentWindows : liveRecentLinux;
        const liveRel = liveReleaseByTag.get(candidate.releaseTag);
        const livePublishedMs = liveRel ? parseUtcTimestamp(liveRel.published_at) : null;
        if (
          recentSet.has(candidate.version) ||
          !liveRel ||
          livePublishedMs === null ||
          nowMs - livePublishedMs <= RETENTION_WINDOW_MS
        ) {
          items.push({
            key: candidate.key,
            bytes: candidate.bytes,
            status: 'deferred',
            reason: '二次回读对应正式发行状态发生变化或已落入保留窗口，暂缓删除',
          });
          continue;
        }
      }

      // Live object HEAD before delete.
      let headResponse: Response;
      try {
        headResponse = await input.services.storage({ method: 'HEAD', key: candidate.key });
      } catch {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          reason: '删除前 HEAD 复核请求失败，未执行删除，当前下载指针保持不变',
        });
        continue;
      }

      const headStatus = headResponse.status;
      const headLength = headResponse.headers.get('content-length');
      const headEtag = normalizeEtag(headResponse.headers.get('etag'));
      const headLastMod = headResponse.headers.get('last-modified');
      await discard(headResponse);

      if (headStatus === 404) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'already-absent',
          httpStatus: 404,
          reason: '对象在 R2 中已不存在（幂等跳过）',
        });
        continue;
      }

      if (headStatus !== 200) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          httpStatus: headStatus,
          reason: `删除前 HEAD 复核返回非预期状态 HTTP ${headStatus}，未执行删除`,
        });
        continue;
      }

      if (headLength !== String(candidate.bytes)) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'deferred',
          httpStatus: 200,
          reason: `对象当前大小（${headLength ?? '缺失'}）与清单（${candidate.bytes}）不一致，暂缓删除`,
        });
        continue;
      }

      if (candidate.etag && headEtag && candidate.etag !== headEtag) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'deferred',
          httpStatus: 200,
          reason: '对象当前 ETag 与清单不一致，存在变更或重传风险，暂缓删除',
        });
        continue;
      }

      if (headLastMod) {
        const liveModMs = parseUtcTimestamp(headLastMod);
        if (liveModMs === null || liveModMs > nowMs || nowMs - liveModMs <= RETENTION_WINDOW_MS) {
          items.push({
            key: candidate.key,
            bytes: candidate.bytes,
            status: 'deferred',
            httpStatus: 200,
            reason: '对象当前修改时间落入近 30 天或存在时间异常，暂缓删除',
          });
          continue;
        }
      }

      // Issue exact-key DELETE.
      let deleteResponse: Response;
      try {
        deleteResponse = await input.services.storage({ method: 'DELETE', key: candidate.key });
      } catch {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          reason: 'DELETE 请求网络或传输异常，当前下载与更新指针保持不变',
        });
        continue;
      }
      const deleteStatus = deleteResponse.status;
      await discard(deleteResponse);

      if (deleteStatus === 404) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'already-absent',
          httpStatus: 404,
          reason: 'DELETE 返回 404（对象已不存在，幂等记录）',
        });
        continue;
      }

      if (deleteStatus !== 200 && deleteStatus !== 204) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          httpStatus: deleteStatus,
          reason: `DELETE 返回 HTTP ${deleteStatus}，记录失败且不回滚当前下载或更新指针`,
        });
        continue;
      }

      // Confirm object removal via authenticated HEAD 404.
      let verifyHead: Response;
      try {
        verifyHead = await input.services.storage({ method: 'HEAD', key: candidate.key });
      } catch {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          httpStatus: deleteStatus,
          reason: 'DELETE 后二次 HEAD 核验失败，需以实际存储清单复核',
        });
        continue;
      }
      const verifyStatus = verifyHead.status;
      await discard(verifyHead);

      if (verifyStatus !== 404) {
        items.push({
          key: candidate.key,
          bytes: candidate.bytes,
          status: 'failed',
          httpStatus: verifyStatus,
          reason: `DELETE 后 HEAD 仍返回 HTTP ${verifyStatus}（预期 404），记为失败`,
        });
        continue;
      }

      deletedKeys.push(candidate.key);
      deletedBytes += candidate.bytes;
      items.push({
        key: candidate.key,
        bytes: candidate.bytes,
        status: 'deleted',
        httpStatus: deleteStatus,
        reason: `已精确删除（HTTP ${deleteStatus}）并通过 HEAD 404 核验`,
      });
    }

    const postDeleteVerification = await input.services.verifyPostDelete(deletedKeys, live);
    const deletedCount = items.filter((item) => item.status === 'deleted').length;
    const alreadyAbsentCount = items.filter((item) => item.status === 'already-absent').length;
    const deferredCount = items.filter((item) => item.status === 'deferred').length;
    const failedCount = items.filter((item) => item.status === 'failed').length;

    const status: R2RetentionApplyResult['status'] =
      !postDeleteVerification.passed
        ? 'failed'
        : failedCount > 0
          ? 'partial-failure'
          : 'completed';

    return {
      schemaVersion: 1,
      kind: 'rivloom-r2-retention-apply',
      mode: 'apply',
      status,
      executedAt,
      manifestSha256: computedDigest,
      pointersUntouched: true,
      autoCleanupEnabled: false,
      ...(status !== 'completed'
        ? {
            error: !postDeleteVerification.passed
              ? 'post-delete-public-verification-failed'
              : 'partial-delete-failure',
          }
        : {}),
      counts: {
        planned: plan.candidates.length,
        deleted: deletedCount,
        alreadyAbsent: alreadyAbsentCount,
        deferred: deferredCount,
        failed: failedCount,
        deletedBytes,
      },
      items,
      postDeleteVerification,
    };
  } finally {
    if (releaseLock) await releaseLock();
  }
}

export async function verifyPublicDownloadsAndUpdater(input: {
  live: LiveRetentionSnapshot;
  deletedKeys: readonly string[];
  updaterPublicKey: string;
  publicRead: (key: string) => Promise<Response>;
  verifyFullBytes?: boolean;
}): Promise<PostDeleteVerificationResult> {
  const details: string[] = [];
  const protectedEntries = buildProtectedEntryMap(input.live.entries);
  const deletedSet = new Set(input.deletedKeys);
  const overlap = [...protectedEntries.byKey.keys()].filter((key) => deletedSet.has(key));
  const deletedKeysDisjointFromLive = overlap.length === 0;
  if (!deletedKeysDisjointFromLive) {
    details.push(`Deleted keys overlapped live references: ${overlap.join(', ')}`);
  }

  let windowsPublicDownload = false;
  let linuxPublicDownload = false;
  let updaterSignature = false;

  const checkJson = async <T>(key: string, parser: (value: unknown) => T): Promise<T | null> => {
    const response = await input.publicRead(key);
    if (response.status !== 200) {
      await discard(response);
      details.push(`Public read ${key} returned HTTP ${response.status}`);
      return null;
    }
    try {
      const text = await response.text();
      return parser(JSON.parse(text));
    } catch {
      details.push(`Public read ${key} failed schema/signature verification`);
      return null;
    }
  };

  const checkArtifact = async (url: string, expectedBytes: number, expectedSha256: string) => {
    const key = normalizeDownloadReferenceToKey(url);
    if (!key) return false;
    const response = await input.publicRead(key);
    if (response.status !== 200) {
      await discard(response);
      details.push(`Public artifact ${key} returned HTTP ${response.status}`);
      return false;
    }
    if (!input.verifyFullBytes) {
      const length = response.headers.get('content-length');
      await discard(response);
      if (length && length !== String(expectedBytes)) {
        details.push(`Public artifact ${key} content-length ${length} != ${expectedBytes}`);
        return false;
      }
      return true;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expectedBytes || sha !== expectedSha256) {
      details.push(`Public artifact ${key} bytes/digest mismatch`);
      return false;
    }
    return true;
  };

  const winLatest = await checkJson('releases/latest.json', parseDownloadRecord);
  if (winLatest) {
    const okArtifact = await checkArtifact(
      winLatest.artifact.url,
      winLatest.artifact.bytes,
      winLatest.artifact.sha256,
    );
    const okChecksum = await checkArtifact(
      winLatest.checksum.url,
      winLatest.checksum.bytes,
      winLatest.checksum.sha256,
    );
    windowsPublicDownload = okArtifact && okChecksum;
  }

  const linuxLatest = await checkJson('releases/linux/latest.json', parseLinuxDownloadRecord);
  if (linuxLatest) {
    let okPlatforms = true;
    for (const platform of availableLinuxPlatforms(linuxLatest)) {
      const target = linuxLatest.platforms[platform]!;
      const ok = await checkArtifact(target.url, target.bytes, target.sha256);
      if (!ok) okPlatforms = false;
    }
    const okChecksum = await checkArtifact(
      linuxLatest.checksum.url,
      linuxLatest.checksum.bytes,
      linuxLatest.checksum.sha256,
    );
    linuxPublicDownload = okPlatforms && okChecksum;
  }

  const updater = await checkJson('updates/stable/latest.json', (value) =>
    parseSignedUpdate(value, input.updaterPublicKey),
  );
  if (updater) {
    const okUpdateArtifact = await checkArtifact(
      updater.metadata.url,
      updater.metadata.bytes,
      updater.metadata.sha256,
    );
    updaterSignature = okUpdateArtifact;
  }

  const passed =
    deletedKeysDisjointFromLive &&
    windowsPublicDownload &&
    linuxPublicDownload &&
    updaterSignature;

  return {
    passed,
    windowsPublicDownload,
    linuxPublicDownload,
    updaterSignature,
    deletedKeysDisjointFromLive,
    details,
  };
}
