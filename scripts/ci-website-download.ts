// Mirror a published Preview; never publish a GitHub release or execute an installer.
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  githubTransport,
  preparePreview,
  releaseContext,
  type ReleaseContext,
} from './ci-preview-release.ts';
import {
  parsePreviewDownloadRecord,
  parsePreviewDownloadState,
  PREVIEW_DOWNLOAD_ORIGIN,
  PREVIEW_DOWNLOAD_URL,
  type PreviewDownloadRecord,
} from './preview-download-record.ts';
import {
  boundedBytes,
  digest,
  discard,
  DownloadSyncFailure,
  encodedObjectKey,
  r2Configuration,
  r2Transport,
  requireDownload,
  responseDigest,
  strongEtag,
  type ObjectPayload,
  type ObjectTransport,
} from './ci-r2-storage.ts';

type Json = Record<string, any>;
type Plan = Awaited<ReturnType<typeof preparePreview>>;
export type WebsiteServices = {
  storage: ObjectTransport;
  github: (path: string) => Promise<unknown>;
  publicRead: (key: string) => Promise<Response>;
  deploy: () => Promise<void>;
  now?: () => Date;
};
const latestKey = 'previews/latest.json';
const manifestLimit = 64 * 1024;
const same = (left: unknown, right: unknown, code: string) =>
  requireDownload(isDeepStrictEqual(left, right), code);
