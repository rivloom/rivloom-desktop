// Publish only a verified, current-run Rivloom artifact. No installer execution,
// npm dependencies, signing, updater records, asset deletion or replacement.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type Json = Record<string, any>;
export type ReleaseContext = {
  repository: string;
  commit: string;
  runID: string;
  artifactID: string;
};
type Asset = { name: string; size: number; sha256: string; path?: string; bytes?: Buffer };
export type ReleaseRequest = {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  json?: Json;
  asset?: Asset;
};
export type ReleaseTransport = (request: ReleaseRequest) => Promise<{ status: number; body: any }>;
class ReleaseFailure extends Error {}
function requireProof(value: unknown, message: string): asserts value {
  if (!value) throw new ReleaseFailure(message);
}
const same = (left: unknown, right: unknown, message: string) =>
  requireProof(isDeepStrictEqual(left, right), message);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const shaPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const positiveID = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const numericID = (value: string) =>
  /^[1-9]\d{0,15}$/.exec(value)?.[0] === value && positiveID(Number(value));
const metadataFiles = [
  'candidate-build.json',
  'runtime-manifest.json',
  'runtime-before.json',
  'runtime-after.json',
  'ci-gate.json',
  'desktop-install.json',
  'webview2.json',
];

export function releaseContext(environment: NodeJS.ProcessEnv): ReleaseContext {
  const context = {
    repository: environment.GITHUB_REPOSITORY || '',
    commit: environment.RIVLOOM_CANDIDATE_SHA || '',
    runID: environment.GITHUB_RUN_ID || '',
    artifactID: environment.RIVLOOM_CANDIDATE_ARTIFACT_ID || '',
  };
  requireProof(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(context.repository),
    'Invalid release repository',
  );
  requireProof(
    commitPattern.exec(context.commit)?.[0] === context.commit &&
      numericID(context.runID) &&
      numericID(context.artifactID),
    'Full source SHA and numeric run/artifact IDs required',
  );
  return context;
}

