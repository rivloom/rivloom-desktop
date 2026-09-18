import { createHash } from 'node:crypto';
import { DOWNLOAD_ORIGIN } from './download-record.ts';

export const LINUX_DOWNLOAD_URL = `${DOWNLOAD_ORIGIN}/releases/linux/latest.json`;
export const linuxPlatforms = ['linux-x64', 'linux-arm64'] as const;
export type LinuxPlatform = typeof linuxPlatforms[number];
export type LinuxPlatformMap<T> = { 'linux-x64': T; 'linux-arm64'?: T };
interface Artifact { fileName: string; bytes: number; sha256: string; url: string }
export interface LinuxDownloadRecord {
  schemaVersion: 1;
  kind: 'rivloom-linux-download';
  status: 'published';
  version: string;
  product: { kind: 'headless'; identifier: 'com.rivloom.headless' };
  source: { commit: string };
  build: { runID: string; artifactIDs: LinuxPlatformMap<string> };
  release: { id: number; tag: string; publishedAt: string };
  platforms: LinuxPlatformMap<Artifact>;
  checksum: Artifact;
  verification: { ci: 'passed'; startup: 'passed'; publicDownload: 'passed'; checkedAt: string };
}

const invalid = (field: string): never => { throw new TypeError(`Invalid Rivloom Linux download record: ${field}`); };
function object(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return invalid(field);
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid(field);
    result[key] = descriptor.value;
  }
  return result;
}
function literal<T extends string | number>(value: unknown, expected: T, field: string): T {
  return value === expected ? expected : invalid(field);
}
function text(value: unknown, pattern: RegExp, field: string): string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : invalid(field);
}
function integer(value: unknown, maximum: number, field: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : invalid(field);
}
function id(value: unknown, field: string): string {
  const result = text(value, /^[1-9]\d{0,15}$/, field);
  integer(Number(result), Number.MAX_SAFE_INTEGER, field);
  return result;
}
function timestamp(value: unknown, field: string): string {
  const result = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, field);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || ![date.toISOString(), date.toISOString().replace('.000Z', 'Z')].includes(result)) return invalid(field);
  return result;
}
function artifact(value: unknown, base: string, fileName: string): Artifact {
  const item = object(value, ['fileName', 'bytes', 'sha256', 'url'], 'artifact');
  return {
    fileName: literal(item.fileName, fileName, 'artifact.fileName'),
    bytes: integer(item.bytes, 2 * 1024 ** 3, 'artifact.bytes'),
    sha256: text(item.sha256, /^[0-9a-f]{64}$/, 'artifact.sha256'),
    url: literal(item.url, `${base}/${fileName}`, 'artifact.url'),
  };
}

export function linuxChecksums(record: Pick<LinuxDownloadRecord, 'platforms'>): string {
  return availableLinuxPlatforms(record).map(platform => `${record.platforms[platform]!.sha256}  ${record.platforms[platform]!.fileName}\n`).join('');
}

export function availableLinuxPlatforms(record: Pick<LinuxDownloadRecord, 'platforms'>): LinuxPlatform[] {
  return linuxPlatforms.filter(platform => record.platforms[platform] !== undefined);
}

export function parseLinuxDownloadRecord(value: unknown): LinuxDownloadRecord {
  const record = object(value, ['schemaVersion', 'kind', 'status', 'version', 'product', 'source', 'build', 'release', 'platforms', 'checksum', 'verification'], 'record');
  const product = object(record.product, ['kind', 'identifier'], 'product');
  const source = object(record.source, ['commit'], 'source');
  const build = object(record.build, ['runID', 'artifactIDs'], 'build');
  // x64 is required; ARM64 is included only when both the artifact and provenance exist.
  // object() still rejects missing x64, unknown architectures, accessors and undefined values.
  const platformKeys: readonly LinuxPlatform[] = record.platforms && typeof record.platforms === 'object' && Object.hasOwn(record.platforms, 'linux-arm64') ? linuxPlatforms : ['linux-x64'];
  const artifactIDs = object(build.artifactIDs, platformKeys, 'build.artifactIDs');
  const release = object(record.release, ['id', 'tag', 'publishedAt'], 'release');
  const platforms = object(record.platforms, platformKeys, 'platforms');
  const verification = object(record.verification, ['ci', 'startup', 'publicDownload', 'checkedAt'], 'verification');
  const version = text(record.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, 'version');
  if (version.length > 100) return invalid('version');
  const commit = text(source.commit, /^(?!0{40}$)[0-9a-f]{40}$/, 'source.commit');
  const runID = id(build.runID, 'build.runID');
  const tag = `linux-v${version}-${commit.slice(0, 12)}-${runID}`;
  const base = `${DOWNLOAD_ORIGIN}/releases/linux/${tag}`;
  const publishedAt = timestamp(release.publishedAt, 'release.publishedAt');
  const checkedAt = timestamp(verification.checkedAt, 'verification.checkedAt');
  if (Date.parse(checkedAt) < Date.parse(publishedAt)) return invalid('verification.checkedAt');
  const parsedPlatforms = Object.fromEntries(platformKeys.map(platform => [platform, artifact(platforms[platform], base, `Rivloom_${version}_${platform.replace('-', '_')}.tar.gz`)])) as LinuxDownloadRecord['platforms'];
  const checksum = artifact(record.checksum, base, 'SHA256SUMS.txt');
  const checksums = linuxChecksums({ platforms: parsedPlatforms });
  if (checksum.bytes !== Buffer.byteLength(checksums) || checksum.sha256 !== createHash('sha256').update(checksums).digest('hex')) return invalid('checksum');
  return {
    schemaVersion: literal(record.schemaVersion, 1, 'schemaVersion'), kind: literal(record.kind, 'rivloom-linux-download', 'kind'), status: literal(record.status, 'published', 'status'), version,
    product: { kind: literal(product.kind, 'headless', 'product.kind'), identifier: literal(product.identifier, 'com.rivloom.headless', 'product.identifier') },
    source: { commit }, build: { runID, artifactIDs: Object.fromEntries(platformKeys.map(platform => [platform, id(artifactIDs[platform], 'artifactID')])) as LinuxPlatformMap<string> },
    release: { id: integer(release.id, Number.MAX_SAFE_INTEGER, 'release.id'), tag: literal(release.tag, tag, 'release.tag'), publishedAt },
    platforms: parsedPlatforms, checksum,
    verification: { ci: literal(verification.ci, 'passed', 'verification.ci'), startup: literal(verification.startup, 'passed', 'verification.startup'), publicDownload: literal(verification.publicDownload, 'passed', 'verification.publicDownload'), checkedAt },
  };
}

export const parseLinuxDownloadState = (value: unknown) => value === null ? null : parseLinuxDownloadRecord(value);
