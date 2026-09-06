import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundedBytes,
  digest,
  encodedObjectKey,
  r2Configuration,
  r2Transport,
  responseDigest,
  signS3Request,
  strongEtag,
} from './ci-r2-storage.ts';

// Official public, deliberately fake AWS test credentials and expected signatures:
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
const example = {
  accessKeyID: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  date: new Date('2013-05-24T00:00:00Z'),
  region: 'us-east-1',
};
test('native S3 signing matches both independent AWS GET and PUT examples', () => {
  const get = signS3Request({
    ...example,
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    method: 'GET',
    headers: { Range: 'bytes=0-9' },
    payloadSha256: digest(''),
  });
  assert.equal(
    get.authorization.split('Signature=')[1],
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  const put = signS3Request({
    ...example,
    url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
    method: 'PUT',
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadSha256: digest('Welcome to Amazon S3.'),
  });
  assert.equal(
    put.authorization.split('Signature=')[1],
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );
});

const configuration = {
  accountID: 'a'.repeat(32),
  bucket: 'rivloom-downloads',
  accessKeyID: 'b'.repeat(32),
  secretAccessKey: 'c'.repeat(64),
};
const environment = {
  RIVLOOM_R2_ACCOUNT_ID: configuration.accountID,
  RIVLOOM_R2_BUCKET: configuration.bucket,
  RIVLOOM_R2_ACCESS_KEY_ID: configuration.accessKeyID,
  RIVLOOM_R2_SECRET_ACCESS_KEY: configuration.secretAccessKey,
};
test('R2 credentials, object paths and conditional headers reject ambiguous inputs', () => {
  assert.deepEqual(r2Configuration(environment), configuration);
  for (const key of Object.keys(environment))
    assert.throws(() =>
      r2Configuration({
        ...environment,
        [key]: environment[key as keyof typeof environment] + '\n',
      }),
    );
  for (const key of [
    '../private',
    'releases/latest.json?x=1',
    'releases/latest.json\n',
    'releases/x/private.zip',
    'releases/v0.1.3/../../secret',
    'releases/latest.json#x',
    'previews/latest.json',
    'releases/preview-v0.1.3-111111111111-1/SHA256SUMS.txt',
    'releases/v0.1.3-111111111111-1/Rivloom-UI-Preview_0.1.3_x64-setup.exe',
  ])
    assert.throws(() => encodedObjectKey(key));
  assert.equal(
    encodedObjectKey('releases/v0.1.3+build-111111111111-1/SHA256SUMS.txt'),
    'releases/v0.1.3%2Bbuild-111111111111-1/SHA256SUMS.txt',
  );
  for (const value of [null, 'unquoted', 'W/"abc"', '"abc"\n', '"abc\r\nx: y"'])
    assert.throws(() => strongEtag(value));
});

test('R2 signs a conditional payload for the fixed account endpoint and never follows redirects', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null);
  };
  const transport = r2Transport(configuration, fakeFetch, () => new Date('2026-09-05T09:00:00Z'));
  const body = Buffer.from('{"synthetic":true}\n');
  await transport({
    method: 'PUT',
    key: 'releases/latest.json',
    payload: { body, bytes: body.length, sha256: digest(body) },
    condition: { etag: '"existing"' },
    contentType: 'application/json',
    cacheControl: 'no-store',
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://${configuration.accountID}.r2.cloudflarestorage.com/rivloom-downloads/releases/latest.json`,
  );
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('if-match'), '"existing"');
  assert.equal(headers.get('x-amz-content-sha256'), digest(body));
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.match(headers.get('authorization')!, /\/20260905\/auto\/s3\/aws4_request/);
  assert.match(headers.get('authorization')!, /if-match/);
  assert.equal(calls[0].init?.redirect, 'error');
  await assert.rejects(
    () =>
      transport({
        method: 'PUT',
        key: 'releases/latest.json',
        payload: { body, bytes: body.length, sha256: 'f'.repeat(64) },
        condition: { absent: true },
      }),
    /payload-changed/,
  );
  await assert.rejects(() => transport({ method: 'GET', key: '../other-bucket/key' }));
  await assert.rejects(() => transport({ method: 'GET', key: 'previews/latest.json' }));
  assert.equal(calls.length, 1);
});

test('response hashing detects wrong length and bounded metadata rejects excess bytes', async () => {
  const body = 'A synthetic public response';
  assert.equal(await responseDigest(new Response(body), body.length), digest(body));
  await assert.rejects(() => responseDigest(new Response(body), body.length - 1), /size-mismatch/);
  await assert.rejects(() => responseDigest(new Response(body), body.length + 1), /size-mismatch/);
  await assert.rejects(() => boundedBytes(new Response(body), 4), /too-large/);
});

test('R2 reads preserve a strong ETag and use it unchanged for conditional replacement', async () => {
  const body = Buffer.from('{"synthetic":true}\n');
  const etag = '"existing-object"';
  const methods: string[] = [];
  const transport = r2Transport(configuration, async (_url, init) => {
    const headers = new Headers(init?.headers);
    methods.push(init!.method!);
    // Reproduce compressed JSON delivery: a negotiated representation carries a
    // weak validator, which must never be stripped or accepted for If-Match.
    if (init?.method === 'GET')
      return new Response(body, {
        headers: {
          etag: headers.get('accept-encoding') === 'identity' ? etag : `W/${etag}`,
        },
      });
    assert.equal(headers.get('if-match'), etag);
    assert.equal(headers.get('accept-encoding'), 'identity');
    assert.match(headers.get('authorization')!, /SignedHeaders=accept-encoding;/);
    return new Response(null);
  });
  const existing = await transport({ method: 'GET', key: 'releases/latest.json' });
  const receivedEtag = strongEtag(existing.headers.get('etag'));
  assert.deepEqual(await boundedBytes(existing, 1024), body);
  await transport({
    method: 'PUT',
    key: 'releases/latest.json',
    payload: { body, bytes: body.length, sha256: digest(body) },
    condition: { etag: receivedEtag },
    contentType: 'application/json',
  });
  assert.deepEqual(methods, ['GET', 'PUT']);
});

test('transport failures discard raw credential-bearing errors', async () => {
  const transport = r2Transport(configuration, async () => {
    throw new Error(`secret ${configuration.secretAccessKey}`);
  });
  await assert.rejects(
    () => transport({ method: 'HEAD', key: 'releases/latest.json' }),
    (error: Error) =>
      error.message === 'r2-request-failed' &&
      !error.message.includes(configuration.secretAccessKey),
  );
});
