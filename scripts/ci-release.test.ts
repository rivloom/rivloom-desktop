import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  githubTransport,
  prepareRelease,
  publishRelease,
  releaseContext,
  type ReleaseContext,
  type ReleaseRequest,
  type ReleaseTransport,
} from './ci-release.ts';

const context: ReleaseContext = {
  repository: 'rivloom/rivloom-desktop',
  commit: '1'.repeat(40),
  runID: '12345',
  artifactID: '67890',
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const installerName = 'Rivloom_0.1.3_x64-setup.exe';
async function fixture() {
  const parent = resolve(import.meta.dirname, '..', 'test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'release-selftest-'));
  const directory = join(root, 'test-results', 'candidate');
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'src-tauri'));
  await writeFile(join(root, 'package.json'), encode({ version: '0.1.3' }));
  await writeFile(join(root, 'package-lock.json'), 'synthetic npm lock');
  await writeFile(join(root, 'src-tauri', 'Cargo.lock'), 'synthetic cargo lock');
  const product = {
    kind: 'desktop',
    identifier: 'com.rivloom.desktop',
    version: '0.1.3',
  };
  const manifest = {
    schemaVersion: 1,
    product,
    target: { platform: 'win32', arch: 'x64' },
    inputs: {
      packageLockSha256: sha('synthetic npm lock'),
      cargoLockSha256: sha('synthetic cargo lock'),
    },
    node: {
      version: '24.19.0',
      sha256: 'a'.repeat(64),
      source: 'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt',
    },
    opencode: {
      version: '1.18.25',
      sha256: 'b'.repeat(64),
      source: 'opencode-windows-x64@1.18.25',
    },
    documents: [],
    packages: [{ name: 'synthetic' }],
    notices: [{ path: 'synthetic-license' }],
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
  bytes.write('Synthetic PE structure only: never execute', 180);
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
    artifact: { fileName: installerName, bytes: bytes.length, sha256: sha(bytes) },
    runtimeManifestSha256: sha(encode(manifest)),
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
    candidateSha256: sha(bytes),
    installationMetadataRestored: true,
    previewMetadataUnchanged: true,
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
    'desktop-install.json': installed,
    'ci-gate.json': gate,
    'webview2.json': webview,
  }))
    await writeFile(join(directory, name), encode(value));
  await writeFile(join(directory, installerName), bytes);
  const change = async (file: string, mutate: (value: any) => void) => {
    const value = JSON.parse(await readFile(join(directory, file), 'utf8'));
    mutate(value);
    await writeFile(join(directory, file), encode(value));
  };
  return { root, directory, change };
}

function mockGithub() {
  const state = {
    release: null as Record<string, any> | null,
    tag: null as string | null,
    assets: [] as Array<Record<string, any>>,
    calls: [] as ReleaseRequest[],
    writes: [] as ReleaseRequest[],
    failUpload: '',
    wrongRepository: false,
    expiredArtifact: false,
    legacyArtifact: false,
    historicalReleases: [] as Array<Record<string, any>>,
  };
  const transport: ReleaseTransport = async (request) => {
    state.calls.push(request);
    if (request.method !== 'GET') state.writes.push(request);
    const url = new URL(request.url);
    const path = url.pathname.slice(`/repos/${context.repository}`.length);
    const ok = (body: any, status = 200) => ({ status, body: structuredClone(body) });
    if (request.method === 'GET' && path.startsWith('/actions/artifacts/'))
      return ok({
        id: Number(context.artifactID),
        name: `${state.legacyArtifact ? 'conversation-preview-candidate' : 'rivloom-candidate'}-${context.commit}-${context.runID}-2`,
        expired: state.expiredArtifact,
        workflow_run: {
          id: Number(context.runID),
          repository_id: 9,
          head_repository_id: 9,
          head_sha: '2'.repeat(40),
        },
      });
    if (request.method === 'GET' && path.startsWith('/actions/runs/'))
      return ok({
        id: Number(context.runID),
        repository: { full_name: context.repository, id: 9 },
        head_repository: {
          full_name: state.wrongRepository ? 'other/repo' : context.repository,
          id: 9,
        },
      });
    if (request.method === 'GET' && path.startsWith('/git/ref/tags/'))
      return state.tag ? ok({ object: { type: 'commit', sha: state.tag } }) : ok(null, 404);
    if (request.method === 'GET' && path === '/releases')
      return ok([...state.historicalReleases, ...(state.release ? [state.release] : [])]);
    if (request.method === 'GET' && path === '/releases/100') return ok(state.release);
    if (request.method === 'GET' && path === '/releases/100/assets') return ok(state.assets);
    if (request.method === 'GET' && path.startsWith('/releases/assets/'))
      return ok(state.assets.find((asset) => asset.id === Number(path.split('/').at(-1))));
    if (request.method === 'POST' && path === '/releases') {
      assert.equal(request.json?.draft, true);
      assert.equal(request.json?.prerelease, false);
      assert.equal(request.json?.make_latest, 'false');
      assert.equal(request.json?.target_commitish, context.commit);
      state.release = { id: 100, ...request.json };
      return ok(state.release, 201);
    }
    if (request.method === 'POST' && url.hostname === 'uploads.github.com') {
      assert(state.release?.draft, 'Uploads must remain in a draft');
      assert(request.asset);
      const name = url.searchParams.get('name');
      assert.equal(name, request.asset.name);
      if (state.failUpload === name) {
        state.failUpload = '';
        return ok(null, 502);
      }
      const bytes = request.asset.path ? await readFile(request.asset.path) : request.asset.bytes!;
      const asset = {
        id: 200 + state.assets.length,
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: `sha256:${sha(bytes)}`,
      };
      state.assets.push(asset);
      return ok(asset, 201);
    }
    if (request.method === 'PATCH' && path === '/releases/100') {
      assert.equal(state.assets.length, 2, 'Never publish partial assets');
      assert.equal(request.json?.prerelease, false);
      assert.equal(request.json?.make_latest, 'false');
      state.release = { ...state.release, ...request.json };
      state.tag = context.commit;
      return ok(state.release);
    }
    throw new Error(`Unexpected mock request: ${request.method} ${path}`);
  };
  return { state, transport };
}

