// Publish a signed update only after the existing candidate -> Release -> public
// download chain has passed. This script never builds or installs an application.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareRelease, releaseContext, type ReleaseContext } from './ci-release.ts';
import { parseDownloadRecord, DOWNLOAD_ORIGIN } from './download-record.ts';
import { boundedBytes, digest, discard, r2Configuration, r2Transport, encodedObjectKey, responseDigest, strongEtag, type ObjectTransport } from './ci-r2-storage.ts';
import { createSignedUpdate, parseSignedUpdate, compareUpdateVersion, updaterEndpoint, type UpdateManifest, type UpdateMetadata } from './updater-manifest.ts';

export type UpdaterServices = { storage: ObjectTransport; publicRead: (key: string) => Promise<Response> };
const latest = 'updates/stable/latest.json';
const limit = 64 * 1024;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const binding = (metadata: UpdateMetadata) => ({ ...metadata, signature: '' });

async function stored(key: string, publicKey: string, services: UpdaterServices) {
  const response = await services.storage({ method: 'GET', key });
  if (response.status === 404) { await discard(response); return null; }
  if (response.status !== 200) { await discard(response); throw new Error('Updater metadata read failed'); }
  const etag = strongEtag(response.headers.get('etag'));
  const parsed = parseSignedUpdate(JSON.parse((await boundedBytes(response, limit)).toString('utf8')), publicKey);
  return { ...parsed, etag };
}
async function verifyPublicManifest(key: string, expected: UpdateManifest, publicKey: string, services: UpdaterServices) {
  const response = await services.publicRead(key);
  if (response.status !== 200) { await discard(response); throw new Error('Public updater metadata is unavailable'); }
  const actual = parseSignedUpdate(JSON.parse((await boundedBytes(response, limit)).toString('utf8')), publicKey).manifest;
  ensure(isDeepStrictEqual(actual, expected), 'Public updater metadata differs from the selected signed release');
}

export async function publishSignedUpdate(manifest: UpdateManifest, publicKey: string, services: UpdaterServices) {
  const next = parseSignedUpdate(manifest, publicKey);
  // Recheck the installer through the anonymous official source before publishing
  // either immutable metadata or the discoverable channel pointer.
  const installer = await services.publicRead(new URL(next.metadata.url).pathname.slice(1));
  if (installer.status !== 200) { await discard(installer); throw new Error('Public update installer is unavailable'); }
  ensure(await responseDigest(installer, next.metadata.bytes) === next.metadata.sha256, 'Public update installer bytes do not match the signed release');
  const versionKey = `updates/stable/${next.metadata.version}.json`;
  let selected: UpdateManifest | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await stored(versionKey, publicKey, services);
    if (previous) {
      ensure(isDeepStrictEqual(binding(previous.metadata), binding(next.metadata)), 'The same update version already has different content');
      selected = previous.manifest; break;
    }
    const bytes = encode(manifest);
    const response = await services.storage({ method: 'PUT', key: versionKey, condition: { absent: true },
      payload: { bytes: bytes.length, sha256: digest(bytes), body: bytes }, contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable' });
    const status = response.status; await discard(response);
    if (status === 409 || status === 412) continue;
    ensure(status === 200, 'Versioned updater metadata upload failed');
    selected = manifest; break;
  }
  ensure(selected, 'Versioned updater metadata could not be selected');
  await verifyPublicManifest(versionKey, selected, publicKey, services);
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await stored(latest, publicKey, services);
    if (previous) {
      const comparison = compareUpdateVersion(previous.metadata.version, next.metadata.version);
      if (comparison > 0) return { status: 'superseded', version: next.metadata.version, latestVersion: previous.metadata.version };
      if (comparison === 0) {
        ensure(isDeepStrictEqual(binding(previous.metadata), binding(next.metadata)), 'A published update version cannot be replaced');
        await verifyPublicManifest(latest, previous.manifest, publicKey, services);
        return { status: 'reused', version: next.metadata.version, url: updaterEndpoint };
      }
    }
    const bytes = encode(selected);
    const response = await services.storage({ method: 'PUT', key: latest,
      condition: previous ? { etag: previous.etag } : { absent: true }, payload: { bytes: bytes.length, sha256: digest(bytes), body: bytes },
      contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
    const status = response.status; await discard(response);
    if (status === 409 || status === 412) continue;
    ensure(status === 200, 'Updater channel promotion failed');
    await verifyPublicManifest(latest, selected, publicKey, services);
    return { status: 'published', version: next.metadata.version, url: updaterEndpoint };
  }
  throw new Error('Updater channel changed concurrently; retry the same release');
}

export async function synchronizeUpdater(root: string, context: ReleaseContext, services: UpdaterServices, environment: NodeJS.ProcessEnv) {
  const plan = await prepareRelease(root, context);
  const response = await services.publicRead('releases/latest.json');
  ensure(response.status === 200, 'The verified public download record is unavailable');
  const record = parseDownloadRecord(JSON.parse((await boundedBytes(response, limit)).toString('utf8')));
  // An older job may be waiting behind a newer public release in the shared mutex.
  if (record.source.commit !== context.commit || record.build.artifactID !== context.artifactID) {
    return { status: 'superseded', version: plan.version, latestVersion: record.version };
  }
  ensure(record.version === plan.version && record.release.tag === plan.tag && record.artifact.sha256 === plan.assets[0].sha256 &&
    record.artifact.bytes === plan.assets[0].size && !!plan.assets[0].path, 'Public download is not the verified candidate');
  const publicKey = (await readFile(join(root, 'src-tauri/updater.pub'), 'utf8')).trim();
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  ensure(config.identifier === 'com.rivloom.desktop' && config.plugins?.updater?.pubkey === publicKey &&
    isDeepStrictEqual(config.plugins?.updater?.endpoints, [updaterEndpoint]), 'Updater trust configuration differs from the release');
  const notesPath = join(root, 'docs/releases', `${plan.version}.md`);
  const notesStat = await lstat(notesPath);
  ensure(notesStat.isFile() && !notesStat.isSymbolicLink() && notesStat.size > 0 && notesStat.size <= 12_000, 'Release update notes are missing or too large');
  const notes = (await readFile(notesPath, 'utf8')).trim();
  const directory = join(root, 'test-results/updater');
  const manifest = await createSignedUpdate({ root, directory: join(directory, 'staging'), artifactPath: plan.assets[0].path!, record, notes, publicKey, environment });
  // Contains only public signatures and metadata, never the signing key.
  await writeFile(join(directory, 'latest.json'), encode(manifest));
  return publishSignedUpdate(manifest, publicKey, services);
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const directory = join(root, 'test-results/updater'); await mkdir(directory, { recursive: true });
  let result: Record<string, unknown>;
  try {
    ensure(process.env.RIVLOOM_UPDATES_ENABLED === 'true', 'Updater publication is not enabled');
    const context = releaseContext(process.env);
    ensure(context.repository === 'rivloom/rivloom-desktop', 'Unexpected updater repository');
    const services: UpdaterServices = { storage: r2Transport(r2Configuration(process.env)), publicRead: (key) =>
      fetch(`${DOWNLOAD_ORIGIN}/${encodedObjectKey(key)}`, { redirect: 'error', headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(240_000) }) };
    result = { schemaVersion: 1, ...await synchronizeUpdater(root, context, services, process.env) };
  } catch { result = { schemaVersion: 1, status: 'failed', error: 'Signed update publication failed; the previous channel was not intentionally replaced.' }; process.exitCode = 1; }
  await writeFile(join(directory, 'result.json'), encode(result));
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
