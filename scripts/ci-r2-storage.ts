// Deliberately limited to the public Preview mirror's three object shapes.
// AWS SigV4: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

export class DownloadSyncFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function requireDownload(value: unknown, code: string): asserts value {
  if (!value) throw new DownloadSyncFailure(code);
}
export const digest = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const emptyDigest = digest('');
const hex256 = /^[0-9a-f]{64}$/;
const exact = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;
export type R2Configuration = {
  accountID: string;
  bucket: string;
  accessKeyID: string;
  secretAccessKey: string;
};
export type ObjectPayload = { bytes: number; sha256: string; path?: string; body?: Buffer };
export type ObjectRequest = {
  method: 'GET' | 'HEAD' | 'PUT';
  key: string;
  payload?: ObjectPayload;
  condition?: { absent: true } | { etag: string };
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
};
export type ObjectTransport = (request: ObjectRequest) => Promise<Response>;

export function r2Configuration(environment: NodeJS.ProcessEnv): R2Configuration {
  const result = {
    accountID: environment.RIVLOOM_R2_ACCOUNT_ID || '',
    bucket: environment.RIVLOOM_R2_BUCKET || '',
    accessKeyID: environment.RIVLOOM_R2_ACCESS_KEY_ID || '',
    secretAccessKey: environment.RIVLOOM_R2_SECRET_ACCESS_KEY || '',
  };
  requireDownload(
    exact(/^[0-9a-f]{32}$/, result.accountID) &&
      exact(/^[0-9a-f]{32}$/, result.accessKeyID) &&
      exact(hex256, result.secretAccessKey),
    'invalid-r2-credentials',
  );
  requireDownload(exact(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, result.bucket), 'invalid-r2-bucket');
  return result;
}
export function previewObjectKey(key: string) {
  requireDownload(
    exact(
      /^previews\/(?:latest\.json|preview-v[0-9A-Za-z.+_-]{1,200}\/(?:Rivloom-UI-Preview_[0-9A-Za-z.+_-]{1,100}_x64-setup\.exe|SHA256SUMS\.txt))$/,
      key,
    ),
    'invalid-preview-object-key',
  );
  return key;
}
const uriEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
export const encodedObjectKey = (key: string) =>
  previewObjectKey(key).split('/').map(uriEncode).join('/');
export function strongEtag(value: string | null): string {
  requireDownload(value !== null && exact(/^"[\x21\x23-\x7e]{1,128}"$/, value), 'invalid-r2-etag');
  return value;
}

// The small pure signer is also checked against an independently published AWS vector.
export function signS3Request(input: {
  url: URL;
  method: 'GET' | 'HEAD' | 'PUT';
  headers?: Record<string, string>;
  payloadSha256: string;
  accessKeyID: string;
  secretAccessKey: string;
  date: Date;
  region?: string;
}) {
  const { url, method, payloadSha256, accessKeyID, secretAccessKey, date } = input;
  requireDownload(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      exact(hex256, payloadSha256),
    'invalid-s3-signing-input',
  );
  requireDownload(
    exact(/^[A-Za-z0-9]{1,128}$/, accessKeyID) && exact(/^[\x21-\x7e]{1,128}$/, secretAccessKey),
    'invalid-s3-signing-input',
  );
  const region = input.region || 'auto';
  requireDownload(
    exact(/^[a-z0-9-]{1,32}$/, region) && Number.isFinite(date.getTime()),
    'invalid-s3-signing-input',
  );
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers || {})) {
    const lower = name.toLowerCase();
    requireDownload(
      exact(/^[a-z0-9-]+$/, lower) &&
        !/[\r\n]/.test(value) &&
        !['host', 'authorization', 'x-amz-date', 'x-amz-content-sha256'].includes(lower) &&
        !(lower in headers),
      'invalid-s3-header',
    );
    headers[lower] = value.trim().replace(/[ \t]+/g, ' ');
  }
  Object.assign(headers, {
    host: url.host,
    'x-amz-content-sha256': payloadSha256,
    'x-amz-date': timestamp,
  });
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    url.pathname,
    '',
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    names.join(';'),
    payloadSha256,
  ].join('\n');
  const scope = `${timestamp.slice(0, 8)}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, digest(canonical)].join('\n');
  const hmac = (key: string | Buffer, value: string) =>
    createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, timestamp.slice(0, 8)), region), 's3'),
    'aws4_request',
  );
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(signingKey, stringToSign).toString('hex')}`;
  return headers;
}