test('failed local evidence or extra files cause zero GitHub calls', async () => {
  for (const [file, mutate] of [
    [
      'candidate-build.json',
      (record: any) => {
        record.source.commit = '2'.repeat(40);
      },
    ],
    [
      'candidate-build.json',
      (record: any) => {
        record.publication.published = true;
      },
    ],
    [
      'candidate-build.json',
      (record: any) => {
        record.product = {
          ...record.product,
          kind: 'conversation-preview',
          identifier: 'com.rivloom.conversationpreview',
        };
        record.profile = 'conversation-preview';
      },
    ],
    [
      'candidate-build.json',
      (record: any) => {
        record.product.version = '0.1.3-rc.1';
      },
    ],
    [
      'candidate-build.json',
      (record: any) => {
        record.source.refType = 'tag';
        record.source.refName = 'ci-preview-v0.1.3';
      },
    ],
    [
      'desktop-install.json',
      (record: any) => {
        record.identifier = 'com.rivloom.conversationpreview';
      },
    ],
    [
      'desktop-install.json',
      (record: any) => {
        delete record.previewMetadataUnchanged;
        record.formalMetadataUnchanged = true;
      },
    ],
    [
      'desktop-install.json',
      (record: any) => {
        record.installationMetadataRestored = false;
      },
    ],
    [
      'desktop-install.json',
      (record: any) => {
        record.candidateSha256 = 'd'.repeat(64);
      },
    ],
    [
      'desktop-install.json',
      (record: any) => {
        record.modelRequests = 1;
      },
    ],
    [
      'ci-gate.json',
      (record: any) => {
        record.checks[0].run.sourceCommit = '2'.repeat(40);
      },
    ],
    [
      'runtime-after.json',
      (record: any) => {
        record.status = 'failed';
      },
    ],
    [
      'webview2.json',
      (record: any) => {
        record.status = 'failed';
      },
    ],
  ] as const) {
    const { root, change } = await fixture();
    await change(file, mutate);
    const github = mockGithub();
    await assert.rejects(() => publishRelease(root, context, github.transport));
    assert.equal(github.state.calls.length, 0);
  }
  const { root, directory } = await fixture();
  await writeFile(join(directory, 'unexpected.json'), '{}');
  const github = mockGithub();
  await assert.rejects(
    () => publishRelease(root, context, github.transport),
    /original eight files/,
  );
  assert.equal(github.state.calls.length, 0);
});

test('draft upload failure is resumable with the same artifact; completed release retry performs no mutations', async () => {
  const { root } = await fixture();
  const github = mockGithub();
  github.state.failUpload = 'SHA256SUMS.txt';
  await assert.rejects(() => publishRelease(root, context, github.transport), /upload failed/);
  assert.equal(github.state.release?.draft, true);
  assert.equal(github.state.assets.length, 1);
  assert.equal(github.state.tag, null);
  const priorWrites = github.state.writes.length;
  const result = await publishRelease(root, context, github.transport);
  assert.equal(result.status, 'published');
  assert.equal(result.tag, `v0.1.3-${context.commit.slice(0, 12)}-${context.artifactID}`);
  assert.equal(result.assets.length, 2);
  assert.equal(github.state.writes.slice(priorWrites).filter((request) => request.asset).length, 1);
  assert.equal(
    github.state.writes.filter((request) => request.method === 'POST' && !request.asset).length,
    1,
  );
  const writesAfterPublish = github.state.writes.length;
  const retry = await publishRelease(root, context, github.transport);
  assert.equal(retry.reusedPublishedRelease, true);
  assert.equal(github.state.writes.length, writesAfterPublish);
});

