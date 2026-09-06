import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOWNLOAD_ORIGIN,
  DOWNLOAD_URL,
  parseDownloadRecord,
  parseDownloadState,
  type DownloadRecord,
} from './download-record.ts';

function fixture(version = '0.1.3', artifactID = '9971064046'): DownloadRecord {
  const commit = '19f4ad1bb664e99a9c4982715fa9ed43d15f9406';
  const tag = `v${version}-${commit.slice(0, 12)}-${artifactID}`;
  const fileName = `Rivloom_${version}_x64-setup.exe`;
  const sha256 = '3eb6715adcac04952cabdb6a9c1d8474b595dbfb19c4bf6f610e644f95a2190b';
  return {
    schemaVersion: 1,
    kind: 'rivloom-download',
    status: 'published',
    version,
    product: { kind: 'desktop', identifier: 'com.rivloom.desktop' },
    source: { commit },
    build: { runID: '33970888234', artifactID },
    release: { id: 383268608, tag, publishedAt: '2026-09-05T14:22:04Z' },
    artifact: {
      fileName,
      bytes: 72698209,
      sha256,
      url: `${DOWNLOAD_ORIGIN}/releases/${tag}/${fileName}`,
    },
    checksum: {
      fileName: 'SHA256SUMS.txt',
      bytes: `${sha256}  ${fileName}\n`.length,
      sha256: 'c5076fd3f9bb0d9340bc330920e412d9fe5c58072bb816d1b8f35f5a1296a0b8',
      url: `${DOWNLOAD_ORIGIN}/releases/${tag}/SHA256SUMS.txt`,
    },
    signing: { authenticode: 'unsigned', tauriUpdater: 'not-configured' },
    verification: {
      ci: 'passed',
      installation: 'passed',
      publicDownload: 'passed',
      checkedAt: '2026-09-05T14:24:19.069Z',
    },
  };
}

test('published Rivloom metadata parses without mutation and only null represents initial state', () => {
  assert.equal(DOWNLOAD_URL, 'https://downloads.rivloom.com/releases/latest.json');
  const input = fixture();
  const output = parseDownloadRecord(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.artifact, input.artifact);
  assert.equal(output.checksum.bytes, 94);
  assert.deepEqual(parseDownloadState(input), output);
  assert.equal(parseDownloadState(null), null);
  for (const invalid of [null, undefined, {}, [], '', false])
    assert.throws(() => parseDownloadRecord(invalid), TypeError);
  for (const invalid of [undefined, {}, [], '', false])
    assert.throws(() => parseDownloadState(invalid), TypeError);
});