const positiveID = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function pagesDeployHook(value: string | undefined): string {
  requireDownload(
    typeof value === 'string' &&
      /^https:\/\/api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(
        value,
      )?.[0] === value,
    'invalid-pages-deploy-hook',
  );
  return value;
}
export function websiteServices(
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): WebsiteServices {
  const config = r2Configuration(environment);
  const hook = pagesDeployHook(environment.RIVLOOM_PAGES_DEPLOY_HOOK);
  const token = environment.GITHUB_TOKEN || '';
  requireDownload(
    token.length > 0 && token.length <= 4096 && !/\s/.test(token),
    'invalid-github-token',
  );
  const context = releaseContext(environment);
  requireDownload(
    context.repository === 'rivloom/rivloom-desktop',
    'unexpected-download-repository',
  );
  const github = githubTransport(token);
  return {
    storage: r2Transport(config, fetcher),
    github: async (path) => {
      requireDownload(
        /^\/(?:releases\/\d+(?:\/assets\?per_page=100)?|releases\/assets\/\d+|git\/ref\/tags\/preview-v[0-9A-Za-z.%+_-]+|git\/tags\/[0-9a-f]{40}|compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\?per_page=1)$/.exec(
          path,
        )?.[0] === path,
        'invalid-github-read-path',
      );
      const result = await github({
        method: 'GET',
        url: `https://api.github.com/repos/${context.repository}${path}`,
      });
      requireDownload(result.status === 200, 'github-verification-request-failed');
      return result.body;
    },
    publicRead: async (key) => {
      try {
        return await fetcher(`${PREVIEW_DOWNLOAD_ORIGIN}/${encodedObjectKey(key)}`, {
          headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
          redirect: 'error',
          signal: AbortSignal.timeout(240_000),
        });
      } catch {
        throw new DownloadSyncFailure('public-download-request-failed');
      }
    },
    deploy: async () => {
      try {
        const response = await fetcher(hook, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        const successful = response.ok;
        await discard(response);
        requireDownload(successful, 'pages-deploy-hook-failed');
      } catch {
        throw new DownloadSyncFailure('pages-deploy-hook-failed');
      }
    },
  };
}

async function regular(path: string, directory = false) {
  const info = await lstat(path);
  requireDownload(
    !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    'invalid-download-evidence-file',
  );
  return info;
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DownloadSyncFailure('invalid-download-json');
  }
}
async function publishedReport(root: string, plan: Plan) {
  const directory = join(root, 'test-results', 'preview-release');
  await regular(directory, true);
  same(await readdir(directory), ['release.json'], 'unexpected-published-report-files');
  const path = join(directory, 'release.json');
  const info = await regular(path);
  requireDownload(info.size > 0 && info.size <= manifestLimit, 'invalid-published-report-size');
  const report = json(await readFile(path)) as Json;
  requireDownload(
    report &&
      typeof report === 'object' &&
      positiveID(report.releaseID) &&
      typeof report.reusedPublishedRelease === 'boolean',
    'invalid-published-report',
  );
  same(
    report,
    {
      schemaVersion: 1,
      status: 'published',
      repository: plan.repository,
      sourceCommit: plan.commit,
      runID: plan.runID,
      artifactID: plan.artifactID,
      tag: plan.tag,
      version: plan.version,
      releaseID: report.releaseID,
      url: `https://github.com/${plan.repository}/releases/tag/${encodeURIComponent(plan.tag)}`,
      reusedPublishedRelease: report.reusedPublishedRelease,
      assets: plan.assets.map(({ name, size, sha256 }) => ({ name, bytes: size, sha256 })),
    },
    'published-report-conflicts',
  );
  return report;
}
async function verifyPublishedRelease(plan: Plan, report: Json, github: WebsiteServices['github']) {
  const release = (await github(`/releases/${report.releaseID}`)) as Json;
  requireDownload(
    release?.id === report.releaseID &&
      release.draft === false &&
      release.prerelease === true &&
      release.tag_name === plan.tag &&
      release.target_commitish === plan.commit &&
      release.name === plan.title &&
      release.body === plan.body,
    'published-release-conflicts',
  );
  const date = release.published_at;
  requireDownload(
    typeof date === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.exec(date)?.[0] === date &&
      Number.isFinite(Date.parse(date)),
    'invalid-release-publication-time',
  );
  requireDownload(
    new Date(date).toISOString() === date ||
      new Date(date).toISOString().replace('.000Z', 'Z') === date,
    'invalid-release-publication-time',
  );
  const assets = (await github(`/releases/${report.releaseID}/assets?per_page=100`)) as Json[];
  requireDownload(
    Array.isArray(assets) &&
      assets.length === 2 &&
      new Set(assets.map((asset) => asset.name)).size === 2,
    'published-assets-conflict',
  );
  for (const asset of assets) {
    const expected = plan.assets.find(({ name }) => name === asset.name);
    requireDownload(expected && positiveID(asset.id), 'published-assets-conflict');
    const validate = (value: Json) =>
      requireDownload(
        value?.id === asset.id &&
          value.name === expected.name &&
          value.state === 'uploaded' &&
          value.size === expected.size &&
          value.digest === `sha256:${expected.sha256}`,
        'published-assets-conflict',
      );
    validate(asset);
    validate((await github(`/releases/assets/${asset.id}`)) as Json);
  }
  let object = ((await github(`/git/ref/tags/${encodeURIComponent(plan.tag)}`)) as Json).object;
  for (let depth = 0; depth < 6; depth++) {
    requireDownload(
      object && commitPattern.exec(object.sha)?.[0] === object.sha,
      'invalid-published-tag',
    );
    if (object.type === 'commit') {
      requireDownload(object.sha === plan.commit, 'published-tag-source-conflict');
      return date as string;
    }
    requireDownload(object.type === 'tag', 'invalid-published-tag');
    object = ((await github(`/git/tags/${object.sha}`)) as Json).object;
  }
  throw new DownloadSyncFailure('published-tag-depth-exceeded');
}