test('existing asset digest or source/title bindings conflict without deletion or replacement', async () => {
  const { root } = await fixture();
  const github = mockGithub();
  await publishRelease(root, context, github.transport);
  for (const change of [
    () => {
      github.state.assets[0].digest = 'sha256:' + 'f'.repeat(64);
    },
    () => {
      github.state.assets[0].digest = null;
    },
    () => {
      github.state.assets[0].state = 'starter';
    },
    () => {
      github.state.release!.target_commitish = '2'.repeat(40);
    },
    () => {
      github.state.release!.name = 'Unrelated release';
    },
    () => {
      github.state.release!.prerelease = true;
    },
    () => {
      github.state.tag = '2'.repeat(40);
    },
  ]) {
    const saved = structuredClone({
      assets: github.state.assets,
      release: github.state.release,
      tag: github.state.tag,
    });
    change();
    const writes = github.state.writes.length;
    await assert.rejects(() => publishRelease(root, context, github.transport));
    assert.equal(github.state.writes.length, writes);
    Object.assign(github.state, saved);
  }
});

test('wrong tag target or artifact repository is rejected before creating a release', async () => {
  const { root } = await fixture();
  for (const variant of ['tag', 'repository', 'expired', 'legacy-artifact']) {
    const github = mockGithub();
    if (variant === 'tag') github.state.tag = '2'.repeat(40);
    if (variant === 'repository') github.state.wrongRepository = true;
    if (variant === 'expired') github.state.expiredArtifact = true;
    if (variant === 'legacy-artifact') github.state.legacyArtifact = true;
    await assert.rejects(() => publishRelease(root, context, github.transport));
    assert.equal(github.state.writes.length, 0);
  }
});

test('historical Preview releases remain unchanged when a new Rivloom release is published', async () => {
  const { root } = await fixture();
  const github = mockGithub();
  const historical = {
    id: 90,
    tag_name: `preview-v0.1.3-${context.commit.slice(0, 12)}-${context.artifactID}`,
    target_commitish: context.commit,
    name: 'Rivloom UI Preview 0.1.3',
    body: '<!-- rivloom-managed-preview-release-v1 -->',
    prerelease: true,
    draft: false,
  };
  github.state.historicalReleases = [structuredClone(historical)];
  const result = await publishRelease(root, context, github.transport);
  assert.equal(result.status, 'published');
  assert.equal(github.state.release?.prerelease, false);
  assert.deepEqual(github.state.historicalReleases, [historical]);
  assert(github.state.writes.every((request) => !request.url.includes('/releases/90')));
});

test('publication metadata keeps original evidence and allows a new artifact ID to produce a new immutable tag', async () => {
  const { root, directory } = await fixture();
  const before = await readFile(join(directory, 'candidate-build.json'));
  const first = await prepareRelease(root, context);
  const second = await prepareRelease(root, { ...context, artifactID: '67891' });
  assert.notEqual(first.tag, second.tag);
  assert.deepEqual(await readFile(join(directory, 'candidate-build.json')), before);
  assert.equal(first.assets[0].name, 'Rivloom_0.1.3_x64-setup.exe');
  assert.equal(
    first.assets[1].bytes?.toString(),
    `${first.assets[0].sha256}  ${first.assets[0].name}\n`,
  );
  assert.match(first.body, /未签名/);
  assert.match(first.body, /真实模型/);
  assert.doesNotMatch(first.body + first.title, /Preview|预发布/);
});

test('environment and transport reject invalid identity or external endpoints without network access', async () => {
  assert.throws(() =>
    releaseContext({
      GITHUB_REPOSITORY: context.repository,
      RIVLOOM_CANDIDATE_SHA: context.commit,
      GITHUB_RUN_ID: '1',
      RIVLOOM_CANDIDATE_ARTIFACT_ID: '0',
    }),
  );
  const transport = githubTransport('synthetic-token-never-transmitted');
  await assert.rejects(
    () => transport({ method: 'POST', url: 'https://example.invalid/releases' }),
    /official GitHub/,
  );
});
