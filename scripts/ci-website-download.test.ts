import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { preparePreview, type ReleaseContext } from './ci-preview-release.ts';
import { digest, type ObjectRequest } from './ci-r2-storage.ts';
import {
  pagesDeployHook,
  synchronizeWebsiteDownload,
  websiteServices,
  type WebsiteServices,
} from './ci-website-download.ts';
import {
  parsePreviewDownloadRecord,
  PREVIEW_DOWNLOAD_ORIGIN,
  type PreviewDownloadRecord,
} from './preview-download-record.ts';

const context: ReleaseContext = {
  repository: 'rivloom/rivloom-desktop',
  commit: '1'.repeat(40),
  runID: '12345',
  artifactID: '67890',
};
const checkedAt = '2026-09-05T09:00:00.000Z';
const publishedAt = '2026-09-05T08:00:00Z';
const latestKey = 'previews/latest.json';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const response = (body: Buffer | null, status = 200, headers?: HeadersInit) =>
  new Response(body ? Uint8Array.from(body) : null, { status, headers });

async function fixture() {
  const parent = resolve(import.meta.dirname, '..', 'test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'website-download-selftest-'));
  const directory = join(root, 'test-results', 'candidate');
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'src-tauri'));
  await mkdir(join(root, 'test-results', 'preview-release'));
  await writeFile(join(root, 'package.json'), encode({ version: '0.1.3' }));
  await writeFile(join(root, 'package-lock.json'), 'synthetic npm lock');
  await writeFile(join(root, 'src-tauri', 'Cargo.lock'), 'synthetic cargo lock');
  const product = {
    kind: 'conversation-preview',
    identifier: 'com.rivloom.conversationpreview',
    version: '0.1.3',
  };
  const manifest = {
    schemaVersion: 1,
    product,
    target: { platform: 'win32', arch: 'x64' },
    inputs: {
      packageLockSha256: digest('synthetic npm lock'),
      cargoLockSha256: digest('synthetic cargo lock'),
    },
    node: { version: '24.19.0', sha256: 'a'.repeat(64) },
    opencode: { version: '1.18.25', sha256: 'b'.repeat(64) },
    documents: [],
    packages: [{}],
    notices: [{}],
  };
  const runtime = {
    schemaVersion: 1,
    status: 'passed',
    product,
    target: manifest.target,
    inputs: manifest.inputs,
    binaries: { node: manifest.node, opencode: manifest.opencode },
    documents: [],
    packages: 1,
    licenses: { files: 1 },
  };
  const bytes = Buffer.alloc(512);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.write('PE\0\0', 128);
  bytes.write('Synthetic, non-executable test structure', 180);
  const installerName = 'Rivloom UI Preview_0.1.3_x64-setup.exe';
  const candidate = {
    schemaVersion: 1,
    status: 'candidate',
    profile: product.kind,
    product,
    target: 'x86_64-pc-windows-msvc',
    source: {
      commit: context.commit,
      expectedCommit: context.commit,
      workingTree: 'clean',
      node: '24.19.0',
      rust: '1.98.1',
      cargo: '1.98.1',
      refType: 'branch',
      refName: 'main',
    },
    artifact: { fileName: installerName, bytes: bytes.length, sha256: digest(bytes) },
    runtimeManifestSha256: digest(encode(manifest)),
    runtimeTree: {
      algorithm: 'sha256-path-kind-size-content-v1',
      sha256: 'c'.repeat(64),
      files: 1,
      directories: 1,
      size: 512,
    },
    checks: { runtimeBefore: 'passed', runtimeAfter: 'passed', runtimeUnchangedDuringBuild: true },
    signing: { requested: false, verified: false, updaterArtifacts: false },
    publication: { published: false, channel: null, url: null },
  };
  const installed = {
    schemaVersion: 1,
    status: 'passed',
    commit: context.commit,
    sourceCommit: context.commit,
    version: '0.1.3',
    identifier: product.identifier,
    candidateSha256: digest(bytes),
    installationMetadataRestored: true,
    formalMetadataUnchanged: true,
    wrapperErrors: [],
    modelRequests: 0,
    runtime,
  };
  const gate = {
    schemaVersion: 1,
    status: 'passed',
    repository: context.repository,
    sourceCommit: context.commit,
    requestFailed: false,
    timedOut: false,
    checks: ['ci.yml', 'windows-services.yml', 'lan-regression.yml'].map((workflow, index) => ({
      workflow,
      status: 'passed',
      run: {
        id: 10 + index,
        attempt: 1,
        sourceCommit: context.commit,
        status: 'completed',
        conclusion: 'success',
        url: `https://github.com/${context.repository}/actions/runs/${10 + index}`,
      },
    })),
  };
  const webview = {
    schema: 1,
    status: 'passed',
    scope: 'github-hosted-windows-only',
    outcome: 'present',
    detectedVersion: '131.0.2903.86',
    installationAttempted: false,
    timedOut: false,
    failureStage: null,
    failureType: null,
    failureHresult: null,
  };
  for (const [name, value] of Object.entries({
    'candidate-build.json': candidate,
    'runtime-manifest.json': manifest,
    'runtime-before.json': runtime,
    'runtime-after.json': runtime,
    'preview-install.json': installed,
    'ci-gate.json': gate,
    'webview2.json': webview,
  }))
    await writeFile(join(directory, name), encode(value));
  await writeFile(join(directory, installerName), bytes);
  const plan = await preparePreview(root, context);
  const published = {
    schemaVersion: 1,
    status: 'published',
    repository: context.repository,
    sourceCommit: context.commit,
    runID: context.runID,
    artifactID: context.artifactID,
    tag: plan.tag,
    version: plan.version,
    releaseID: 100,
    url: `https://github.com/${context.repository}/releases/tag/${plan.tag}`,
    reusedPublishedRelease: false,
    assets: plan.assets.map(({ name, size, sha256 }) => ({ name, bytes: size, sha256 })),
  };
  await writeFile(join(root, 'test-results', 'preview-release', 'release.json'), encode(published));
  const file = (index: number) => ({
    fileName: plan.assets[index].name,
    bytes: plan.assets[index].size,
    sha256: plan.assets[index].sha256,
    url: `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${plan.tag}/${plan.assets[index].name}`,
  });
  const record = parsePreviewDownloadRecord({
    schemaVersion: 1,
    kind: 'rivloom-preview-download',
    status: 'published',
    version: plan.version,
    product: { kind: product.kind, identifier: product.identifier },
    source: { commit: context.commit },
    build: { runID: context.runID, artifactID: context.artifactID },
    release: { id: 100, tag: plan.tag, publishedAt },
    artifact: file(0),
    checksum: file(1),
    signing: { authenticode: 'unsigned', tauriUpdater: 'not-configured' },
    verification: { ci: 'passed', installation: 'passed', publicDownload: 'passed', checkedAt },
  });
  return { root, directory, plan, record, published };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Stored = { body: Buffer; sha256: string; etag: string };
