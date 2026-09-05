import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  candidateMetadataSchema,
  createCandidateRecord,
  immutableReleaseDirectory,
  isPublicReleaseUrl,
  parseReleaseRecord,
  releaseVersionSchema,
  type CandidateMetadata,
  type ReleaseRecord,
} from '../scripts/release-record.ts';
import {
  measureInstaller,
  readReleaseJson,
  verifyInstaller,
  writeCandidateRecord,
} from '../scripts/release-files.ts';
import { generateReleaseCandidate } from '../scripts/release-generate.ts';
import { validateReleaseFile } from '../scripts/release-validate.ts';

const metadata = (): CandidateMetadata => ({
  product: { kind: 'desktop', identifier: 'com.rivloom.desktop' },
  channel: 'stable',
  version: '0.2.0',
  source: { commit: 'a'.repeat(40), workingTree: 'clean' },
  notes: {
    summary: 'TEST DATA ONLY',
    changes: ['Exercise local metadata validation.'],
    knownIssues: ['No package in these tests is a release.'],
    url: null,
  },
  compatibility: {
    windows: {
      versions: ['10', '11'],
      architecture: 'x86_64',
      installMode: 'currentUser',
      webview2: 'required',
    },
    upgradeFrom: [],
    node: { protocolVersion: 1, requiredCapabilities: [], testedAppVersions: [] },
    data: { writtenVersion: 3, readableVersions: [3], migratableFromVersions: [] },
    automaticDowngrade: false,
  },
});
const candidate = () =>
  createCandidateRecord(metadata(), {
    fileName: 'fixture_0.2.0_x64-setup.exe',
    bytes: 128,
    sha256: 'b'.repeat(64),
  });