async function regular(path: string, directory = false) {
  const info = await lstat(path);
  requireProof(
    !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    'Release inputs must be regular files and directories',
  );
  return info;
}
async function jsonFile(path: string): Promise<Json> {
  const info = await regular(path);
  requireProof(info.size > 0 && info.size <= 2 * 1024 ** 2, 'Release JSON exceeds its size limit');
  const bytes = await readFile(path);
  requireProof(bytes.length === info.size, 'Release JSON changed while reading');
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    requireProof(
      value && typeof value === 'object' && !Array.isArray(value),
      'Release JSON must be an object',
    );
    return value;
  } catch {
    throw new ReleaseFailure('Invalid release JSON');
  }
}
async function measurePE(path: string) {
  const before = await regular(path);
  requireProof(
    before.size >= 64 && before.size <= 2 * 1024 ** 3,
    'Installer exceeds its PE size bounds',
  );
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    requireProof(
      opened.ino === before.ino && opened.dev === before.dev,
      'Installer changed before reading',
    );
    const header = Buffer.alloc(64),
      signature = Buffer.alloc(4);
    await file.read(header, 0, 64, 0);
    const offset = header.readUInt32LE(60);
    requireProof(
      header.toString('ascii', 0, 2) === 'MZ' && offset >= 64 && offset + 4 <= before.size,
      'Installer is not a bounded Windows PE',
    );
    await file.read(signature, 0, 4, offset);
    requireProof(
      signature.equals(Buffer.from([80, 69, 0, 0])),
      'Installer PE signature is invalid',
    );
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      size += chunk.length;
      requireProof(size <= before.size, 'Installer grew while reading');
      hash.update(chunk);
    }
    for (const after of [await file.stat(), await regular(path)])
      requireProof(
        after.ino === before.ino &&
          after.dev === before.dev &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Installer changed while reading',
      );
    requireProof(size === before.size, 'Installer byte count changed');
    return { size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export async function prepareRelease(root: string, context: ReleaseContext) {
  releaseContext({
    GITHUB_REPOSITORY: context.repository,
    RIVLOOM_CANDIDATE_SHA: context.commit,
    GITHUB_RUN_ID: context.runID,
    RIVLOOM_CANDIDATE_ARTIFACT_ID: context.artifactID,
  });
  const directory = join(root, 'test-results', 'candidate');
  for (const path of [root, join(root, 'test-results'), directory]) await regular(path, true);
  const candidate = await jsonFile(join(directory, 'candidate-build.json'));
  const version = candidate.product?.version;
  requireProof(
    typeof version === 'string' &&
      version.length <= 100 &&
      versionPattern.exec(version)?.[0] === version,
    'Invalid candidate version',
  );
  const product = {
    kind: 'desktop',
    identifier: 'com.rivloom.desktop',
    version,
  };
  same(candidate.product, product, 'Candidate is not this Rivloom product');
  requireProof(
    candidate.schemaVersion === 1 &&
      candidate.status === 'candidate' &&
      candidate.profile === product.kind &&
      candidate.target === 'x86_64-pc-windows-msvc',
    'Candidate profile or target failed',
  );
  const source = candidate.source;
  requireProof(
    source?.commit === context.commit &&
      source.expectedCommit === context.commit &&
      source.workingTree === 'clean' &&
      source.node === '24.19.0' &&
      source.rust === '1.98.1' &&
      source.cargo === '1.98.1',
    'Candidate source or pinned toolchain failed',
  );
  requireProof(
    (source.refType === 'branch' && source.refName === 'main') ||
      (source.refType === 'tag' && source.refName === `ci-v${version}`),
    'Candidate ref does not match its version',
  );
  same(
    candidate.signing,
    { requested: false, verified: false, updaterArtifacts: false },
    'Candidate signing state changed',
  );
  same(
    candidate.publication,
    { published: false, channel: null, url: null },
    'Original candidate publication evidence changed',
  );
  same(
    candidate.checks,
    { runtimeBefore: 'passed', runtimeAfter: 'passed', runtimeUnchangedDuringBuild: true },
    'Candidate runtime checks failed',
  );
  same(
    (await jsonFile(join(root, 'package.json'))).version,
    version,
    'Checkout version differs from candidate',
  );
  const installerName = `Rivloom_${version}_x64-setup.exe`;
  same(
    (await readdir(directory)).sort(),
    [...metadataFiles, installerName].sort(),
    'Candidate must contain exactly the original eight files',
  );
  requireProof(
    candidate.artifact?.fileName === installerName && shaPattern.test(candidate.artifact.sha256),
    'Candidate installer identity failed',
  );
  const installer = join(directory, installerName),
    measured = await measurePE(installer);
  same(
    measured,
    { size: candidate.artifact.bytes, sha256: candidate.artifact.sha256 },
    'Installer bytes do not match the candidate',
  );
  const manifest = await jsonFile(join(directory, 'runtime-manifest.json'));
  requireProof(
    shaPattern.test(candidate.runtimeManifestSha256) &&
      sha(await readFile(join(directory, 'runtime-manifest.json'))) ===
        candidate.runtimeManifestSha256,
    'Runtime manifest hash differs',
  );
  requireProof(manifest.schemaVersion === 1, 'Unknown runtime manifest schema');
  same(manifest.product, product, 'Runtime manifest product differs');
  same(manifest.target, { platform: 'win32', arch: 'x64' }, 'Runtime manifest target differs');
  const before = await jsonFile(join(directory, 'runtime-before.json'));
  same(
    before,
    await jsonFile(join(directory, 'runtime-after.json')),
    'Runtime before/after reports differ',
  );
  requireProof(
    before.schemaVersion === 1 && before.status === 'passed',
    'Runtime verification failed',
  );
  same(before.product, product, 'Verified runtime product differs');
  same(before.target, manifest.target, 'Verified runtime target differs');
  same(before.inputs, manifest.inputs, 'Runtime input hashes differ');
  same(
    before.binaries,
    { node: manifest.node, opencode: manifest.opencode },
    'Runtime binaries differ',
  );
  same(before.documents, manifest.documents, 'Runtime documents differ');
  requireProof(
    before.binaries?.node?.version === '24.19.0' &&
      before.binaries?.opencode?.version === '1.18.25' &&
      shaPattern.test(before.binaries.node.sha256) &&
      shaPattern.test(before.binaries.opencode.sha256),
    'Pinned runtime binary evidence failed',
  );
  same(
    before.inputs,
    {
      packageLockSha256: sha(await readFile(join(root, 'package-lock.json'))),
      cargoLockSha256: sha(await readFile(join(root, 'src-tauri', 'Cargo.lock'))),
    },
    'Runtime inputs are not this checkout',
  );
  requireProof(
    Array.isArray(manifest.packages) &&
      before.packages === manifest.packages.length &&
      Array.isArray(manifest.notices) &&
      before.licenses?.files === manifest.notices.length,
    'Runtime inventory evidence differs',
  );
  requireProof(
    candidate.runtimeTree?.algorithm === 'sha256-path-kind-size-content-v1' &&
      shaPattern.test(candidate.runtimeTree.sha256) &&
      positiveID(candidate.runtimeTree.files) &&
      positiveID(candidate.runtimeTree.directories) &&
      positiveID(candidate.runtimeTree.size),
    'Runtime tree evidence is missing',
  );
  const installed = await jsonFile(join(directory, 'desktop-install.json'));
  requireProof(
    installed.schemaVersion === 1 &&
      installed.status === 'passed' &&
      installed.commit === context.commit &&
      installed.sourceCommit === context.commit &&
      installed.version === version &&
      installed.identifier === product.identifier &&
      installed.candidateSha256 === measured.sha256,
    'Installed smoke does not prove this candidate',
  );
  requireProof(
    installed.installationMetadataRestored === true &&
      installed.previewMetadataUnchanged === true &&
      installed.modelRequests === 0 &&
      !installed.wrapperFailure &&
      !installed.error &&
      !installed.cleanupError &&
      !installed.fixtureCleanupError,
    'Installed smoke cleanup or isolation failed',
  );
  same(installed.wrapperErrors, [], 'Installed smoke wrapper failed');
  same(installed.runtime, before, 'Installed runtime differs from build verification');
  const gate = await jsonFile(join(directory, 'ci-gate.json'));
  requireProof(
    gate.schemaVersion === 1 &&
      gate.status === 'passed' &&
      gate.repository === context.repository &&
      gate.sourceCommit === context.commit &&
      gate.requestFailed === false &&
      gate.timedOut === false,
    'Exact-source CI gate failed',
  );
  requireProof(
    Array.isArray(gate.checks) && gate.checks.length === 3,
    'All three CI workflows are required',
  );
  same(
    gate.checks.map((check: Json) => check.workflow).sort(),
    ['ci.yml', 'lan-regression.yml', 'windows-services.yml'],
    'CI workflow set differs',
  );
  for (const check of gate.checks)
    requireProof(
      check.status === 'passed' &&
        check.run?.sourceCommit === context.commit &&
        check.run.status === 'completed' &&
        check.run.conclusion === 'success' &&
        positiveID(check.run.id) &&
        positiveID(check.run.attempt) &&
        check.run.url === `https://github.com/${context.repository}/actions/runs/${check.run.id}`,
      'A CI workflow does not prove this source',
    );
  const webview = await jsonFile(join(directory, 'webview2.json'));
  requireProof(
    webview.schema === 1 &&
      webview.status === 'passed' &&
      webview.scope === 'github-hosted-windows-only' &&
      /^\d+\.\d+\.\d+\.\d+$/.test(webview.detectedVersion) &&
      webview.detectedVersion !== '0.0.0.0' &&
      webview.timedOut === false &&
      webview.failureStage === null &&
      webview.failureType === null &&
      webview.failureHresult === null,
    'WebView2 preparation failed',
  );
  requireProof(
    (webview.outcome === 'present' && webview.installationAttempted === false) ||
      (webview.outcome === 'installed' &&
        webview.installationAttempted === true &&
        webview.publisher === 'Microsoft Corporation' &&
        webview.sourceUrl === 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' &&
        shaPattern.test(webview.bootstrapperSha256) &&
        webview.installerExitCode === 0),
    'WebView2 provenance failed',
  );
  const name = `Rivloom_${version}_x64-setup.exe`;
  const sums = Buffer.from(`${measured.sha256}  ${name}\n`);
  const assets: Asset[] = [
    { name, path: installer, ...measured },
    { name: 'SHA256SUMS.txt', bytes: sums, size: sums.length, sha256: sha(sums) },
  ];
  const tag = `v${version}-${context.commit.slice(0, 12)}-${context.artifactID}`;
  const title = `Rivloom ${version} (${context.commit.slice(0, 12)} / ${context.artifactID})`;
  const body = [
    '<!-- rivloom-managed-release-v1 -->',
    '这是 Rivloom 的 Windows x64 安装包。目前尚未签名，也没有应用内自动更新。',
    '',
    `源码：\`${context.commit}\``,
    `构建：[${context.runID}](https://github.com/${context.repository}/actions/runs/${context.runID})`,
    `原始构建产物：\`${context.artifactID}\``,
    `版本：\`${version}\``,
    `安装包：\`${name}\``,
    `字节数：\`${measured.size}\``,
    `SHA256：\`${measured.sha256}\``,
    '',
    '已验证该源码的三条 CI、运行时一致性，以及临时 Windows 运行器中的隔离安装、启动、重启、卸载与受检数据保留。',
    '尚未涵盖交互式 GUI、真实模型调用、实体设备或旧版本升级验收。',
  ].join('\n');
  return { ...context, version, tag, title, body, assets };
}

export async function publishRelease(
  root: string,
  context: ReleaseContext,
  transport: ReleaseTransport,
) {
  const plan = await prepareRelease(root, context); // Must precede every network write.
  const base = `https://api.github.com/repos/${context.repository}`;
  const api = async (
    method: ReleaseRequest['method'],
    path: string,
    json?: Json,
    missing = false,
  ) => {
    const response = await transport({ method, url: base + path, json });
    if (missing && response.status === 404) return null;
    requireProof(
      response.status >= 200 && response.status < 300,
      `GitHub ${method} request failed (HTTP ${response.status})`,
    );
    return response.body;
  };
  const artifact = await api('GET', `/actions/artifacts/${context.artifactID}`);
  const run = await api('GET', `/actions/runs/${context.runID}`);
  requireProof(
    artifact?.id === Number(context.artifactID) &&
      artifact.expired === false &&
      typeof artifact.name === 'string' &&
      new RegExp(`^rivloom-candidate-${context.commit}-${context.runID}-[1-9]\\d*$`).test(
        artifact.name,
      ) &&
      numericID(artifact.name.split('-').at(-1)!),
    'Artifact identity does not match this candidate run',
  );
  requireProof(
    run?.id === Number(context.runID) &&
      run.repository?.full_name === context.repository &&
      run.head_repository?.full_name === context.repository &&
      positiveID(run.repository.id) &&
      run.head_repository.id === run.repository.id &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run.repository_id === run.repository.id &&
      artifact.workflow_run.head_repository_id === run.repository.id,
    'Artifact belongs to another run or repository',
  );
  // workflow_run metadata head_sha is deliberately not the candidate SHA: GitHub
  // can record the default branch checkout for that event. The artifact name and
  // eight local proofs carry the actual compiled source SHA.
  const tagTarget = async () => {
    const ref = await api('GET', `/git/ref/tags/${encodeURIComponent(plan.tag)}`, undefined, true);
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; depth < 6; depth++) {
      requireProof(object && commitPattern.test(object.sha), 'Release tag object is invalid');
      if (object.type === 'commit') return object.sha as string;
      requireProof(object.type === 'tag', 'Release tag does not resolve to a commit');
      object = (await api('GET', `/git/tags/${object.sha}`)).object;
    }
    throw new ReleaseFailure('Release tag annotation depth exceeded');
  };
  const checkTag = async (required: boolean) => {
    const target = await tagTarget();
    requireProof(
      (!required && target === null) || target === context.commit,
      'Release tag points to another source commit',
    );
  };
  await checkTag(false);
  // The tag endpoint excludes drafts; bounded list pagination preserves retry
  // access to a partially uploaded draft created by this token.
  let release: Json | null = null;
  for (let page = 1; page <= 20; page++) {
    const releases = await api('GET', `/releases?per_page=100&page=${page}`);
    requireProof(
      Array.isArray(releases) && releases.length <= 100,
      'Invalid GitHub release listing',
    );
    const matches = releases.filter((item: Json) => item.tag_name === plan.tag);
    requireProof(matches.length <= 1, 'Duplicate managed release tags');
    if (matches.length) {
      requireProof(positiveID(matches[0].id), 'Invalid release ID');
      release = await api('GET', `/releases/${matches[0].id}`);
      break;
    }
    if (releases.length < 100) break;
    requireProof(page < 20, 'Release lookup exceeded its pagination limit');
  }
  const validateRelease = (value: Json) => {
    requireProof(
      positiveID(value?.id) &&
        value.tag_name === plan.tag &&
        value.target_commitish === context.commit &&
        value.name === plan.title &&
        value.body === plan.body &&
        value.prerelease === false &&
        typeof value.draft === 'boolean',
      'Existing release bindings conflict with this candidate',
    );
  };
  const validateAsset = (value: Json, expected: Asset) => {
    requireProof(
      positiveID(value?.id) &&
        value.name === expected.name &&
        value.state === 'uploaded' &&
        value.size === expected.size &&
        value.digest === `sha256:${expected.sha256}`,
      'Release asset name, state, size or SHA256 conflicts',
    );
  };
  const inspectAssets = async (id: number, complete: boolean) => {
    const assets = await api('GET', `/releases/${id}/assets?per_page=100`);
    requireProof(
      Array.isArray(assets) &&
        assets.length <= 2 &&
        new Set(assets.map((item: Json) => item.name)).size === assets.length,
      'Unexpected or duplicate release assets',
    );
    for (const item of assets) {
      const expected = plan.assets.find((asset) => asset.name === item.name);
      requireProof(expected, 'Unexpected release attachment');
      validateAsset(item, expected);
      validateAsset(await api('GET', `/releases/assets/${item.id}`), expected);
    }
    requireProof(!complete || assets.length === 2, 'Release is missing a required attachment');
    return new Set(assets.map((item: Json) => item.name));
  };
  if (release) {
    validateRelease(release);
    await inspectAssets(release.id, !release.draft); // All conflicts checked before mutation.
    await checkTag(!release.draft);
  } else {
    release = await api('POST', '/releases', {
      tag_name: plan.tag,
      target_commitish: context.commit,
      name: plan.title,
      body: plan.body,
      draft: true,
      prerelease: false,
      make_latest: 'false',
    });
    validateRelease(release!);
    requireProof(release!.draft === true, 'GitHub did not create the required draft');
  }
  const wasPublished = !release!.draft;
  if (!wasPublished) {
    const present = await inspectAssets(release!.id, false);
    for (const asset of plan.assets) {
      if (present.has(asset.name)) continue;
      if (asset.path)
        same(
          await measurePE(asset.path),
          { size: asset.size, sha256: asset.sha256 },
          'Installer changed before upload',
        );
      const uploaded = await transport({
        method: 'POST',
        url: `https://uploads.github.com/repos/${context.repository}/releases/${release!.id}/assets?name=${encodeURIComponent(asset.name)}`,
        asset,
      });
      requireProof(uploaded.status === 201, `GitHub asset upload failed (HTTP ${uploaded.status})`);
      validateAsset(uploaded.body, asset);
    }
    await inspectAssets(release!.id, true);
    await checkTag(false);
    release = await api('GET', `/releases/${release!.id}`);
    validateRelease(release!);
    requireProof(release!.draft === true, 'Draft state changed during publication');
    release = await api('PATCH', `/releases/${release!.id}`, {
      draft: false,
      prerelease: false,
      make_latest: 'false',
    });
  }
  release = await api('GET', `/releases/${release!.id}`);
  validateRelease(release!);
  requireProof(release!.draft === false, 'Rivloom release is still a draft');
  await inspectAssets(release!.id, true);
  await checkTag(true);
  return {
    schemaVersion: 1,
    status: 'published',
    repository: context.repository,
    sourceCommit: context.commit,
    runID: context.runID,
    artifactID: context.artifactID,
    tag: plan.tag,
    version: plan.version,
    releaseID: release!.id,
    url: `https://github.com/${context.repository}/releases/tag/${encodeURIComponent(plan.tag)}`,
    reusedPublishedRelease: wasPublished,
    assets: plan.assets.map(({ name, size, sha256 }) => ({ name, bytes: size, sha256 })),
  };
}