function differentRecord(record: PreviewDownloadRecord, commit: string, artifactID: string) {
  const tag = `preview-v${record.version}-${commit.slice(0, 12)}-${artifactID}`;
  return parsePreviewDownloadRecord({
    ...record,
    source: { commit },
    build: { runID: '10000', artifactID },
    release: { ...record.release, id: 99, tag },
    artifact: {
      ...record.artifact,
      url: `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${tag}/${record.artifact.fileName}`,
    },
    checksum: {
      ...record.checksum,
      url: `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${tag}/SHA256SUMS.txt`,
    },
  });
}
function mockServices(f: Fixture) {
  const state = {
    objects: new Map<string, Stored>(),
    calls: [] as string[],
    writes: [] as ObjectRequest[],
    uploadsFail: false,
    publicFailure: '' as '' | 'status' | 'digest' | 'short' | 'long',
    githubFault: '',
    hookFailure: false,
    hooks: 0,
    comparison: 'ahead',
    conflicts: 0,
    beforeCAS: undefined as (() => void) | undefined,
  };
  let generation = 0;
  const store = (key: string, body: Buffer, sha256 = digest(body)) =>
    state.objects.set(key, { body, sha256, etag: `"generation-${++generation}"` });
  const assets = f.plan.assets.map((asset, index) => ({
    id: 200 + index,
    name: asset.name,
    size: asset.size,
    digest: `sha256:${asset.sha256}`,
    state: 'uploaded',
  }));
  const services: WebsiteServices = {
    now: () => new Date(checkedAt),
    github: async (path) => {
      state.calls.push(`github ${path}`);
      if (path === '/releases/100')
        return {
          id: 100,
          draft: state.githubFault === 'draft',
          prerelease: true,
          name: f.plan.title,
          body: f.plan.body,
          tag_name: f.plan.tag,
          target_commitish: context.commit,
          published_at: publishedAt,
        };
      if (path === '/releases/100/assets?per_page=100')
        return assets.map((asset) => ({
          ...asset,
          ...(state.githubFault === 'digest' ? { digest: 'sha256:' + 'f'.repeat(64) } : {}),
        }));
      if (path.startsWith('/releases/assets/'))
        return assets.find((asset) => asset.id === Number(path.split('/').at(-1)));
      if (path.startsWith('/git/ref/tags/'))
        return {
          object: {
            type: 'commit',
            sha: state.githubFault === 'tag' ? '9'.repeat(40) : context.commit,
          },
        };
      if (path.startsWith('/compare/')) {
        const base = path.slice('/compare/'.length).split('...')[0];
        return {
          status: state.comparison,
          base_commit: { sha: base },
          merge_base_commit: { sha: base },
          ahead_by: 1,
          behind_by: 0,
        };
      }
      throw new Error('Unexpected mocked GitHub request');
    },
    storage: async (request) => {
      state.calls.push(`r2 ${request.method} ${request.key}`);
      const found = state.objects.get(request.key);
      if (request.method === 'HEAD')
        return found
          ? response(null, 200, {
              'content-length': String(found.body.length),
              'x-amz-meta-rivloom-sha256': found.sha256,
              etag: found.etag,
            })
          : response(null, 404);
      if (request.method === 'GET')
        return found ? response(found.body, 200, { etag: found.etag }) : response(null, 404);
      state.writes.push(request);
      if (request.key === latestKey && state.conflicts-- > 0) {
        state.beforeCAS?.();
        return response(null, 412);
      }
      if (request.key !== latestKey && state.uploadsFail) return response(null, 503);
      if (
        request.condition &&
        ('absent' in request.condition ? Boolean(found) : found?.etag !== request.condition.etag)
      )
        return response(null, 412);
      assert(request.payload);
      const body = request.payload.path
        ? await readFile(request.payload.path)
        : request.payload.body!;
      assert.equal(body.length, request.payload.bytes);
      assert.equal(digest(body), request.payload.sha256);
      store(request.key, body, request.payload.sha256);
      return response(null, 200);
    },
    publicRead: async (key) => {
      state.calls.push(`public ${key}`);
      const found = state.objects.get(key);
      if (!found) return response(null, 404);
      if (key !== latestKey) {
        if (state.publicFailure === 'status') return response(null, 503);
        if (state.publicFailure === 'digest') return response(Buffer.alloc(found.body.length, 1));
        if (state.publicFailure === 'short')
          return response(found.body.subarray(0, found.body.length - 1));
        if (state.publicFailure === 'long')
          return response(Buffer.concat([found.body, Buffer.from('x')]));
      }
      return response(found.body);
    },
    deploy: async () => {
      state.hooks++;
      if (state.hookFailure)
        throw new Error('secret-access-key SECRET-HOOK-URL must never be reported');
    },
  };
  return { state, services, store };
}

