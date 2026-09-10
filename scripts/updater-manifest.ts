import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, lstat, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { DownloadRecord } from './download-record.ts';

export const updaterEndpoint = 'https://downloads.rivloom.com/updates/stable/latest.json';
export const updaterMaximumBytes = 1024 * 1024 * 1024;
export type UpdateMetadata = {
  schemaVersion: 1; product: 'com.rivloom.desktop'; version: string; publishedAt: string; notes: string;
  url: string; signature: string; bytes: number; sha256: string;
};
export type UpdateManifest = {
  version: string; notes: string; pub_date: string;
  platforms: { 'windows-x86_64': { url: string; signature: string } };
  rivloom: { payload: string; signature: string };
};
const fail = () => { throw new Error('Invalid signed Rivloom update'); };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, any>, names: string[]) => Object.keys(value).sort().join(',') === names.sort().join(',');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function stableUpdateVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every((n) => BigInt(n) <= 18446744073709551615n);
}
export function compareUpdateVersion(left: string, right: string): number {
  if (!stableUpdateVersion(left) || !stableUpdateVersion(right)) fail();
  const b = right.split('.').map(BigInt);
  for (const [i, a] of left.split('.').map(BigInt).entries()) { if (a !== b[i]) return a > b[i] ? 1 : -1; }
  return 0;
}
export function officialUpdateURL(value: unknown, version: string): value is string {
  if (typeof value !== 'string' || value.length > 500 || !stableUpdateVersion(version)) return false;
  const prefix = `https://downloads.rivloom.com/releases/v${version}-`;
  if (!value.startsWith(prefix)) return false;
  return new RegExp(`^[0-9a-f]{12}-[1-9][0-9]{0,15}/Rivloom_${version.replaceAll('.', '\\.')}\\_x64-setup\\.exe$`).test(value.slice(prefix.length));
}
function decoded(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) return fail();
  return bytes;
}

/** Verify both Minisign's file signature and its authenticated trusted comment. */
export function verifyUpdaterSignature(bytes: Buffer, signature: string, publicKey: string): void {
  const pub = decoded(publicKey.trim(), 512).toString('utf8').trimEnd().split(/\r?\n/);
  const sig = decoded(signature.trim(), 4096).toString('utf8').trimEnd().split(/\r?\n/);
  if (pub.length !== 2 || sig.length !== 4 || !pub[0].startsWith('untrusted comment: ') ||
    !sig[0].startsWith('untrusted comment: ') || !sig[2].startsWith('trusted comment: ')) fail();
  const key = decoded(pub[1], 42), signed = decoded(sig[1], 74), global = decoded(sig[3], 64);
  if (key.length !== 42 || signed.length !== 74 || global.length !== 64 || key.subarray(0, 2).toString() !== 'Ed' ||
    !key.subarray(2, 10).equals(signed.subarray(2, 10))) fail();
  const algorithm = signed.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') fail();
  const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const fileSignature = signed.subarray(10);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  if (!verify(null, message, publicObject, fileSignature) ||
    !verify(null, Buffer.concat([fileSignature, Buffer.from(sig[2].slice('trusted comment: '.length))]), publicObject, global)) fail();
}
export function parseSignedUpdate(value: unknown, publicKey: string): { manifest: UpdateManifest; metadata: UpdateMetadata } {
  if (!object(value) || JSON.stringify(value).length > 64 * 1024 ||
    !fields(value, ['version', 'notes', 'pub_date', 'platforms', 'rivloom']) || !object(value.rivloom) || !fields(value.rivloom, ['payload', 'signature'])) return fail();
  const payload = decoded(value.rivloom.payload, 32 * 1024);
  verifyUpdaterSignature(payload, value.rivloom.signature, publicKey);
  const metadata: unknown = JSON.parse(payload.toString('utf8'));
  if (!object(metadata) || !fields(metadata, ['schemaVersion', 'product', 'version', 'publishedAt', 'notes', 'url', 'signature', 'bytes', 'sha256']) ||
    metadata.schemaVersion !== 1 || metadata.product !== 'com.rivloom.desktop' || !stableUpdateVersion(metadata.version) ||
    !officialUpdateURL(metadata.url, metadata.version) || typeof metadata.notes !== 'string' || Buffer.byteLength(metadata.notes) > 12_000 ||
    !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > updaterMaximumBytes ||
    typeof metadata.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    typeof metadata.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(metadata.publishedAt) ||
    !Number.isFinite(Date.parse(metadata.publishedAt)) ||
    !object(value.platforms) || !fields(value.platforms, ['windows-x86_64']) || !object(value.platforms['windows-x86_64']) ||
    !fields(value.platforms['windows-x86_64'], ['url', 'signature']) || value.version !== metadata.version || value.notes !== metadata.notes ||
    value.pub_date !== metadata.publishedAt || value.platforms['windows-x86_64'].url !== metadata.url ||
    value.platforms['windows-x86_64'].signature !== metadata.signature) return fail();
  decoded(metadata.signature, 4096);
  return { manifest: value as UpdateManifest, metadata: metadata as UpdateMetadata };
}
export function verifyUpdateArtifact(bytes: Buffer, metadata: UpdateMetadata, publicKey: string) {
  if (bytes.length !== metadata.bytes || digest(bytes) !== metadata.sha256) fail();
  verifyUpdaterSignature(bytes, metadata.signature, publicKey);
}