export function githubTransport(token: string): ReleaseTransport {
  requireProof(token.length > 0, 'Step-only GitHub token is required');
  return async (request) => {
    const url = new URL(request.url);
    requireProof(
      ['https://api.github.com', 'https://uploads.github.com'].includes(url.origin) &&
        !url.username &&
        !url.password,
      'Only official GitHub API origins are allowed',
    );
    if (request.asset)
      requireProof(
        url.origin === 'https://uploads.github.com' && request.method === 'POST',
        'Invalid release upload endpoint',
      );
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    let body: BodyInit | undefined;
    if (request.asset) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(request.asset.size);
      body = request.asset.path
        ? (createReadStream(request.asset.path) as unknown as BodyInit)
        : (request.asset.bytes as unknown as BodyInit);
    } else if (request.json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.json);
    }
    try {
      const response = await fetch(url, {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(request.asset ? 240_000 : 30_000),
        ...(request.asset?.path ? { duplex: 'half' } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, body: null };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          requireProof(size <= 2 * 1024 ** 2, 'GitHub JSON response exceeds its limit');
          chunks.push(chunk);
        }
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (error) {
      if (error instanceof ReleaseFailure) throw error;
      throw new ReleaseFailure(
        'GitHub request failed; no response body or credentials were recorded',
      );
    }
  };
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  let report: Json = { schemaVersion: 1, status: 'failed' };
  try {
    const context = releaseContext(process.env);
    report = {
      ...report,
      repository: context.repository,
      sourceCommit: context.commit,
      runID: context.runID,
      artifactID: context.artifactID,
    };
    let head: string, state: string;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }).trim();
      state = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      throw new ReleaseFailure('Could not verify the publication checkout');
    }
    requireProof(
      head === context.commit && state === '',
      'Publication requires the exact source SHA and a clean checkout',
    );
    report = await publishRelease(root, context, githubTransport(process.env.GITHUB_TOKEN || ''));
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Rivloom 发行：[${report.tag}](${report.url})\n`,
      );
    console.log(`Rivloom release published: ${report.url}`);
  } catch (error) {
    report.error =
      error instanceof ReleaseFailure
        ? error.message.slice(0, 240)
        : 'Rivloom release verification failed';
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    try {
      const directory = join(root, 'test-results', 'release');
      await mkdir(directory, { recursive: true });
      await regular(join(root, 'test-results'), true);
      await regular(directory, true);
      await writeFile(join(directory, 'release.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
      });
    } catch {
      console.error('Could not write the bounded Rivloom release report');
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