test('invalid local candidate or publication evidence makes no external calls', async () => {
  for (const fault of ['publication', 'candidate']) {
    const f = await fixture(),
      mock = mockServices(f);
    if (fault === 'publication')
      await writeFile(
        join(f.root, 'test-results', 'preview-release', 'release.json'),
        encode({ ...f.published, status: 'failed' }),
      );
    else
      await writeFile(
        join(f.directory, 'Rivloom UI Preview_0.1.3_x64-setup.exe'),
        Buffer.alloc(512),
      );
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'local-proof');
    assert.deepEqual(mock.state.calls, []);
  }
});

test('real release metadata, asset digest and tag source must pass before storage writes', async () => {
  const f = await fixture();
  for (const fault of ['draft', 'digest', 'tag']) {
    const mock = mockServices(f);
    mock.state.githubFault = fault;
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'published-release');
    assert.equal(mock.state.writes.length, 0);
    assert.equal(
      mock.state.calls.some((call) => call.startsWith('r2 ')),
      false,
    );
  }
});

test('upload errors and bad anonymous downloads never change the previous latest pointer', async () => {
  const f = await fixture();
  for (const fault of ['upload', 'status', 'digest', 'short', 'long'] as const) {
    const mock = mockServices(f);
    const previous = encode(differentRecord(f.record, '2'.repeat(40), '60000'));
    mock.store(latestKey, previous);
    if (fault === 'upload') mock.state.uploadsFail = true;
    else mock.state.publicFailure = fault;
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, 'failed');
    assert.equal(
      mock.state.writes.some((write) => write.key === latestKey),
      false,
    );
    assert.deepEqual(mock.state.objects.get(latestKey)!.body, previous);
    assert.equal(mock.state.hooks, 0);
  }
});