test('every object rejects unknown or missing fields without exposing their contents', () => {
  for (const field of [
    null,
    'product',
    'source',
    'build',
    'release',
    'artifact',
    'checksum',
    'signing',
    'verification',
  ] as const) {
    const input = fixture();
    const target = (field === null ? input : input[field]) as unknown as Record<string, unknown>;
    target.privateField = 'synthetic-private-value';
    assert.throws(
      () => parseDownloadRecord(input),
      (error) =>
        error instanceof TypeError &&
        !error.message.includes('privateField') &&
        !error.message.includes('synthetic-private-value'),
    );
    delete target.privateField;
    delete target[Object.keys(target)[0]];
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
  const input = fixture();
  Object.defineProperty(input, 'version', {
    enumerable: true,
    get() {
      throw new Error('Getter must not run');
    },
  });
  assert.throws(() => parseDownloadRecord(input), TypeError);
  assert.throws(
    () => parseDownloadRecord(Object.assign(Object.create({ extra: true }), fixture())),
    TypeError,
  );
});

test('source identity, full SHA and all release tag bindings are mandatory', () => {
  const changes: Array<(input: any) => void> = [
    (input) => {
      input.schemaVersion = 2;
    },
    (input) => {
      input.kind = 'rivloom-release';
    },
    (input) => {
      input.status = 'draft';
    },
    (input) => {
      input.product.kind = 'conversation-preview';
    },
    (input) => {
      input.product.identifier = 'com.rivloom.conversationpreview';
    },
    (input) => {
      input.source.commit = '19f4ad1';
    },
    (input) => {
      input.source.commit = '0'.repeat(40);
    },
    (input) => {
      input.source.commit = input.source.commit.toUpperCase();
    },
    (input) => {
      input.source.commit += '\n';
    },
    (input) => {
      input.source.commit = '2'.repeat(40);
    },
    (input) => {
      input.build.artifactID = '12345';
    },
    (input) => {
      input.version = '0.1.4';
    },
    (input) => {
      input.release.tag = 'v0.1.3';
    },
    (input) => {
      input.artifact.fileName = '../setup.exe';
    },
    (input) => {
      input.checksum.fileName = 'other.txt';
    },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
});

test('SemVer, positive exact IDs, binary sizes and SHA256 shapes are validated', () => {
  for (const version of ['0.0.0', '1.12.300+build.001'])
    assert.equal(parseDownloadRecord(fixture(version)).version, version);
  for (const version of [
    '01.2.3',
    '1.2',
    '1.2.3-01',
    '1.2.3-rc.1',
    '1.2.3-beta+build.1',
    '1.2.3/extra',
    '1.2.3?x=1',
    ' 1.2.3',
  ])
    assert.throws(() => parseDownloadRecord(fixture(version)), TypeError);
  for (const id of ['1', String(Number.MAX_SAFE_INTEGER)]) {
    const input = fixture('0.1.3', id);
    input.build.runID = id;
    assert.deepEqual(parseDownloadRecord(input).build, { runID: id, artifactID: id });
  }
  for (const field of ['runID', 'artifactID'] as const) {
    for (const value of [
      '0',
      '01',
      '-1',
      '1.5',
      '1e3',
      '123\n',
      '123\r\n',
      String(Number.MAX_SAFE_INTEGER + 1),
      '9999999999999999',
      '1'.repeat(17),
      '9'.repeat(100),
      '',
      123,
      null,
    ]) {
      const input: any = fixture();
      input.build[field] = value;
      assert.throws(() => parseDownloadRecord(input), TypeError);
    }
  }
  for (const value of [0, -1, 0.1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const input: any = fixture();
    input.release.id = value;
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
  const maximum = fixture();
  maximum.artifact.bytes = 2 * 1024 ** 3;
  assert.equal(parseDownloadRecord(maximum).artifact.bytes, 2 * 1024 ** 3);
  for (const value of [0, -1, 0.1, 2 * 1024 ** 3 + 1, Number.NaN, '72698209']) {
    const input: any = fixture();
    input.artifact.bytes = value;
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
  for (const field of ['artifact', 'checksum'] as const) {
    for (const value of [
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      'a'.repeat(64) + '\n',
      '',
    ]) {
      const input = fixture();
      input[field].sha256 = value;
      assert.throws(() => parseDownloadRecord(input), TypeError);
    }
  }
  for (const bytes of [0, 93, 95, 2 * 1024 ** 3 + 1]) {
    const input = fixture();
    input.checksum.bytes = bytes;
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
  const longer = fixture('1.12.300');
  longer.checksum.bytes = 105;
  assert.throws(() => parseDownloadRecord(longer), TypeError);
});

test('download URLs are exact public paths without credentials, aliases or redirects', () => {
  for (const field of ['artifact', 'checksum'] as const) {
    const changes = [
      (url: string) => `${url}?download=1`,
      (url: string) => `${url}#fragment`,
      (url: string) => url.replace('https://', 'http://'),
      (url: string) => url.replace('https://', 'https://user:password@'),
      (url: string) => url.replace('downloads.rivloom.com', 'other.example.com'),
      (url: string) => url.replace('downloads.rivloom.com', 'downloads.rivloom.com:443'),
      (url: string) => url.replace('/releases/', '/releases/../releases/'),
      (url: string) => url.replace('/releases/', '/%72eleases/'),
      (url: string) => url.replace('9971064046', '12345'),
      (url: string) => url + '/',
    ];
    for (const change of changes) {
      const input = fixture();
      input[field].url = change(input[field].url);
      assert.throws(() => parseDownloadRecord(input), TypeError);
    }
  }
});

test('legacy Preview records and partially renamed records never become Rivloom downloads', () => {
  const legacy: any = fixture();
  legacy.kind = 'rivloom-preview-download';
  legacy.product = { kind: 'conversation-preview', identifier: 'com.rivloom.conversationpreview' };
  legacy.release.tag = `preview-v${legacy.version}-${legacy.source.commit.slice(0, 12)}-${legacy.build.artifactID}`;
  legacy.artifact.fileName = `Rivloom-UI-Preview_${legacy.version}_x64-setup.exe`;
  legacy.artifact.url = `${DOWNLOAD_ORIGIN}/previews/${legacy.release.tag}/${legacy.artifact.fileName}`;
  legacy.checksum.url = `${DOWNLOAD_ORIGIN}/previews/${legacy.release.tag}/SHA256SUMS.txt`;
  legacy.checksum.bytes = `${legacy.artifact.sha256}  ${legacy.artifact.fileName}\n`.length;
  assert.throws(() => parseDownloadRecord(legacy), TypeError);
  legacy.kind = 'rivloom-download';
  assert.throws(() => parseDownloadRecord(legacy), TypeError);
  legacy.product = fixture().product;
  assert.throws(() => parseDownloadRecord(legacy), TypeError);
  for (const field of ['artifact', 'checksum'] as const) {
    const input = fixture();
    input[field].url = input[field].url.replace('/releases/', '/previews/');
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
});

test('only unsigned Rivloom with every passed check and ordered real UTC timestamps is accepted', () => {
  for (const [section, key, value] of [
    ['signing', 'authenticode', 'verified'],
    ['signing', 'tauriUpdater', 'configured'],
    ['verification', 'ci', 'failed'],
    ['verification', 'installation', 'skipped'],
    ['verification', 'publicDownload', 'pending'],
  ]) {
    const input: any = fixture();
    input[section][key] = value;
    assert.throws(() => parseDownloadRecord(input), TypeError);
  }
  for (const value of [
    '2026-02-30T14:24:19Z',
    '2026-09-05',
    '2026-09-05T14:24:19+00:00',
    'invalid',
  ]) {
    for (const field of ['publishedAt', 'checkedAt']) {
      const input: any = fixture();
      input[field === 'publishedAt' ? 'release' : 'verification'][field] = value;
      assert.throws(() => parseDownloadRecord(input), TypeError);
    }
  }
  const earlier = fixture();
  earlier.verification.checkedAt = '2026-09-05T14:22:03.999Z';
  assert.throws(() => parseDownloadRecord(earlier), TypeError);
  const equal = fixture();
  equal.verification.checkedAt = equal.release.publishedAt;
  assert.equal(parseDownloadRecord(equal).verification.checkedAt, equal.release.publishedAt);
});
