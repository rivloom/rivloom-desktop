/** Independent unsigned Preview download metadata. No I/O, dependencies or updater behavior. */
export const PREVIEW_DOWNLOAD_ORIGIN = 'https://downloads.rivloom.com';
export const PREVIEW_DOWNLOAD_URL = `${PREVIEW_DOWNLOAD_ORIGIN}/previews/latest.json`;

export interface PreviewDownloadRecord {
  schemaVersion: 1;
  kind: 'rivloom-preview-download';
  status: 'published';
  version: string;
  product: { kind: 'conversation-preview'; identifier: 'com.rivloom.conversationpreview' };
  source: { commit: string };
  build: { runID: string; artifactID: string };
  release: { id: number; tag: string; publishedAt: string };
  artifact: { fileName: string; bytes: number; sha256: string; url: string };
  checksum: { fileName: 'SHA256SUMS.txt'; bytes: number; sha256: string; url: string };
  signing: { authenticode: 'unsigned'; tauriUpdater: 'not-configured' };
  verification: {
    ci: 'passed';
    installation: 'passed';
    publicDownload: 'passed';
    checkedAt: string;
  };
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[1-9]\d*$/;
const maximumBytes = 2 * 1024 ** 3;

function invalid(field: string): never {
  // Values and unknown field names may contain private data; never include them in errors.
  throw new TypeError(`Invalid Preview download record: ${field}`);
}

function object(value: unknown, fields: readonly string[], label: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(label);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    invalid(label);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      invalid(label);
    result[field] = descriptor.value;
  }
  return result;
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) invalid(label);
  return expected;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  // JavaScript's $ also matches before a final newline; require the entire matched value.
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) invalid(label);
  return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum)
    invalid(label);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 16) invalid(label);
  const result = text(value, idPattern, label);
  positiveInteger(Number(result), label);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, label);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime())) invalid(label);
  const canonical = date.toISOString();
  if (result !== canonical && result !== canonical.replace('.000Z', 'Z')) invalid(label);
  return result;
}

function publicUrl(value: unknown, expected: string, label: string): string {
  if (value !== expected) invalid(label);
  // Exact equality binds the host, release tag and filename and excludes alternate URL spellings.
  const url = new URL(expected);
  if (url.href !== expected || url.origin !== PREVIEW_DOWNLOAD_ORIGIN || url.search || url.hash)
    invalid(label);
  return expected;
}

export function parsePreviewDownloadRecord(value: unknown): PreviewDownloadRecord {
  const record = object(
    value,
    [
      'schemaVersion',
      'kind',
      'status',
      'version',
      'product',
      'source',
      'build',
      'release',
      'artifact',
      'checksum',
      'signing',
      'verification',
    ],
    'record',
  );
  const product = object(record.product, ['kind', 'identifier'], 'product');
  const source = object(record.source, ['commit'], 'source');
  const build = object(record.build, ['runID', 'artifactID'], 'build');
  const release = object(record.release, ['id', 'tag', 'publishedAt'], 'release');
  const artifact = object(record.artifact, ['fileName', 'bytes', 'sha256', 'url'], 'artifact');
  const checksum = object(record.checksum, ['fileName', 'bytes', 'sha256', 'url'], 'checksum');
  const signing = object(record.signing, ['authenticode', 'tauriUpdater'], 'signing');
  const verification = object(
    record.verification,
    ['ci', 'installation', 'publicDownload', 'checkedAt'],
    'verification',
  );
  const version = text(record.version, semver, 'version');
  if (version.length > 100) invalid('version');
  const commit = text(source.commit, commitPattern, 'source.commit');
  const runID = identifier(build.runID, 'build.runID');
  const artifactID = identifier(build.artifactID, 'build.artifactID');
  const tag = `preview-v${version}-${commit.slice(0, 12)}-${artifactID}`;
  const fileName = `Rivloom-UI-Preview_${version}_x64-setup.exe`;
  const base = `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${tag}`;
  const sha256 = text(artifact.sha256, digestPattern, 'artifact.sha256');
  const publishedAt = timestamp(release.publishedAt, 'release.publishedAt');
  const checkedAt = timestamp(verification.checkedAt, 'verification.checkedAt');
  if (Date.parse(checkedAt) < Date.parse(publishedAt)) invalid('verification.checkedAt');
  const checksumBytes = positiveInteger(checksum.bytes, 'checksum.bytes', maximumBytes);
  // SemVer and SHA256 are ASCII. This is the exact single-file SHA256SUMS.txt format.
  if (checksumBytes !== `${sha256}  ${fileName}\n`.length) invalid('checksum.bytes');

  return {
    schemaVersion: literal(record.schemaVersion, 1, 'schemaVersion'),
    kind: literal(record.kind, 'rivloom-preview-download', 'kind'),
    status: literal(record.status, 'published', 'status'),
    version,
    product: {
      kind: literal(product.kind, 'conversation-preview', 'product.kind'),
      identifier: literal(
        product.identifier,
        'com.rivloom.conversationpreview',
        'product.identifier',
      ),
    },
    source: { commit },
    build: { runID, artifactID },
    release: {
      id: positiveInteger(release.id, 'release.id'),
      tag: literal(release.tag, tag, 'release.tag'),
      publishedAt,
    },
    artifact: {
      fileName: literal(artifact.fileName, fileName, 'artifact.fileName'),
      bytes: positiveInteger(artifact.bytes, 'artifact.bytes', maximumBytes),
      sha256,
      url: publicUrl(artifact.url, `${base}/${fileName}`, 'artifact.url'),
    },
    checksum: {
      fileName: literal(checksum.fileName, 'SHA256SUMS.txt', 'checksum.fileName'),
      bytes: checksumBytes,
      sha256: text(checksum.sha256, digestPattern, 'checksum.sha256'),
      url: publicUrl(checksum.url, `${base}/SHA256SUMS.txt`, 'checksum.url'),
    },
    signing: {
      authenticode: literal(signing.authenticode, 'unsigned', 'signing.authenticode'),
      tauriUpdater: literal(signing.tauriUpdater, 'not-configured', 'signing.tauriUpdater'),
    },
    verification: {
      ci: literal(verification.ci, 'passed', 'verification.ci'),
      installation: literal(verification.installation, 'passed', 'verification.installation'),
      publicDownload: literal(verification.publicDownload, 'passed', 'verification.publicDownload'),
      checkedAt,
    },
  };
}

export function parsePreviewDownloadState(value: unknown): PreviewDownloadRecord | null {
  return value === null ? null : parsePreviewDownloadRecord(value);
}