// Syntax fixtures stay in memory. This hostname is not a configured or verified download source.
const syntaxOrigin = 'https://' + ['downloads', 'fixture-public-domain', 'org'].join('.');
function published(): ReleaseRecord {
  const record = candidate();
  record.status = 'published';
  record.publishedAt = '2026-09-05T00:00:00Z';
  record.artifact.url =
    syntaxOrigin +
    immutableReleaseDirectory(record.product, record.channel, record.version) +
    record.artifact.fileName;
  record.signatures.authenticode = {
    status: 'verified',
    publisher: 'TEST FIXTURE ONLY',
    timestamped: true,
    verification: {
      artifactSha256: record.artifact.sha256,
      checkedAt: '2026-09-04T00:00:00Z',
      tool: 'test fixture, no signature verified',
    },
  };
  return record;
}
async function temporary(t: TestContext) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'rivloom-release-test-'));
  t.after(async () => {
    assert(resolve(root).startsWith(parent + sep));
    assert(basename(root).startsWith('rivloom-release-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function fakePe() {
  // Minimal PE header bytes for measurement tests, deliberately not an installable NSIS package.
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.write('PE\0\0', 64);
  return bytes;
}

test('release candidates never imply publication, a download URL, or verified signatures', () => {
  const record = candidate();
  assert.equal(record.status, 'candidate');
  assert.equal(record.artifact.url, null);
  assert.equal(record.publishedAt, null);
  assert.equal(record.signatures.authenticode.status, 'not-verified');
  assert.equal(record.signatures.tauriUpdater.status, 'not-configured');
  assert.throws(() => parseReleaseRecord(record, { requirePublished: true }), /candidate/);
  record.artifact.url = published().artifact.url;
  assert.throws(() => parseReleaseRecord(record), /Candidates cannot/);
});

test('release product identity and channel cannot relabel a Preview as stable or beta', () => {
  const preview = metadata();
  preview.product = { kind: 'conversation-preview', identifier: 'com.rivloom.conversationpreview' };
  assert.throws(() => candidateMetadataSchema.parse(preview), /exclusive/);
  preview.channel = 'beta';
  preview.version = '0.2.0-beta.1';
  assert.throws(() => candidateMetadataSchema.parse(preview), /exclusive/);
  preview.channel = 'preview';
  preview.version = '0.1.3';
  assert.equal(
    candidateMetadataSchema.parse(preview).product.identifier,
    preview.product.identifier,
  );
  assert.throws(
    () => candidateMetadataSchema.parse({ ...metadata(), channel: 'preview' }),
    /exclusive/,
  );
  assert.throws(() =>
    candidateMetadataSchema.parse({
      ...metadata(),
      product: { kind: 'desktop', identifier: preview.product.identifier },
    }),
  );
});

test('release versions use SemVer and explicit stable/beta rules', () => {
  for (const version of ['0.0.0', '1.2.3', '1.2.3-beta.1', '1.2.3+build.7'])
    assert(releaseVersionSchema.safeParse(version).success, version);
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-beta.01', '1.2.3-', '1.2.3+'])
    assert(!releaseVersionSchema.safeParse(version).success, version);
  assert.throws(
    () => candidateMetadataSchema.parse({ ...metadata(), version: '0.2.0-beta.1' }),
    /Stable/,
  );
  assert.throws(() => candidateMetadataSchema.parse({ ...metadata(), channel: 'beta' }), /Beta/);
  assert.throws(
    () => candidateMetadataSchema.parse({ ...metadata(), channel: 'beta', version: '0.2.0-rc.1' }),
    /Beta/,
  );
  assert.equal(
    candidateMetadataSchema.parse({ ...metadata(), channel: 'beta', version: '0.2.0-beta.1' })
      .channel,
    'beta',
  );
});

test('release URL rejects credentials, query strings, local addresses, placeholders and dev hosting', () => {
  assert(isPublicReleaseUrl(syntaxOrigin + '/file.exe'));
  for (const url of [
    'http://downloads.real-domain.org/file.exe',
    'https://user:token@downloads.real-domain.org/file.exe',
    'https://downloads.real-domain.org/file.exe?token=secret',
    'https://downloads.real-domain.org/file.exe#latest',
    'https://127.0.0.1/file.exe',
    'https://[::1]/file.exe',
    'https://localhost/file.exe',
    'https://host.local/file.exe',
    'https://downloads.example.com/file.exe',
    'https://example.org/file.exe',
    'https://host.invalid/file.exe',
    'https://host.test/file.exe',
    'https://bucket.r2.dev/file.exe',
    'https://downloads.real-domain.org:8443/file.exe',
    'https://downloads.real-domain.org/a/../file.exe',
  ])
    assert(!isPublicReleaseUrl(url), url);
});

test('published release URL must contain exact identity, channel, version and final filename', () => {
  assert.equal(parseReleaseRecord(published(), { requirePublished: true }).status, 'published');
  for (const pathname of [
    '/stable/latest.exe',
    '/releases/com.rivloom.desktop/stable/latest/fixture_0.2.0_x64-setup.exe',
    '/releases/com.rivloom.conversationpreview/stable/0.2.0/fixture_0.2.0_x64-setup.exe',
    '/releases/com.rivloom.desktop/beta/0.2.0/fixture_0.2.0_x64-setup.exe',
    '/releases/com.rivloom.desktop/stable/0.1.3/fixture_0.2.0_x64-setup.exe',
    '/releases/com.rivloom.desktop/stable/0.2.0/another.exe',
  ]) {
    const record = published();
    record.artifact.url = syntaxOrigin + pathname;
    assert.throws(() => parseReleaseRecord(record), /immutable/);
  }
});

test('published records require real UTC calendar dates, clean source and final artifact metadata', () => {
  for (const mutation of [
    (r: ReleaseRecord) => {
      r.publishedAt = null;
    },
    (r: ReleaseRecord) => {
      r.publishedAt = '2026-02-30T00:00:00Z';
    },
    (r: ReleaseRecord) => {
      r.artifact.url = null;
    },
    (r: ReleaseRecord) => {
      r.source.workingTree = 'dirty';
    },
    (r: ReleaseRecord) => {
      r.source.commit = 'main';
    },
    (r: ReleaseRecord) => {
      r.source.commit = '0'.repeat(40);
    },
    (r: ReleaseRecord) => {
      r.artifact.bytes = 0;
    },
    (r: ReleaseRecord) => {
      r.artifact.bytes = Number.MAX_SAFE_INTEGER + 1;
    },
    (r: ReleaseRecord) => {
      r.artifact.sha256 = 'SHA256';
    },
  ]) {
    const record = published();
    mutation(record);
    assert.throws(() => parseReleaseRecord(record));
  }
});

test('stable signature claims require timestamp and bind the final installer hash', () => {
  const record = published();
  record.signatures.authenticode = candidate().signatures.authenticode;
  assert.throws(() => parseReleaseRecord(record), /Authenticode/);
  const wrongHash = published();
  assert.equal(wrongHash.signatures.authenticode.status, 'verified');
  if (wrongHash.signatures.authenticode.status === 'verified') {
    wrongHash.signatures.authenticode.verification.artifactSha256 = 'c'.repeat(64);
    assert.throws(() => parseReleaseRecord(wrongHash), /final installer hash/);
    wrongHash.signatures.authenticode.verification.artifactSha256 = wrongHash.artifact.sha256;
    wrongHash.signatures.authenticode.timestamped = false;
    assert.throws(() => parseReleaseRecord(wrongHash), /timestamp/);
  }
});

test('published signature verification cannot be dated after publication', () => {
  const record = published();
  assert.equal(record.signatures.authenticode.status, 'verified');
  if (record.signatures.authenticode.status === 'verified')
    record.signatures.authenticode.verification.checkedAt = '2026-09-06T00:00:00Z';
  assert.throws(() => parseReleaseRecord(record), /precede publication/);
});

test('updater signature content is separate from Authenticode and cannot be a URL or join Preview', () => {
  const record = published();
  assert.equal(parseReleaseRecord(record).signatures.tauriUpdater.status, 'not-configured');
  record.signatures.tauriUpdater = {
    status: 'verified',
    signature: Buffer.from('TEST ONLY: no cryptographic signature is being verified here').toString(
      'base64',
    ),
    publicKeyFingerprint: 'd'.repeat(64),
    verification: {
      artifactSha256: record.artifact.sha256,
      checkedAt: '2026-09-04T00:00:00Z',
      tool: 'test fixture',
    },
  };
  assert.equal(parseReleaseRecord(record).signatures.tauriUpdater.status, 'verified');
  record.signatures.tauriUpdater.signature = syntaxOrigin + '/setup.exe.sig';
  assert.throws(() => parseReleaseRecord(record));
  const preview = candidate();
  preview.product = { kind: 'conversation-preview', identifier: 'com.rivloom.conversationpreview' };
  preview.channel = 'preview';
  preview.signatures.tauriUpdater = {
    status: 'not-verified',
    signature: Buffer.from('TEST ONLY: deliberately synthetic signature content').toString(
      'base64',
    ),
    publicKeyFingerprint: 'd'.repeat(64),
    verification: null,
  };
  assert.throws(() => parseReleaseRecord(preview), /Preview records/);
});

test('release schema rejects unknown fields, unsupported platforms and unsafe filenames', () => {
  assert.throws(() => parseReleaseRecord({ ...candidate(), downloadUrl: syntaxOrigin }));
  assert.throws(() => parseReleaseRecord({ ...candidate(), platform: 'windows-aarch64' }));
  assert.throws(() => candidateMetadataSchema.parse({ ...metadata(), publishedAt: null }));
  for (const fileName of [
    '../setup.exe',
    'C:\\setup.exe',
    '/setup.exe',
    'setup.exe:stream',
    'setup.zip',
  ]) {
    const record = candidate();
    record.artifact.fileName = fileName;
    assert.throws(() => parseReleaseRecord(record));
  }
  const unknown = candidate();
  Object.assign(unknown.compatibility.node, { token: 'must not enter public records' });
  assert.throws(() => parseReleaseRecord(unknown));
});

test('compatibility declares explicit version coverage without implying downgrade or duplicate claims', () => {
  const input = metadata();
  input.compatibility.data.readableVersions = [2];
  assert.throws(() => candidateMetadataSchema.parse(input), /written data format/);
  input.compatibility.data.readableVersions = [3];
  input.compatibility.data.migratableFromVersions = [4];
  assert.throws(() => candidateMetadataSchema.parse(input), /Migration/);
  input.compatibility.data.migratableFromVersions = [2];
  input.compatibility.upgradeFrom = ['0.1.3', '0.1.3'];
  assert.throws(() => candidateMetadataSchema.parse(input), /Duplicate/);
  input.compatibility.upgradeFrom = ['0.1.3'];
  assert.equal(candidateMetadataSchema.parse(input).compatibility.automaticDowngrade, false);
  assert.throws(() =>
    candidateMetadataSchema.parse({
      ...input,
      compatibility: { ...input.compatibility, automaticDowngrade: true },
    }),
  );
});

test('candidate generation hashes explicit PE bytes and writes only an exclusive candidate path', async (t) => {
  const root = await temporary(t);
  const installer = join(root, 'fixture_0.2.0_x64-setup.exe');
  const bytes = fakePe();
  await writeFile(installer, bytes);
  const metadataPath = join(root, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(metadata()));
  const generated = await generateReleaseCandidate(metadataPath, installer, join(root, 'output'));
  assert.equal(generated.record.artifact.bytes, bytes.length);
  assert.equal(generated.record.artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(
    generated.path,
    join(root, 'output', 'releases', 'com.rivloom.desktop', 'stable', '0.2.0', 'candidate.json'),
  );
  assert.deepEqual(
    await validateReleaseFile(generated.path, { artifactPath: installer }),
    generated.record,
  );
  await assert.rejects(
    () => validateReleaseFile(generated.path, { requirePublished: true }),
    /candidate/,
  );
  const original = await readFile(generated.path, 'utf8');
  await assert.rejects(
    () => generateReleaseCandidate(metadataPath, installer, join(root, 'output')),
    /EEXIST/,
  );
  assert.equal(await readFile(generated.path, 'utf8'), original);
  await assert.rejects(
    () => writeCandidateRecord(published(), join(root, 'published')),
    /only writes candidates/,
  );
});

test('artifact verification detects changed bytes, file size and renamed installers', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'setup.exe');
  const bytes = fakePe();
  await writeFile(path, bytes);
  const record = createCandidateRecord(metadata(), await measureInstaller(path));
  bytes[100] = 1;
  await writeFile(path, bytes);
  await assert.rejects(() => verifyInstaller(record, path), /sha256/);
  await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
  await assert.rejects(() => verifyInstaller(record, path), /bytes/);
  const renamed = join(root, 'renamed.exe');
  await writeFile(renamed, fakePe());
  await assert.rejects(() => verifyInstaller(record, renamed), /fileName/);
});

test('generator rejects text files, directories and oversized metadata rather than guessing installer contents', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'setup.exe');
  await writeFile(path, Buffer.alloc(128, 'x'));
  await assert.rejects(() => measureInstaller(path), /Windows PE/);
  await mkdir(join(root, 'directory'));
  await assert.rejects(() => measureInstaller(join(root, 'directory')), /regular PE/);
  await assert.rejects(() => readReleaseJson(join(root, 'directory')), /regular JSON/);
  await writeFile(join(root, 'oversized.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(() => readReleaseJson(join(root, 'oversized.json')), /2 MiB/);
});

test('CLI help is explicit and generator rejects a publication switch', () => {
  const generator = resolve('scripts/release-generate.ts');
  const validator = resolve('scripts/release-validate.ts');
  assert.match(
    execFileSync(process.execPath, [generator, '--help'], { encoding: 'utf8', windowsHide: true }),
    /Only generates a local candidate/,
  );
  assert.match(
    execFileSync(process.execPath, [validator, '--help'], { encoding: 'utf8', windowsHide: true }),
    /Does not verify signatures/,
  );
  const result = spawnSync(process.execPath, [generator, '--published'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown or duplicate argument/);
});