test('existing matching objects are reused while conflicting objects are never replaced', async () => {
  const f = await fixture();
  for (const conflict of [false, true]) {
    const mock = mockServices(f);
    for (const asset of f.plan.assets)
      mock.store(
        `previews/${f.plan.tag}/${asset.name}`,
        asset.path ? await readFile(asset.path) : asset.bytes!,
      );
    const installerKey = `previews/${f.plan.tag}/${f.plan.assets[0].name}`;
    if (conflict) mock.state.objects.get(installerKey)!.sha256 = 'f'.repeat(64);
    const before = {
      ...mock.state.objects.get(installerKey)!,
      body: Buffer.from(mock.state.objects.get(installerKey)!.body),
    };
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, conflict ? 'failed' : 'synced');
    assert.equal(mock.state.writes.filter((write) => write.key !== latestKey).length, 0);
    assert.deepEqual(mock.state.objects.get(installerKey), before);
    if (conflict) assert.equal(mock.state.objects.has(latestKey), false);
  }
});

test('behind or diverged sources and lower artifact IDs cannot move latest backward', async () => {
  const f = await fixture();
  for (const relation of ['behind', 'diverged', 'identical']) {
    const mock = mockServices(f);
    mock.state.comparison = relation;
    const previous = encode(
      differentRecord(
        f.record,
        relation === 'identical' ? context.commit : '2'.repeat(40),
        '99999',
      ),
    );
    mock.store(latestKey, previous);
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, 'superseded');
    assert.equal(result.latestAction, 'not-promoted');
    assert.deepEqual(mock.state.objects.get(latestKey)!.body, previous);
    assert.equal(
      mock.state.writes.some((write) => write.key === latestKey),
      false,
    );
    assert.equal(mock.state.hooks, 0);
  }
});

test('CAS retries reread the winner and reevaluate source order instead of blindly overwriting', async () => {
  const f = await fixture();
  for (const winner of ['older', 'newer']) {
    const mock = mockServices(f);
    mock.store(latestKey, encode(differentRecord(f.record, '2'.repeat(40), '60000')));
    mock.state.conflicts = 1;
    const racing = encode(differentRecord(f.record, '3'.repeat(40), '65000'));
    mock.state.beforeCAS = () => {
      mock.store(latestKey, racing);
      mock.state.comparison = winner === 'older' ? 'ahead' : 'behind';
    };
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, winner === 'older' ? 'synced' : 'superseded');
    const writes = mock.state.writes.filter((write) => write.key === latestKey);
    assert.equal(writes.length, winner === 'older' ? 2 : 1);
    if (winner === 'older') {
      assert.notDeepEqual(writes[0].condition, writes[1].condition);
      assert.deepEqual(JSON.parse(mock.state.objects.get(latestKey)!.body.toString()), f.record);
    } else assert.deepEqual(mock.state.objects.get(latestKey)!.body, racing);
  }
});

