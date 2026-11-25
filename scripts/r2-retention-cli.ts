// CLI entrypoint for R2 retention read-only planning (default) and explicit-approval cleanup.
// Never enables unattended auto-cleanup or bucket lifecycle expiration.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boundedBytes,
  discard,
  encodedObjectKey,
  r2Configuration,
  r2Transport,
} from './ci-r2-storage.ts';
import { DOWNLOAD_ORIGIN, parseDownloadRecord } from './download-record.ts';
import { parseLinuxDownloadRecord } from './linux-download-record.ts';
import { parseSignedUpdate } from './updater-manifest.ts';
import {
  applyR2RetentionPlan,
  extractDownloadKeysFromText,
  planR2Retention,
  renderRetentionAuditMarkdown,
  RetentionPolicyError,
  verifyPublicDownloadsAndUpdater,
  type GitHubReleaseRecord,
  type LiveRetentionSnapshot,
  type PublicEntryInputs,
  type R2InventoryDocument,
  type R2RetentionPlan,
} from './r2-retention.ts';

const manifestByteLimit = 64 * 1024;
const websitePageByteLimit = 2 * 1024 * 1024;
const websitePages = ['https://rivloom.com/download/', 'https://rivloom.com/en/download/'] as const;

export interface ParsedCliArgs {
  mode: 'plan' | 'apply';
  live: boolean;
  inventoryPath?: string;
  releasesPath?: string;
  windowsLatestPath?: string;
  linuxLatestPath?: string;
  updaterLatestPath?: string;
  websiteRefsPath?: string;
  manifestPath?: string;
  manifestSha256?: string;
  approveDelete: boolean;
  outDir: string;
  now?: string;
  sourceCommit?: string;
  inventoryRunID?: string;
  triggerVersion?: string;
  websiteCommit?: string;
  updaterPubKeyPath?: string;
  verifyFullBytes: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const args: ParsedCliArgs = {
    mode: 'plan',
    live: false,
    approveDelete: false,
    outDir: 'test-results/r2-retention',
    verifyFullBytes: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new RetentionPolicyError('missing-cli-argument', `Missing value for ${flag}`);
      i += 1;
      return argv[i];
    };
    if (flag === '--mode') {
      const value = next();
      if (value !== 'plan' && value !== 'apply') {
        throw new RetentionPolicyError('invalid-cli-mode', `Unsupported mode: ${value}`);
      }
      args.mode = value;
    } else if (flag === '--live') {
      args.live = true;
    } else if (flag === '--inventory') {
      args.inventoryPath = next();
    } else if (flag === '--releases') {
      args.releasesPath = next();
    } else if (flag === '--windows-latest') {
      args.windowsLatestPath = next();
    } else if (flag === '--linux-latest') {
      args.linuxLatestPath = next();
    } else if (flag === '--updater-latest') {
      args.updaterLatestPath = next();
    } else if (flag === '--website-refs') {
      args.websiteRefsPath = next();
    } else if (flag === '--manifest') {
      args.manifestPath = next();
    } else if (flag === '--manifest-sha256') {
      args.manifestSha256 = next();
    } else if (flag === '--approve-delete') {
      args.approveDelete = true;
    } else if (flag === '--out-dir') {
      args.outDir = next();
    } else if (flag === '--now') {
      args.now = next();
    } else if (flag === '--source-commit') {
      args.sourceCommit = next();
    } else if (flag === '--inventory-run-id') {
      args.inventoryRunID = next();
    } else if (flag === '--trigger-version') {
      args.triggerVersion = next();
    } else if (flag === '--website-commit') {
      args.websiteCommit = next();
    } else if (flag === '--updater-pub-key') {
      args.updaterPubKeyPath = next();
    } else if (flag === '--skip-full-byte-verify') {
      args.verifyFullBytes = false;
    } else {
      throw new RetentionPolicyError('unknown-cli-flag', `Unknown option: ${flag}`);
    }
  }
  return args;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function fetchGitHubReleases(token: string, repository = 'rivloom/rivloom-desktop'): Promise<GitHubReleaseRecord[]> {
  const releases: GitHubReleaseRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status !== 200) {
      await discard(response);
      throw new RetentionPolicyError('github-releases-read-failed', `HTTP ${response.status}`);
    }
    const batch = (await response.json()) as GitHubReleaseRecord[];
    if (!Array.isArray(batch)) {
      throw new RetentionPolicyError('github-releases-invalid-response');
    }
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function fetchPublicKeyJson<T>(
  key: string,
  parser: (value: unknown) => T,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(`${DOWNLOAD_ORIGIN}/${encodedObjectKey(key)}`, {
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    await discard(response);
    throw new RetentionPolicyError('public-entry-read-failed', `${key} returned HTTP ${response.status}`);
  }
  const bytes = await boundedBytes(response, manifestByteLimit);
  return parser(JSON.parse(bytes.toString('utf8')));
}

async function fetchLiveWebsiteReferences(fetcher: typeof fetch = fetch): Promise<string[]> {
  const refs = new Set<string>();
  for (const pageUrl of websitePages) {
    const response = await fetcher(pageUrl, {
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      await discard(response);
      throw new RetentionPolicyError('website-download-page-read-failed', `${pageUrl} returned HTTP ${response.status}`);
    }
    const html = (await boundedBytes(response, websitePageByteLimit)).toString('utf8');
    for (const key of extractDownloadKeysFromText(html)) refs.add(key);
  }
  if (refs.size === 0) {
    throw new RetentionPolicyError('website-references-empty', 'No download references discovered on live website pages');
  }
  return [...refs].sort();
}

async function loadPublicEntries(args: ParsedCliArgs, updaterPublicKey: string): Promise<PublicEntryInputs> {
  const windowsDownload = args.windowsLatestPath
    ? parseDownloadRecord(await readJsonFile(args.windowsLatestPath))
    : await fetchPublicKeyJson('releases/latest.json', parseDownloadRecord);

  const linuxDownload = args.linuxLatestPath
    ? parseLinuxDownloadRecord(await readJsonFile(args.linuxLatestPath))
    : await fetchPublicKeyJson('releases/linux/latest.json', parseLinuxDownloadRecord);

  const updaterManifest = args.updaterLatestPath
    ? parseSignedUpdate(await readJsonFile(args.updaterLatestPath), updaterPublicKey)
    : await fetchPublicKeyJson('updates/stable/latest.json', (value) =>
        parseSignedUpdate(value, updaterPublicKey),
      );

  let websiteReferences: string[];
  if (args.websiteRefsPath) {
    const raw = await readFile(args.websiteRefsPath, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new RetentionPolicyError('invalid-website-refs-file');
      }
      websiteReferences = parsed;
    } else {
      websiteReferences = extractDownloadKeysFromText(raw);
    }
  } else if (args.live) {
    websiteReferences = await fetchLiveWebsiteReferences();
  } else {
    throw new RetentionPolicyError(
      'missing-website-refs',
      'Provide --website-refs <path> in offline mode or pass --live',
    );
  }

  return {
    windowsDownload,
    linuxDownload,
    updaterManifest,
    websiteReferences,
  };
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const args = parseCliArgs(process.argv.slice(2));
  const outDir = resolve(root, args.outDir);
  await mkdir(outDir, { recursive: true });
  const updaterPublicKey = (
    await readFile(resolve(root, args.updaterPubKeyPath ?? 'src-tauri/updater.pub'), 'utf8')
  ).trim();

  if (args.mode === 'plan') {
    if (!args.inventoryPath) {
      throw new RetentionPolicyError('missing-inventory', 'Provide --inventory <objects.json>');
    }
    const inventory = await readJsonFile<R2InventoryDocument>(args.inventoryPath);
    const releases = args.releasesPath
      ? await readJsonFile<GitHubReleaseRecord[]>(args.releasesPath)
      : args.live
        ? await fetchGitHubReleases(process.env.GITHUB_TOKEN || '')
        : (() => {
            throw new RetentionPolicyError(
              'missing-releases',
              'Provide --releases <releases.json> in offline mode or pass --live',
            );
          })();
    const entries = await loadPublicEntries(args, updaterPublicKey);
    const plan = planR2Retention({
      inventory,
      releases,
      entries,
      now: args.now ? new Date(args.now) : new Date(),
      metadata: {
        sourceCommit: args.sourceCommit ?? process.env.GITHUB_SHA,
        inventoryRunID: args.inventoryRunID ?? process.env.GITHUB_RUN_ID,
        triggerVersion: args.triggerVersion,
        websiteCommit: args.websiteCommit,
      },
    });
    const auditMd = renderRetentionAuditMarkdown(plan);
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
    await writeFile(join(outDir, 'audit.md'), auditMd, 'utf8');
    console.log(
      JSON.stringify({
        mode: 'plan',
        readOnly: true,
        counts: plan.counts,
        manifestSha256: plan.manifestSha256,
        expiresAt: plan.expiresAt,
      }),
    );
    return;
  }

  // Controlled apply mode: requires explicit approval, manifest path, exact SHA-256, and live verification.
  if (!args.manifestPath || !args.manifestSha256) {
    throw new RetentionPolicyError(
      'missing-apply-arguments',
      'Apply mode requires --manifest <manifest.json>, --manifest-sha256 <sha256>, and --approve-delete',
    );
  }
  const envApproved = process.env.RIVLOOM_R2_CONFIRM_DELETE === 'DELETE_EXACT_MANIFEST';
  const explicitApproval = args.approveDelete && (args.live ? envApproved : true);
  const plan = await readJsonFile<R2RetentionPlan>(args.manifestPath);
  const storage = r2Transport(r2Configuration(process.env));
  const publicRead = (key: string) =>
    fetch(`${DOWNLOAD_ORIGIN}/${encodedObjectKey(key)}`, {
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(240_000),
    });

  const result = await applyR2RetentionPlan({
    plan,
    approvedManifestSha256: args.manifestSha256,
    explicitApproval,
    now: () => (args.now ? new Date(args.now) : new Date()),
    services: {
      storage,
      loadLiveState: async (): Promise<LiveRetentionSnapshot> => ({
        entries: await loadPublicEntries(args, updaterPublicKey),
        releases: args.releasesPath
          ? await readJsonFile<GitHubReleaseRecord[]>(args.releasesPath)
          : await fetchGitHubReleases(process.env.GITHUB_TOKEN || ''),
      }),
      verifyPostDelete: (deletedKeys, live) =>
        verifyPublicDownloadsAndUpdater({
          live,
          deletedKeys,
          updaterPublicKey,
          publicRead,
          verifyFullBytes: args.verifyFullBytes,
        }),
    },
  });

  const auditMd = renderRetentionAuditMarkdown(plan, result);
  await writeFile(join(outDir, 'apply-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(join(outDir, 'audit.md'), auditMd, 'utf8');
  console.log(
    JSON.stringify({
      mode: 'apply',
      status: result.status,
      counts: result.counts,
      manifestSha256: result.manifestSha256,
      pointersUntouched: result.pointersUntouched,
    }),
  );
  if (result.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    const code = error instanceof RetentionPolicyError ? error.code : 'r2-retention-failed';
    console.error(`R2 retention failed: ${code}`);
    process.exitCode = 1;
  });
}
