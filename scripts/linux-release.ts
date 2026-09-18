// Independent Linux publication. This module never writes Windows downloads or updater records.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubTransport, type ReleaseTransport } from './ci-release.ts';
import { boundedBytes, digest, discard, encodedObjectKey, r2Configuration, r2Transport, responseDigest, strongEtag, type ObjectTransport } from './ci-r2-storage.ts';
import { pagesDeployHook } from './ci-website-download.ts';
import { DOWNLOAD_ORIGIN } from './download-record.ts';
import { linuxPlatforms, parseLinuxDownloadRecord, type LinuxDownloadRecord, type LinuxPlatform } from './linux-download-record.ts';

type Json = Record<string, any>;
type Progress = (stage: string) => void;
export interface LinuxContext { repository: 'rivloom/rivloom-desktop'; commit: string; runID: string; artifactIDs: { 'linux-x64': string; 'linux-arm64'?: string } }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export function linuxContext(env: NodeJS.ProcessEnv): LinuxContext {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'rivloom/rivloom-desktop');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Linux publication requires an explicit manual dispatch');
  // Publication is intentionally separate from the read-only build workflow.
  // This is the completed build's run ID, never the currently executing publisher's ID.
  const commit = env.GITHUB_SHA || '', runID = env.RIVLOOM_LINUX_BUILD_RUN_ID || '';
  const artifactIDs: LinuxContext['artifactIDs'] = { 'linux-x64': env.RIVLOOM_LINUX_X64_ARTIFACT_ID || '', ...(env.RIVLOOM_LINUX_ARM64_ARTIFACT_ID ? { 'linux-arm64': env.RIVLOOM_LINUX_ARM64_ARTIFACT_ID } : {}) };
  assert.match(commit, /^(?!0{40}$)[0-9a-f]{40}$/);
  for (const id of [runID, ...Object.values(artifactIDs)]) assert(/^[1-9]\d{0,15}$/.exec(id)?.[0] === id && positive(Number(id)));
  if (artifactIDs['linux-arm64']) assert.notEqual(artifactIDs['linux-x64'], artifactIDs['linux-arm64']);
  return { repository: 'rivloom/rivloom-desktop', commit, runID, artifactIDs };
}
export const releasePlatforms = (context: LinuxContext): LinuxPlatform[] => linuxPlatforms.filter(platform => context.artifactIDs[platform] !== undefined);
async function jsonFile(path: string) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 ** 2, 'Invalid Linux evidence file');
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}
export async function prepareLinuxRelease(root: string, context: LinuxContext) {
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = source.version as string;
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.[0] === version);
  const assets = [];
  for (const platform of releasePlatforms(context)) {
    const arch = platform.slice(6), directory = join(root, 'test-results/linux', arch);
    const fileName = `Rivloom_${version}_linux_${arch}.tar.gz`;
    assert.deepEqual((await readdir(directory)).sort(), [fileName, 'build.json', 'smoke.json'].sort(), 'Unexpected downloaded artifact files');
    const build = await jsonFile(join(directory, 'build.json'));
    assert.equal(build.schemaVersion, 1); assert.equal(build.kind, 'rivloom-linux-build');
    assert.equal(build.version, version); assert.equal(build.sourceCommit, context.commit); assert.equal(build.runID, context.runID);
    assert.equal(build.sourceDirty, false, 'Linux publication requires committed source');
    assert.deepEqual(build.target, { platform: 'linux', arch });
    assert.equal(build.nodeVersion, '24.19.0'); assert.equal(build.engineVersion, '1.18.25');
    assert.match(build.runtimeManifestSha256, /^[0-9a-f]{64}$/);
    const smoke = await jsonFile(join(directory, 'smoke.json'));
    assert.equal(smoke.schemaVersion, 1); assert.equal(smoke.status, 'passed'); assert.equal(smoke.sourceCommit, context.commit);
    assert.equal(smoke.runID, context.runID); assert.equal(smoke.arch, arch); assert.equal(smoke.runtimeManifestSha256, build.runtimeManifestSha256);
    assert.equal(smoke.sourceDirty, false);
    assert.equal(smoke.environment.platform, 'linux'); assert.equal(smoke.environment.arch, arch); assert.equal(smoke.environment.node, '24.19.0');
    assert(positive(smoke.checks.extractedFiles));
    for (const key of ['node', 'opencode', 'startup', 'restartIdentity', 'sigterm', 'privateData', 'authentication', 'noTokenRejected', 'originRejected', 'hostRejected', 'noGui', 'defaultExecutionDisabled', 'controlCleanup']) assert.equal(smoke.checks[key], true);
    const path = join(directory, fileName), info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink() && info.size > 64 && info.size <= 2 * 1024 ** 3);
    const bytes = await readFile(path);
    assert(bytes.subarray(0, 3).equals(Buffer.from([31, 139, 8])), 'Linux artifact must be gzip');
    const artifact = { fileName, bytes: bytes.length, sha256: digest(bytes) };
    assert.deepEqual(build.artifact, artifact); assert.deepEqual(smoke.artifact, artifact);
    assets.push({ platform, name: fileName, size: bytes.length, sha256: artifact.sha256, path });
  }
  const sums = Buffer.from(assets.map(item => `${item.sha256}  ${item.name}\n`).join(''));
  const tag = `linux-v${version}-${context.commit.slice(0, 12)}-${context.runID}`;
  return { version, tag, title: `Rivloom Linux ${version}`, body: `Rivloom headless Linux execution node (${releasePlatforms(context).join(', ')}).\n\nSource: ${context.commit}\nNative package startup/restart/shutdown checks passed for every attached architecture. No physical LAN or real model acceptance is implied.\nVerify SHA256SUMS.txt before extracting. This is a manual tar.gz download, separate from the Windows updater.`, assets: [...assets, { platform: null, name: 'SHA256SUMS.txt', size: sums.length, sha256: digest(sums), bytes: sums }] };
}
type Plan = Awaited<ReturnType<typeof prepareLinuxRelease>>;
function api(context: LinuxContext, transport: ReleaseTransport) {
  return async (method: 'GET' | 'POST' | 'PATCH', path: string, json?: Json, missing = false) => {
    const response = await transport({ method, url: `https://api.github.com/repos/${context.repository}${path}`, ...(json ? { json } : {}) });
    if (missing && response.status === 404) return null;
    assert([200, 201].includes(response.status), `Linux GitHub ${method} failed (${response.status})`);
    return response.body;
  };
}
export async function checkLinuxProvenance(context: LinuxContext, transport: ReleaseTransport) {
  const request = api(context, transport);
  const run = await request('GET', `/actions/runs/${context.runID}`);
  assert.equal(run.head_sha, context.commit); assert.equal(run.head_branch, 'main');
  assert.equal(run.status, 'completed', 'Linux build must be completed before publication');
  assert.equal(run.conclusion, 'success', 'Linux build must have succeeded before publication');
  assert.equal(run.repository.full_name, context.repository); assert.equal(run.head_repository.full_name, context.repository);
  assert(['push', 'workflow_dispatch'].includes(run.event));
  assert(['.github/workflows/linux-ci.yml', '.github/workflows/linux-ci.yml@main'].includes(run.path));
  for (const platform of releasePlatforms(context)) {
    const artifact = await request('GET', `/actions/artifacts/${context.artifactIDs[platform]}`);
    assert.equal(String(artifact.id), context.artifactIDs[platform]); assert.equal(artifact.expired, false);
    assert.equal(artifact.workflow_run.id, Number(context.runID)); assert.equal(artifact.workflow_run.head_sha, context.commit);
    assert.equal(artifact.workflow_run.head_branch, 'main');
    assert.equal(artifact.name, `rivloom-${platform}-${context.commit}-${context.runID}-${run.run_attempt}`);
  }
}
async function checkTag(context: LinuxContext, transport: ReleaseTransport, tag: string, required: boolean) {
  const request = api(context, transport), ref = await request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`, undefined, !required);
  if (!ref) return;
  let object = ref.object;
  for (let i = 0; i < 6; i++) {
    assert(/^[0-9a-f]{40}$/.test(object?.sha));
    if (object.type === 'commit') { assert.equal(object.sha, context.commit); return; }
    assert.equal(object.type, 'tag'); object = (await request('GET', `/git/tags/${object.sha}`)).object;
  }
  throw new Error('Linux tag nesting exceeds limit');
}
async function inspectRelease(context: LinuxContext, transport: ReleaseTransport, plan: Plan, release: Json, complete: boolean) {
  assert(positive(release.id)); assert.equal(release.tag_name, plan.tag); assert.equal(release.target_commitish, context.commit);
  assert.equal(release.name, plan.title); assert.equal(release.body, plan.body); assert.equal(release.prerelease, false);
  assert.equal(typeof release.draft, 'boolean');
  const request = api(context, transport), assets = await request('GET', `/releases/${release.id}/assets?per_page=100`) as Json[];
  assert(Array.isArray(assets) && assets.length <= plan.assets.length && new Set(assets.map(a => a.name)).size === assets.length);
  if (complete) assert.equal(assets.length, plan.assets.length);
  for (const asset of assets) {
    const expected = plan.assets.find(item => item.name === asset.name); assert(expected && positive(asset.id));
    for (const item of [asset, await request('GET', `/releases/assets/${asset.id}`)]) {
      assert.equal(item.name, expected.name); assert.equal(item.size, expected.size); assert.equal(item.digest, `sha256:${expected.sha256}`); assert.equal(item.state, 'uploaded');
    }
  }
  await checkTag(context, transport, plan.tag, !release.draft);
  return new Set(assets.map(item => item.name));
}
export async function publishLinux(root: string, context: LinuxContext, transport: ReleaseTransport, progress: Progress = () => {}) {
  progress('prepare');
  const plan = await prepareLinuxRelease(root, context);
  progress('provenance');
  await checkLinuxProvenance(context, transport);
  progress('release-assets');
  const request = api(context, transport);
  let release = await request('GET', `/releases/tags/${encodeURIComponent(plan.tag)}`, undefined, true);
  if (!release) {
    await checkTag(context, transport, plan.tag, false);
    release = await request('POST', '/releases', { tag_name: plan.tag, target_commitish: context.commit, name: plan.title, body: plan.body, draft: true, prerelease: false, make_latest: 'false' });
    assert.equal(release.draft, true);
  }
  const present = await inspectRelease(context, transport, plan, release, !release.draft);
  if (release.draft) {
    for (const asset of plan.assets) if (!present.has(asset.name)) {
      const uploaded = await transport({ method: 'POST', url: `https://uploads.github.com/repos/${context.repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, asset });
      assert.equal(uploaded.status, 201); assert.equal(uploaded.body.digest, `sha256:${asset.sha256}`);
    }
    await inspectRelease(context, transport, plan, release, true);
    release = await request('PATCH', `/releases/${release.id}`, { draft: false, prerelease: false, make_latest: 'false' });
  }
  release = await request('GET', `/releases/${release.id}`); assert.equal(release.draft, false);
  await inspectRelease(context, transport, plan, release, true);
  return { schemaVersion: 1, status: 'published', releaseID: release.id, tag: plan.tag, sourceCommit: context.commit, runID: context.runID, artifactIDs: context.artifactIDs, publishedAt: release.published_at };
}
export async function linuxPromotion(previous: LinuxDownloadRecord | null, next: LinuxDownloadRecord, compare: (path: string) => Promise<Json>) {
  if (!previous) return 'promote';
  const a = previous.version.split('+')[0].split('.').map(Number), b = next.version.split('+')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (b[i] < a[i]) return 'superseded'; if (b[i] > a[i]) break; }
  if (previous.source.commit === next.source.commit) {
    if (Number(previous.build.runID) > Number(next.build.runID)) return 'superseded';
    if (previous.build.runID === next.build.runID) {
      assert.deepEqual({ ...previous, verification: null }, { ...next, verification: null }, 'Linux immutable run identity conflicts');
      return 'reuse';
    }
    return 'promote';
  }
  const result = await compare(`/compare/${previous.source.commit}...${next.source.commit}?per_page=1`);
  assert.equal(result.base_commit?.sha, previous.source.commit);
  if (['behind', 'diverged'].includes(result.status)) return 'superseded';
  assert.equal(result.status, 'ahead'); assert.equal(result.merge_base_commit?.sha, previous.source.commit);
  assert(positive(result.ahead_by)); assert.equal(result.behind_by, 0);
  return 'promote';
}
export async function synchronizeLinux(root: string, context: LinuxContext, transport: ReleaseTransport, storage: ObjectTransport, publicRead: (key: string) => Promise<Response>, deploy: () => Promise<void>, progress: Progress = () => {}) {
  progress('prepare');
  const plan = await prepareLinuxRelease(root, context), request = api(context, transport);
  progress('provenance');
  await checkLinuxProvenance(context, transport);
  progress('release-assets');
  const report = await jsonFile(join(root, 'test-results/linux-release/release.json'));
  assert.equal(report.status, 'published'); assert.equal(report.sourceCommit, context.commit); assert.equal(report.runID, context.runID); assert.deepEqual(report.artifactIDs, context.artifactIDs);
  const release = await request('GET', `/releases/${report.releaseID}`); assert.equal(release.draft, false);
  await inspectRelease(context, transport, plan, release, true);
  const base = `releases/linux/${plan.tag}`;
  for (const asset of plan.assets) {
    progress('storage');
    const key = `${base}/${asset.name}`, payload = { bytes: asset.size, sha256: asset.sha256, ...('path' in asset ? { path: asset.path } : { body: asset.bytes }) };
    let existing = await storage({ method: 'HEAD', key });
    if (existing.status === 404) {
      await discard(existing);
      const written = await storage({ method: 'PUT', key, payload, condition: { absent: true }, contentType: 'application/octet-stream', contentDisposition: `attachment; filename="${asset.name}"`, cacheControl: 'public, max-age=31536000, immutable' });
      const status = written.status; await discard(written); assert([200, 409, 412].includes(status));
      existing = await storage({ method: 'HEAD', key });
    }
    assert.equal(existing.status, 200); assert.equal(existing.headers.get('content-length'), String(asset.size)); assert.equal(existing.headers.get('x-amz-meta-rivloom-sha256'), asset.sha256); await discard(existing);
    progress('public-download');
    const response = await publicRead(key); assert.equal(response.status, 200); assert.equal(await responseDigest(response, asset.size), asset.sha256);
  }
  const file = (asset: Plan['assets'][number]) => ({ fileName: asset.name, bytes: asset.size, sha256: asset.sha256, url: `${DOWNLOAD_ORIGIN}/${base}/${asset.name}` });
  const record = parseLinuxDownloadRecord({ schemaVersion: 1, kind: 'rivloom-linux-download', status: 'published', version: plan.version, product: { kind: 'headless', identifier: 'com.rivloom.headless' }, source: { commit: context.commit }, build: { runID: context.runID, artifactIDs: context.artifactIDs }, release: { id: release.id, tag: plan.tag, publishedAt: release.published_at }, platforms: Object.fromEntries(plan.assets.filter(asset => asset.platform).map(asset => [asset.platform, file(asset)])), checksum: file(plan.assets.at(-1)!), verification: { ci: 'passed', startup: 'passed', publicDownload: 'passed', checkedAt: new Date().toISOString() } });
  const key = 'releases/linux/latest.json';
  progress('latest');
  let selected: LinuxDownloadRecord | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await storage({ method: 'GET', key });
    assert([200, 404].includes(current.status));
    const etag = current.status === 200 ? strongEtag(current.headers.get('etag')) : null;
    const previous = current.status === 200 ? parseLinuxDownloadRecord(JSON.parse((await boundedBytes(current, 64 * 1024)).toString())) : null;
    if (!previous) await discard(current);
    const action = await linuxPromotion(previous, record, path => request('GET', path));
    if (action === 'superseded') return { status: 'superseded', tag: plan.tag, hookTriggered: false };
    if (action === 'reuse') { selected = previous!; break; }
    const bytes = encode(record);
    const response = await storage({ method: 'PUT', key, payload: { bytes: bytes.length, sha256: digest(bytes), body: bytes }, condition: etag ? { etag } : { absent: true }, contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
    const status = response.status; await discard(response); if ([409, 412].includes(status)) continue;
    assert.equal(status, 200); selected = record; break;
  }
  assert(selected, 'Linux latest conditional write exhausted');
  progress('public-latest');
  const response = await publicRead(key); assert.equal(response.status, 200);
  assert.deepEqual(parseLinuxDownloadRecord(JSON.parse((await boundedBytes(response, 64 * 1024)).toString())), selected);
  progress('hook');
  await deploy();
  return { status: 'synced', tag: selected.release.tag, hookTriggered: true, scope: 'Pages hook accepted; deployed website and physical Linux acceptance still require independent verification.' };
}
async function main() {
  const root = resolve(import.meta.dirname, '..'), mode = process.argv[2];
  assert(['verify', 'publish', 'website'].includes(mode));
  const output = join(root, mode === 'publish' ? 'test-results/linux-release' : mode === 'verify' ? 'test-results/linux-provenance' : 'test-results/linux-website');
  await mkdir(output, { recursive: true });
  let stage = 'configuration';
  const progress: Progress = value => { stage = value; console.log(`Linux ${mode} stage: ${stage}`); };
  let report: Json = { status: 'failed' };
  try {
    const context = linuxContext(process.env);
    progress('source-checkout');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), context.commit);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim(), '');
    const transport = githubTransport(process.env.GITHUB_TOKEN || '');
    if (mode === 'verify') { progress('provenance'); await checkLinuxProvenance(context, transport); report = { schemaVersion: 1, status: 'passed', sourceCommit: context.commit, runID: context.runID, artifactIDs: context.artifactIDs }; }
    else if (mode === 'publish') report = await publishLinux(root, context, transport, progress);
    else {
      const hook = pagesDeployHook(process.env.RIVLOOM_PAGES_DEPLOY_HOOK);
      report = await synchronizeLinux(root, context, transport, r2Transport(r2Configuration(process.env)), key => fetch(`${DOWNLOAD_ORIGIN}/${encodedObjectKey(key)}`, { redirect: 'error', headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(240_000) }), async () => { const response = await fetch(hook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000) }); const ok = response.ok; await discard(response); assert(ok, 'Pages deployment request failed'); }, progress);
    }
    report.stage = 'complete';
  } catch { report = { status: 'failed', stage, error: 'Linux release verification failed; inspect the reported stage without exposing credentials.' }; process.exitCode = 1; }
  await writeFile(join(output, mode === 'publish' ? 'release.json' : 'result.json'), encode(report));
  console.log(`Linux ${mode}: ${report.status}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