export async function signUpdateFile(root: string, path: string, environment: NodeJS.ProcessEnv): Promise<string> {
  // Only the fixed official CLI signs; its output and errors can contain key data.
  // Neither is forwarded to logs or bounded result files.
  const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
    if (environment[name] !== undefined) env[name] = environment[name];
  }
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('Updater signing key is not configured');
  await new Promise<void>((done, reject) => execFile(process.execPath, [cli, 'signer', 'sign', resolve(path)],
    { cwd: root, env, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 },
    (error) => error ? reject(new Error('Updater signing failed')) : done()));
  const signaturePath = `${path}.sig`;
  const stat = await lstat(signaturePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail();
  return (await readFile(signaturePath, 'utf8')).trim();
}

export async function createSignedUpdate(input: { root: string; directory: string; artifactPath: string; record: DownloadRecord; notes: string; publicKey: string; environment: NodeJS.ProcessEnv }): Promise<UpdateManifest> {
  const { root, directory, record, notes, publicKey, environment } = input;
  if (!stableUpdateVersion(record.version) || Buffer.byteLength(notes) > 12_000) fail();
  const stat = await lstat(input.artifactPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== record.artifact.bytes || stat.size > updaterMaximumBytes) fail();
  const original = await readFile(input.artifactPath);
  if (digest(original) !== record.artifact.sha256) fail();
  await mkdir(directory, { recursive: true });
  const installer = join(directory, record.artifact.fileName);
  await copyFile(input.artifactPath, installer);
  const signature = await signUpdateFile(root, installer, environment);
  verifyUpdaterSignature(original, signature, publicKey);
  const metadata: UpdateMetadata = { schemaVersion: 1, product: 'com.rivloom.desktop', version: record.version,
    publishedAt: record.release.publishedAt, notes, url: record.artifact.url, signature, bytes: record.artifact.bytes, sha256: record.artifact.sha256 };
  const payload = Buffer.from(JSON.stringify(metadata) + '\n');
  const payloadPath = join(directory, 'update-metadata.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(payloadPath, payload);
  const metadataSignature = await signUpdateFile(root, payloadPath, environment);
  const manifest: UpdateManifest = { version: metadata.version, notes, pub_date: metadata.publishedAt,
    platforms: { 'windows-x86_64': { url: metadata.url, signature } },
    rivloom: { payload: payload.toString('base64'), signature: metadataSignature } };
  parseSignedUpdate(manifest, publicKey);
  verifyUpdateArtifact(original, metadata, publicKey);
  return manifest;
}