test('hook failure retries the same verified latest without reuploading or leaking secrets', async () => {
  const f = await fixture(),
    mock = mockServices(f);
  mock.state.hookFailure = true;
  const first = await synchronizeWebsiteDownload(f.root, context, mock.services);
  assert.equal(first.status, 'failed');
  assert.equal(first.stage, 'deploy-hook');
  assert.equal(first.hookTriggered, false);
  assert.doesNotMatch(JSON.stringify(first), /secret-access-key|SECRET-HOOK-URL/);
  const original = Buffer.from(mock.state.objects.get(latestKey)!.body),
    writes = mock.state.writes.length;
  mock.state.hookFailure = false;
  mock.services.now = () => new Date('2026-09-05T10:00:00.000Z');
  const second = await synchronizeWebsiteDownload(f.root, context, mock.services);
  assert.equal(second.status, 'synced');
  assert.equal(second.latestAction, 'reused');
  assert.equal(second.hookTriggered, true);
  assert.equal(mock.state.hooks, 2);
  assert.equal(mock.state.writes.length, writes);
  assert.deepEqual(mock.state.objects.get(latestKey)!.body, original);
});

test('invalid latest data and exhausted CAS conflicts fail without replacing the pointer', async () => {
  const f = await fixture();
  for (const fault of ['invalid', 'races']) {
    const mock = mockServices(f);
    const previous =
      fault === 'invalid'
        ? encode({ invalid: true })
        : encode(differentRecord(f.record, '2'.repeat(40), '60000'));
    mock.store(latestKey, previous);
    if (fault === 'races') mock.state.conflicts = 10;
    const result = await synchronizeWebsiteDownload(f.root, context, mock.services);
    assert.equal(result.status, 'failed');
    assert.deepEqual(mock.state.objects.get(latestKey)!.body, previous);
    assert.equal(mock.state.hooks, 0);
    assert.equal(
      mock.state.writes.filter((write) => write.key === latestKey).length,
      fault === 'races' ? 4 : 0,
    );
  }
});

test('production service configuration rejects foreign hooks and keeps public and hook requests credential-free', async () => {
  const hook =
    'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/12345678-1234-1234-1234-123456789abc';
  for (const value of [
    hook + '?url=https://example.invalid',
    hook + '\n',
    hook.replace('api.cloudflare.com', 'api.cloudflare.com.example.invalid'),
    hook.replace('https:', 'http:'),
    hook.replace('/pages/', '/workers/'),
  ])
    assert.throws(() => pagesDeployHook(value));
  assert.equal(pagesDeployHook(hook), hook);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response(null);
  };
  const services = websiteServices(
    {
      GITHUB_REPOSITORY: context.repository,
      RIVLOOM_CANDIDATE_SHA: context.commit,
      GITHUB_RUN_ID: context.runID,
      RIVLOOM_CANDIDATE_ARTIFACT_ID: context.artifactID,
      GITHUB_TOKEN: 'synthetic-github-token',
      RIVLOOM_R2_ACCOUNT_ID: 'a'.repeat(32),
      RIVLOOM_R2_BUCKET: 'rivloom-downloads',
      RIVLOOM_R2_ACCESS_KEY_ID: 'b'.repeat(32),
      RIVLOOM_R2_SECRET_ACCESS_KEY: 'c'.repeat(64),
      RIVLOOM_PAGES_DEPLOY_HOOK: hook,
    },
    fetcher,
  );
  await services.publicRead(latestKey);
  await services.deploy();
  assert.equal(calls[0].url, `${PREVIEW_DOWNLOAD_ORIGIN}/${latestKey}`);
  assert.equal(calls[1].url, hook);
  for (const call of calls) {
    assert.equal(new Headers(call.init?.headers).has('authorization'), false);
    assert.equal(call.init?.redirect, 'error');
  }
  await assert.rejects(() => services.publicRead('../private.json'));
  await assert.rejects(() => services.github('/../../other/repo/releases/1'));
  assert.equal(calls.length, 2);
});