export function r2Transport(
  configuration: R2Configuration,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): ObjectTransport {
  const config = r2Configuration({
    RIVLOOM_R2_ACCOUNT_ID: configuration.accountID,
    RIVLOOM_R2_BUCKET: configuration.bucket,
    RIVLOOM_R2_ACCESS_KEY_ID: configuration.accessKeyID,
    RIVLOOM_R2_SECRET_ACCESS_KEY: configuration.secretAccessKey,
  });
  return async (request) => {
    requireDownload(['GET', 'HEAD', 'PUT'].includes(request.method), 'invalid-r2-method');
    const url = new URL(
      `https://${config.accountID}.r2.cloudflarestorage.com/${config.bucket}/${encodedObjectKey(request.key)}`,
    );
    const headers: Record<string, string> = {};
    let source: ReturnType<typeof createReadStream> | undefined;
    let body: BodyInit | undefined;
    const payload = request.payload;
    requireDownload((request.method === 'PUT') === Boolean(payload), 'invalid-r2-method');
    requireDownload(
      request.method === 'PUT' ||
        (!request.condition &&
          !request.contentType &&
          !request.contentDisposition &&
          !request.cacheControl),
      'invalid-r2-method',
    );
    if (payload) {
      requireDownload(
        Number.isSafeInteger(payload.bytes) &&
          payload.bytes > 0 &&
          payload.bytes <= 2 * 1024 ** 3 &&
          exact(hex256, payload.sha256) &&
          Boolean(payload.path) !== Boolean(payload.body) &&
          request.condition,
        'invalid-r2-payload',
      );
      if (payload.body)
        requireDownload(
          payload.body.length === payload.bytes && digest(payload.body) === payload.sha256,
          'r2-payload-changed',
        );
      if (payload.path) {
        const info = await lstat(payload.path);
        requireDownload(
          info.isFile() && !info.isSymbolicLink() && info.size === payload.bytes,
          'r2-payload-changed',
        );
        source = createReadStream(payload.path);
      }
      body = (source || payload.body) as unknown as BodyInit;
      headers['content-length'] = String(payload.bytes);
      headers['content-type'] = request.contentType || 'application/octet-stream';
      headers['x-amz-meta-rivloom-sha256'] = payload.sha256;
      if (request.contentDisposition) headers['content-disposition'] = request.contentDisposition;
      if (request.cacheControl) headers['cache-control'] = request.cacheControl;
      if ('absent' in request.condition!) headers['if-none-match'] = '*';
      else headers['if-match'] = strongEtag(request.condition!.etag);
    }
    try {
      return await fetcher(url, {
        method: request.method,
        headers: signS3Request({
          url,
          method: request.method,
          headers,
          payloadSha256: payload?.sha256 || emptyDigest,
          accessKeyID: config.accessKeyID,
          secretAccessKey: config.secretAccessKey,
          date: now(),
        }),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(payload ? 240_000 : 30_000),
        ...(source ? { duplex: 'half' } : {}),
      });
    } catch {
      throw new DownloadSyncFailure('r2-request-failed');
    } finally {
      source?.destroy();
    }
  };
}

export async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    /* Never expose an upstream error body. */
  }
}
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      requireDownload(size <= limit, 'response-too-large');
      chunks.push(chunk);
    }
  return Buffer.concat(chunks);
}
export async function responseDigest(response: Response, bytes: number) {
  const hash = createHash('sha256');
  let size = 0;
  if (response.body)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      requireDownload(size <= bytes, 'public-download-size-mismatch');
      hash.update(chunk);
    }
  requireDownload(size === bytes, 'public-download-size-mismatch');
  return hash.digest('hex');
}
