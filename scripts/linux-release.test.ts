import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './ci-r2-storage.ts';
import { checkLinuxProvenance, linuxContext, linuxPromotion, prepareLinuxRelease, publishLinux, synchronizeLinux } from './linux-release.ts';
import type { ReleaseTransport } from './ci-release.ts';
import type { ObjectTransport } from './ci-r2-storage.ts';
import { linuxChecksums, parseLinuxDownloadRecord, type LinuxDownloadRecord } from './linux-download-record.ts';

const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'rivloom/rivloom-desktop', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '200', RIVLOOM_LINUX_BUILD_RUN_ID: '100', RIVLOOM_LINUX_X64_ARTIFACT_ID: '101', RIVLOOM_LINUX_ARM64_ARTIFACT_ID: '102' };
async function packageFixture(root: string) {
  const context = linuxContext({ ...environment, RIVLOOM_LINUX_ARM64_ARTIFACT_ID: undefined });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.18' }));
  await mkdir(join(root, 'shared'));
  const lockBytes = await readFile(resolve(import.meta.dirname, '../shared/engine-source-linux.json'));
  await writeFile(join(root, 'shared/engine-source-linux.json'), lockBytes);
  const lock = JSON.parse(lockBytes.toString());
  const recipeFiles = Object.entries(lock.recipe.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const engineSource = { commit: lock.commit, tree: lock.tree, lockSha256: digest(lockBytes), receiptSha256: 'e'.repeat(64), recipeSha256: digest(Buffer.from(JSON.stringify(recipeFiles))) };
  const opencode = { version: lock.version, sha256: 'b'.repeat(64), source: `${lock.repository}#${lock.commit}` };
  const directory = join(root, 'test-results/linux/x64'); await mkdir(directory, { recursive: true });
  const fileName = 'Rivloom_0.1.18_linux_x64.tar.gz', bytes = Buffer.alloc(65); bytes.set([31, 139, 8]);
  const artifact = { fileName, bytes: bytes.length, sha256: digest(bytes) }, runtimeManifestSha256 = 'd'.repeat(64);
  const build = { schemaVersion: 1, kind: 'rivloom-linux-build', version: '0.1.18', sourceCommit: context.commit, sourceDirty: false, runID: context.runID, target: { platform: 'linux', arch: 'x64' }, artifact, runtimeManifestSha256, nodeVersion: '24.19.0', engineVersion: lock.version, opencode, engineSource };
  const smoke = { schemaVersion: 1, status: 'passed', sourceCommit: context.commit, sourceDirty: false, runID: context.runID, arch: 'x64', artifact, runtimeManifestSha256, engineVersion: lock.version, opencode, engineSource, checks: { extractedFiles: 10, node: true, opencode: true, engineSource: true, engineRecipe: true, engineElf: true, engineLicense: true, startup: true, restartIdentity: true, sigterm: true, privateData: true, authentication: true, noTokenRejected: true, originRejected: true, hostRejected: true, noGui: true, defaultExecutionDisabled: true, controlCleanup: true }, environment: { platform: 'linux', arch: 'x64', node: '24.19.0' } };
  await writeFile(join(directory, fileName), bytes);
  await writeFile(join(directory, 'build.json'), JSON.stringify(build));
  await writeFile(join(directory, 'smoke.json'), JSON.stringify(smoke));
  return { context, directory, build, smoke, fileName };
}
function record(commit = 'a'.repeat(40), runID = '100', arm64 = true): LinuxDownloadRecord {
  const tag = `linux-v0.1.18-${commit.slice(0, 12)}-${runID}`, base = `https://downloads.rivloom.com/releases/linux/${tag}`;
  const platforms = Object.fromEntries((arm64 ? ['linux-x64', 'linux-arm64'] : ['linux-x64']).map(platform => {
    const fileName = `Rivloom_0.1.18_${platform.replace('-', '_')}.tar.gz`;
    return [platform, { fileName, bytes: 100, sha256: 'b'.repeat(64), url: `${base}/${fileName}` }];
  })) as LinuxDownloadRecord['platforms'];
  const sums = linuxChecksums({ platforms });
  return parseLinuxDownloadRecord({ schemaVersion: 1, kind: 'rivloom-linux-download', status: 'published', version: '0.1.18', product: { kind: 'headless', identifier: 'com.rivloom.headless' }, source: { commit }, build: { runID, artifactIDs: { 'linux-x64': '101', ...(arm64 ? { 'linux-arm64': '102' } : {}) } }, release: { id: 100, tag, publishedAt: '2026-09-18T00:00:00Z' }, platforms, checksum: { fileName: 'SHA256SUMS.txt', bytes: sums.length, sha256: digest(sums), url: `${base}/SHA256SUMS.txt` }, verification: { ci: 'passed', startup: 'passed', publicDownload: 'passed', checkedAt: '2026-09-18T00:01:00Z' } });
}
test('Linux release context rejects PR/fork/local provenance and reused artifact IDs', () => {
  assert.equal(linuxContext(environment).runID, '100');
  for (const change of [{ GITHUB_ACTIONS: '' }, { GITHUB_REPOSITORY: 'fork/rivloom-desktop' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request' }, { RIVLOOM_LINUX_ARM64_ARTIFACT_ID: '101' }]) assert.throws(() => linuxContext({ ...environment, ...change }));
});
test('Linux public records require x64, exact host, matching optional architecture evidence and bound checksums', () => {
  const good = record(); assert.deepEqual(parseLinuxDownloadRecord(good), good);
  for (const mutate of [(r: any) => delete r.platforms['linux-arm64'], (r: any) => r.verification.startup = 'pending', (r: any) => r.platforms['linux-x64'].url = 'https://evil.example/file', (r: any) => r.checksum.sha256 = '0'.repeat(64), (r: any) => r.platforms['linux-x64'].fileName += '\n']) {
    const invalid = structuredClone(good); mutate(invalid); assert.throws(() => parseLinuxDownloadRecord(invalid));
  }
});
test('Linux x64-only publication is valid while missing x64 or mismatched ARM64 metadata fails', () => {
  const x64 = record('a'.repeat(40), '100', false);
  assert.deepEqual(Object.keys(x64.platforms), ['linux-x64']);
  assert.equal(linuxChecksums(x64).split('\n').filter(Boolean).length, 1);
  assert.deepEqual(linuxContext({ ...environment, RIVLOOM_LINUX_ARM64_ARTIFACT_ID: undefined }).artifactIDs, { 'linux-x64': '101' });
  for (const mutate of [(r: any) => delete r.platforms['linux-x64'], (r: any) => r.build.artifactIDs['linux-arm64'] = '102', (r: any) => r.platforms['linux-arm64'] = null]) {
    const invalid = structuredClone(x64); mutate(invalid); assert.throws(() => parseLinuxDownloadRecord(invalid));
  }
});
test('Linux provenance cannot publish running, failed or mismatched build runs', async () => {
  const context = linuxContext(environment);
  const run = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: context.commit, head_branch: 'main', event: 'push', path: '.github/workflows/linux-ci.yml', repository: { full_name: context.repository }, head_repository: { full_name: context.repository } };
  const transport = (override: object = {}) => async ({ url }: { url: string }) => {
    if (url.endsWith('/actions/runs/100')) return { status: 200, body: { ...run, ...override } };
    const arm = url.endsWith('/102'), arch = arm ? 'arm64' : 'x64';
    return { status: 200, body: { id: arm ? 102 : 101, expired: false, name: `rivloom-linux-${arch}-${context.commit}-100-1`, workflow_run: { id: 100, head_sha: context.commit, head_branch: 'main' } } };
  };
  await checkLinuxProvenance(context, transport());
  for (const invalid of [{ status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { head_sha: 'b'.repeat(40) }]) await assert.rejects(checkLinuxProvenance(context, transport(invalid)));
});
test('Linux latest cannot regress its source or run and conflicting immutable records fail', async () => {
  const previous = record(), newer = record('c'.repeat(40), '110');
  assert.equal(await linuxPromotion(previous, record('a'.repeat(40), '99'), async () => ({})), 'superseded');
  assert.equal(await linuxPromotion(previous, newer, async () => ({ base_commit: { sha: previous.source.commit }, status: 'behind' })), 'superseded');
  assert.equal(await linuxPromotion(previous, newer, async () => ({ base_commit: { sha: previous.source.commit }, status: 'ahead', merge_base_commit: { sha: previous.source.commit }, ahead_by: 1, behind_by: 0 })), 'promote');
  const conflicting = structuredClone(previous); conflicting.build.artifactIDs['linux-arm64'] = '999';
  await assert.rejects(linuxPromotion(previous, conflicting, async () => ({})));
});
test('Linux publication refuses dirty-source or incomplete native smoke evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivloom-linux-release-'));
  try {
    const { context, directory } = await packageFixture(root);
    assert.equal((await prepareLinuxRelease(root, context)).assets.length, 2);
    await assert.rejects(prepareLinuxRelease(root, linuxContext(environment)), /ARM64 is unavailable/);
    const path = join(directory, 'build.json');
    const valid = await readFile(path, 'utf8');
    await writeFile(path, JSON.stringify({ ...JSON.parse(valid), sourceDirty: true }));
    await assert.rejects(prepareLinuxRelease(root, context), /committed source/);
    await writeFile(path, valid);
    const smokePath = join(directory, 'smoke.json');
    const originalSmoke = await readFile(smokePath, 'utf8'), smoke = JSON.parse(originalSmoke);
    smoke.checks.hostRejected = false;
    await writeFile(smokePath, JSON.stringify(smoke));
    await assert.rejects(prepareLinuxRelease(root, context));
    await writeFile(smokePath, originalSmoke);
    await writeFile(join(root, 'test-results/linux/x64/Rivloom_0.1.18_linux_x64.tar.gz'), Buffer.alloc(80));
    await assert.rejects(prepareLinuxRelease(root, context));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux publication binds the reviewed source recipe and actual engine to native smoke evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivloom-linux-source-gate-'));
  try {
    const fixture = await packageFixture(root);
    for (const mutate of [
      (build: any, smoke: any) => { build.engineVersion = smoke.engineVersion = '1.18.25'; },
      (build: any, smoke: any) => { build.engineSource.commit = smoke.engineSource.commit = 'a'.repeat(40); },
      (build: any, smoke: any) => { build.engineSource.recipeSha256 = smoke.engineSource.recipeSha256 = 'a'.repeat(64); },
      (build: any, smoke: any) => { build.engineSource.lockSha256 = smoke.engineSource.lockSha256 = 'a'.repeat(64); },
      (build: any, smoke: any) => { build.engineSource.receiptSha256 = smoke.engineSource.receiptSha256 = '0'.repeat(64); },
      (_build: any, smoke: any) => { smoke.engineSource.receiptSha256 = 'a'.repeat(64); },
      (_build: any, smoke: any) => { smoke.opencode.sha256 = 'a'.repeat(64); },
      (build: any, smoke: any) => { build.opencode.source = smoke.opencode.source = 'https://registry.npmjs.org/opencode-linux-x64-baseline'; },
      (_build: any, smoke: any) => { smoke.checks.engineElf = false; },
      (_build: any, smoke: any) => { delete smoke.checks.engineRecipe; },
    ]) {
      const build = structuredClone(fixture.build), smoke = structuredClone(fixture.smoke);
      mutate(build, smoke);
      await writeFile(join(fixture.directory, 'build.json'), JSON.stringify(build));
      await writeFile(join(fixture.directory, 'smoke.json'), JSON.stringify(smoke));
      await assert.rejects(prepareLinuxRelease(root, fixture.context));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('x64 publication and R2 synchronization preserve Windows entries and reject public corruption before promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivloom-linux-publish-'));
  const context = linuxContext({ ...environment, RIVLOOM_LINUX_ARM64_ARTIFACT_ID: undefined });
  try {
    await packageFixture(root);
    let release: Record<string, any> | undefined;
    const assets: Record<string, any>[] = [];
    const transport: ReleaseTransport = async request => {
      const url = new URL(request.url), path = url.pathname;
      if (path.endsWith('/actions/runs/100')) return { status: 200, body: { head_sha: context.commit, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/linux-ci.yml', run_attempt: 1, repository: { full_name: context.repository }, head_repository: { full_name: context.repository } } };
      if (path.endsWith('/actions/artifacts/101')) return { status: 200, body: { id: 101, expired: false, name: `rivloom-linux-x64-${context.commit}-100-1`, workflow_run: { id: 100, head_sha: context.commit, head_branch: 'main' } } };
      if (path.includes('/git/ref/tags/')) return release && !release.draft ? { status: 200, body: { object: { type: 'commit', sha: context.commit } } } : { status: 404, body: null };
      if (path.includes('/releases/tags/')) return { status: release ? 200 : 404, body: release ?? null };
      if (request.method === 'POST' && path.endsWith('/releases')) { release = { ...request.json, id: 345 }; return { status: 201, body: release }; }
      if (request.asset) { const item = { id: assets.length + 1, name: request.asset.name, size: request.asset.size, digest: `sha256:${request.asset.sha256}`, state: 'uploaded' }; assets.push(item); return { status: 201, body: item }; }
      if (path.endsWith('/releases/345/assets')) return { status: 200, body: assets };
      if (path.includes('/releases/assets/')) return { status: 200, body: assets.find(item => path.endsWith(`/${item.id}`)) };
      if (request.method === 'PATCH') release = { ...release, ...request.json, published_at: '2026-09-18T00:00:00Z' };
      if (path.endsWith('/releases/345')) return { status: 200, body: release };
      throw new Error(`Unexpected fake GitHub request: ${request.method} ${path}`);
    };
    const report = await publishLinux(root, context, transport); assert.equal(report.status, 'published'); assert.equal(assets.length, 2);
    await mkdir(join(root, 'test-results/linux-release')); await writeFile(join(root, 'test-results/linux-release/release.json'), JSON.stringify(report));
    const objects = new Map<string, Buffer>([['releases/latest.json', Buffer.from('Windows unchanged')], ['updates/stable/latest.json', Buffer.from('Windows signatures unchanged')]]);
    const storage: ObjectTransport = async request => {
      assert(request.key.startsWith('releases/linux/'), 'Linux must never read or write Windows entries');
      const old = objects.get(request.key);
      if (request.method === 'PUT') {
        if (request.condition && 'absent' in request.condition && old) return new Response(null, { status: 412 });
        const body = request.payload!.path ? await readFile(request.payload!.path) : request.payload!.body!;
        assert.equal(digest(body), request.payload!.sha256); objects.set(request.key, body); return new Response(null, { status: 200 });
      }
      if (!old) return new Response(null, { status: 404 });
      return new Response(request.method === 'GET' ? new Uint8Array(old) : null, { status: 200, headers: { 'content-length': String(old.length), 'x-amz-meta-rivloom-sha256': digest(old), etag: '"same"' } });
    };
    let hooks = 0;
    const publicRead = async (key: string) => new Response(new Uint8Array(objects.get(key)!), { status: 200 });
    await assert.rejects(synchronizeLinux(root, context, transport, storage, async key => key.endsWith('.tar.gz') ? new Response('corrupt') : publicRead(key), async () => { hooks++; }));
    assert.equal(objects.has('releases/linux/latest.json'), false); assert.equal(hooks, 0);
    assert.equal((await synchronizeLinux(root, context, transport, storage, publicRead, async () => { hooks++; })).status, 'synced');
    assert.equal(hooks, 1);
    assert.deepEqual(Object.keys(parseLinuxDownloadRecord(JSON.parse(objects.get('releases/linux/latest.json')!.toString())).platforms), ['linux-x64']);
    assert.equal(objects.get('releases/latest.json')!.toString(), 'Windows unchanged');
    assert.equal(objects.get('updates/stable/latest.json')!.toString(), 'Windows signatures unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