async function ensureObject(
  storage: ObjectTransport,
  key: string,
  payload: ObjectPayload,
  fileName: string,
) {
  const checkExisting = async (response: Response) => {
    const matches =
      response.status === 200 &&
      response.headers.get('content-length') === String(payload.bytes) &&
      response.headers.get('x-amz-meta-rivloom-sha256') === payload.sha256;
    await discard(response);
    requireDownload(matches, 'immutable-r2-object-conflicts');
  };
  const existing = await storage({ method: 'HEAD', key });
  if (existing.status === 200) {
    await checkExisting(existing);
    return;
  }
  const missing = existing.status === 404;
  await discard(existing);
  requireDownload(missing, 'r2-object-inspection-failed');
  const uploaded = await storage({
    method: 'PUT',
    key,
    payload,
    condition: { absent: true },
    contentType: 'application/octet-stream',
    contentDisposition: `attachment; filename="${fileName}"`,
    cacheControl: 'public, max-age=31536000, immutable',
  });
  const status = uploaded.status;
  await discard(uploaded);
  requireDownload(status === 200 || status === 412 || status === 409, 'r2-object-upload-failed');
  await checkExisting(await storage({ method: 'HEAD', key }));
}
function publicRecord(plan: Plan, releaseID: number, publishedAt: string, checkedAt: string) {
  const file = (index: number) => {
    const asset = plan.assets[index];
    return {
      fileName: asset.name,
      bytes: asset.size,
      sha256: asset.sha256,
      url: `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${plan.tag}/${asset.name}`,
    };
  };
  return parsePreviewDownloadRecord({
    schemaVersion: 1,
    kind: 'rivloom-preview-download',
    status: 'published',
    version: plan.version,
    product: { kind: 'conversation-preview', identifier: 'com.rivloom.conversationpreview' },
    source: { commit: plan.commit },
    build: { runID: plan.runID, artifactID: plan.artifactID },
    release: { id: releaseID, tag: plan.tag, publishedAt },
    artifact: file(0),
    checksum: file(1),
    signing: { authenticode: 'unsigned', tauriUpdater: 'not-configured' },
    verification: { ci: 'passed', installation: 'passed', publicDownload: 'passed', checkedAt },
  });
}
function binding(record: PreviewDownloadRecord) {
  return { ...record, verification: { ...record.verification, checkedAt: '' } };
}
async function latestState(services: WebsiteServices) {
  const response = await services.storage({ method: 'GET', key: latestKey });
  if (response.status === 404) {
    await discard(response);
    return { record: null, etag: null };
  }
  if (response.status !== 200) {
    await discard(response);
    throw new DownloadSyncFailure('latest-read-failed');
  }
  const etag = strongEtag(response.headers.get('etag'));
  const record = parsePreviewDownloadState(json(await boundedBytes(response, manifestLimit)));
  return { record, etag };
}
export async function promotionDecision(
  previous: PreviewDownloadRecord | null,
  next: PreviewDownloadRecord,
  github: WebsiteServices['github'],
) {
  if (!previous) return 'promote' as const;
  if (previous.source.commit === next.source.commit) {
    const oldID = Number(previous.build.artifactID),
      newID = Number(next.build.artifactID);
    if (oldID === newID) {
      same(binding(previous), binding(next), 'latest-artifact-identity-conflicts');
      return 'reuse' as const;
    }
    return newID > oldID ? ('promote' as const) : ('older-artifact' as const);
  }
  const comparison = (await github(
    `/compare/${previous.source.commit}...${next.source.commit}?per_page=1`,
  )) as Json;
  requireDownload(
    comparison?.base_commit?.sha === previous.source.commit,
    'source-comparison-conflicts',
  );
  if (comparison.status === 'behind') return 'source-behind' as const;
  if (comparison.status === 'diverged') return 'source-diverged' as const;
  requireDownload(
    comparison.status === 'ahead' &&
      comparison.merge_base_commit?.sha === previous.source.commit &&
      positiveID(comparison.ahead_by) &&
      comparison.behind_by === 0,
    'source-comparison-conflicts',
  );
  return 'promote' as const;
}

export async function synchronizeWebsiteDownload(
  root: string,
  context: ReleaseContext,
  services: WebsiteServices,
): Promise<Json> {
  const report: Json = {
    schemaVersion: 1,
    status: 'failed',
    stage: 'local-proof',
    completedStages: [],
    hookTriggered: false,
  };
  try {
    const safe = releaseContext({
      GITHUB_REPOSITORY: context.repository,
      RIVLOOM_CANDIDATE_SHA: context.commit,
      GITHUB_RUN_ID: context.runID,
      RIVLOOM_CANDIDATE_ARTIFACT_ID: context.artifactID,
    });
    requireDownload(
      safe.repository === 'rivloom/rivloom-desktop',
      'unexpected-download-repository',
    );
    Object.assign(report, {
      repository: safe.repository,
      sourceCommit: safe.commit,
      runID: safe.runID,
      artifactID: safe.artifactID,
    });
    const plan = await preparePreview(root, safe);
    const published = await publishedReport(root, plan);
    Object.assign(report, {
      releaseID: published.releaseID,
      tag: plan.tag,
      assets: plan.assets.map(({ name, size, sha256 }) => ({
        fileName: name,
        bytes: size,
        sha256,
        url: `${PREVIEW_DOWNLOAD_ORIGIN}/previews/${plan.tag}/${name}`,
      })),
    });
    report.completedStages.push(report.stage);
    report.stage = 'published-release';
    const publishedAt = await verifyPublishedRelease(plan, published, services.github);
    report.completedStages.push(report.stage);
    report.stage = 'mirror-files';
    for (const asset of plan.assets)
      await ensureObject(
        services.storage,
        `previews/${plan.tag}/${asset.name}`,
        {
          bytes: asset.size,
          sha256: asset.sha256,
          ...(asset.path ? { path: asset.path } : { body: asset.bytes }),
        },
        asset.name,
      );
    report.completedStages.push(report.stage);
    report.stage = 'public-downloads';
    for (const asset of plan.assets) {
      const response = await services.publicRead(`previews/${plan.tag}/${asset.name}`);
      if (response.status !== 200) {
        await discard(response);
        throw new DownloadSyncFailure('public-download-unavailable');
      }
      requireDownload(
        (await responseDigest(response, asset.size)) === asset.sha256,
        'public-download-digest-mismatch',
      );
    }
    const record = publicRecord(
      plan,
      published.releaseID,
      publishedAt,
      (services.now?.() || new Date()).toISOString(),
    );
    report.completedStages.push(report.stage);
    report.stage = 'latest';
    let selected: PreviewDownloadRecord | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await latestState(services);
      const decision = await promotionDecision(previous.record, record, services.github);
      if (decision === 'reuse') {
        selected = previous.record!;
        report.latestAction = 'reused';
        break;
      }
      if (decision !== 'promote')
        return {
          ...report,
          status: 'superseded',
          stage: 'complete',
          latestAction: 'not-promoted',
          reason: decision,
          latestTag: previous.record!.release.tag,
        };
      const bytes = encode(record);
      const response = await services.storage({
        method: 'PUT',
        key: latestKey,
        payload: { bytes: bytes.length, sha256: digest(bytes), body: bytes },
        condition: previous.etag ? { etag: previous.etag } : { absent: true },
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
      });
      const status = response.status;
      await discard(response);
      if (status === 412 || status === 409) continue;
      requireDownload(status === 200, 'latest-write-failed');
      selected = record;
      report.latestAction = 'promoted';
      break;
    }
    requireDownload(selected, 'latest-cas-exhausted');
    report.latestTag = selected.release.tag;
    report.completedStages.push(report.stage);
    report.stage = 'public-latest';
    const response = await services.publicRead(latestKey);
    if (response.status !== 200) {
      await discard(response);
      throw new DownloadSyncFailure('public-latest-unavailable');
    }
    same(
      parsePreviewDownloadRecord(json(await boundedBytes(response, manifestLimit))),
      selected,
      'public-latest-conflicts',
    );
    report.completedStages.push(report.stage);
    report.stage = 'deploy-hook';
    await services.deploy();
    report.hookTriggered = true;
    report.completedStages.push(report.stage);
    return { ...report, status: 'synced', stage: 'complete', url: PREVIEW_DOWNLOAD_URL };
  } catch (error) {
    return {
      ...report,
      error: error instanceof DownloadSyncFailure ? error.code : 'download-verification-failed',
    };
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  let report: Json = {
    schemaVersion: 1,
    status: 'failed',
    stage: 'configuration',
    hookTriggered: false,
  };
  try {
    const context = releaseContext(process.env);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).trim();
    const state = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).trim();
    requireDownload(head === context.commit && state === '', 'download-checkout-conflicts');
    report = await synchronizeWebsiteDownload(root, context, websiteServices(process.env));
  } catch (error) {
    report.error =
      error instanceof DownloadSyncFailure ? error.code : 'download-configuration-failed';
  }
  if (report.status === 'failed') process.exitCode = 1;
  try {
    const directory = join(root, 'test-results', 'website-download');
    await mkdir(directory, { recursive: true });
    await regular(join(root, 'test-results'), true);
    await regular(directory, true);
    await writeFile(join(directory, 'result.json'), encode(report), { flag: 'wx' });
  } catch {
    console.error('Could not write the bounded website download result');
    process.exitCode = 1;
  }
  console.log(`Website download synchronization: ${report.status}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
