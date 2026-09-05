import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const engineVersion = '1.18.25';
const engineLicense = {
  repository: 'anomalyco/opencode',
  revision: 'v1.18.25',
  file: 'LICENSE',
  gitBlobSha1: '6439474beed8e0271df9862eff97ffd70ec2464c',
};
type UpstreamFile = typeof engineLicense;
type NoticeSource =
  | { kind: 'installed-package'; file: string; sha256: string }
  | {
      kind: 'upstream';
      url: string;
      revision: string;
      packageVersionSource: string;
      gitBlobSha1: string;
      sha256: string;
    };
export interface DependencyNotice {
  name: string;
  version: string;
  license: string;
  developmentOnly: boolean;
  integrity: string;
  packagePaths: string[];
  licenseFile: string;
  licenseFiles: string[];
  licenseSources: NoticeSource[];
}
function fallback(
  name: string,
  version: string,
): { files: UpstreamFile[]; versionSource: string } | undefined {
  if ((name === '@opencode-ai/sdk' || name === 'opencode-windows-x64') && version === engineVersion)
    return {
      files: [engineLicense],
      versionSource:
        name === '@opencode-ai/sdk'
          ? 'https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/packages/sdk/js/package.json'
          : 'https://registry.npmjs.org/opencode-windows-x64/1.18.25',
    };
  const tauriApi = name === '@tauri-apps/api' && version === '2.11.1';
  const tauriCli =
    (name === '@tauri-apps/cli' || name === '@tauri-apps/cli-win32-x64-msvc') &&
    version === '2.11.4';
  if (tauriApi || tauriCli) {
    // API revision comes from its npm SLSA provenance; CLI revision is npm gitHead.
    const revision = tauriApi
      ? '6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a'
      : '59585e1aac2d2e3503aa1caececf3568dce51a47';
    return {
      files: [
        {
          repository: 'tauri-apps/tauri',
          revision,
          file: 'LICENSE_MIT',
          gitBlobSha1: 'b08530d59433b3060f4fad8751ac2610c0b0aff3',
        },
        {
          repository: 'tauri-apps/tauri',
          revision,
          file: 'LICENSE_APACHE-2.0',
          gitBlobSha1: 'f433b1a53f5b830a205fd2df78e2b34974656c7b',
        },
      ],
      versionSource: tauriApi
        ? 'https://registry.npmjs.org/-/npm/v1/attestations/@tauri-apps%2fapi@2.11.1'
        : `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    };
  }
  if (name === '@rolldown/binding-win32-x64-msvc' && version === '1.2.6')
    return {
      files: [
        {
          repository: 'rolldown/rolldown',
          revision: 'v1.2.6',
          file: 'LICENSE',
          gitBlobSha1: 'afc0cdbabfb99ed4030bf9be2b852977f1ed72a0',
        },
      ],
      versionSource:
        'https://raw.githubusercontent.com/rolldown/rolldown/v1.2.6/packages/rolldown/package.json',
    };
}
function sourceUrl(file: UpstreamFile) {
  return `https://api.github.com/repos/${file.repository}/contents/${file.file}?ref=${encodeURIComponent(file.revision)}`;
}
async function upstream(file: UpstreamFile) {
  const response = await fetch(sourceUrl(file), {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Rivloom-license-notices' },
  });
  assert(response.ok, `Official license fetch failed (${response.status}): ${sourceUrl(file)}`);
  const result = (await response.json()) as { content?: string; encoding?: string; sha?: string };
  assert.equal(result.encoding, 'base64', 'Unexpected GitHub license response encoding');
  const bytes = Buffer.from(result.content ?? '', 'base64');
  assert(bytes.length > 100, 'Missing/truncated official license original');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, file.gitBlobSha1, 'Official license differs from reviewed release blob');
  assert.equal(result.sha, blob, 'GitHub license content differs from its blob identity');
  return bytes;
}
function component(value: string) {
  return encodeURIComponent(value);
}

export async function collectDependencyNotices(root: string): Promise<DependencyNotice[]> {
  root = resolve(root);
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const entries = new Map<string, DependencyNotice>();
  const outputs = new Map<string, Buffer>();
  const fetched = new Map<string, Promise<Buffer>>();
  for (const [path, info] of Object.entries(lock.packages) as [
    string,
    { version: string; license?: string; dev?: boolean; integrity?: string },
  ][]) {
    if (!path) continue;
    assert(
      path.startsWith('node_modules/') && !path.split('/').includes('..') && !path.includes('\\'),
      'Invalid locked npm path',
    );
    try {
      await access(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const name = path.split('node_modules/').at(-1)!;
    const installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
    assert.equal(installed.name, name, `Installed package name differs: ${path}`);
    assert.equal(installed.version, info.version, `Installed package version differs: ${path}`);
    assert(info.integrity, `Missing locked npm integrity: ${path}`);
    const files = (await readdir(join(root, path), { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const originals: { file: string; bytes: Buffer; source: NoticeSource }[] = [];
    for (const file of files) {
      const bytes = await readFile(join(root, path, file));
      assert(bytes.length > 0, `Empty installed license original: ${path}/${file}`);
      originals.push({
        file,
        bytes,
        source: { kind: 'installed-package', file, sha256: sha(bytes) },
      });
    }
    if (!originals.length) {
      const known = fallback(name, info.version);
      assert(
        known,
        `Missing license original without a reviewed version source: ${name}@${info.version}`,
      );
      for (const file of known.files) {
        const url = sourceUrl(file);
        if (!fetched.has(url)) fetched.set(url, upstream(file));
        const bytes = await fetched.get(url)!;
        originals.push({
          file: file.file,
          bytes,
          source: {
            kind: 'upstream',
            url,
            revision: file.revision,
            packageVersionSource: known.versionSource,
            gitBlobSha1: file.gitBlobSha1,
            sha256: sha(bytes),
          },
        });
      }
    }
    const licenseFiles = originals.map(
      (original) =>
        `licenses/npm/${component(name)}/${component(info.version)}/${component(original.file)}`,
    );
    const row: DependencyNotice = {
      name,
      version: info.version,
      license:
        info.license ||
        installed.license ||
        (name === 'opencode-windows-x64' ? 'MIT (upstream)' : ''),
      developmentOnly: !!info.dev,
      integrity: info.integrity,
      packagePaths: [path],
      licenseFile: licenseFiles[0],
      licenseFiles,
      licenseSources: originals.map((original) => original.source),
    };
    assert(row.license, `Missing SPDX/declared license metadata: ${name}@${info.version}`);
    const identity = `${name}@${info.version}`;
    const prior = entries.get(identity);
    if (prior) {
      assert.deepEqual(
        { ...row, developmentOnly: false, packagePaths: [] },
        { ...prior, developmentOnly: false, packagePaths: [] },
        `Conflicting notices for identical npm package: ${identity}`,
      );
      prior.packagePaths.push(path);
      prior.developmentOnly &&= row.developmentOnly;
    } else entries.set(identity, row);
    originals.forEach((original, i) => {
      const target = licenseFiles[i];
      const previous = outputs.get(target);
      if (previous)
        assert(previous.equals(original.bytes), `License filename collision: ${target}`);
      else outputs.set(target, original.bytes);
    });
  }
  assert(entries.size > 0, 'No installed dependency license inventory was collected');
  // Gather and reject conflicts before writing. Old filenames remain for prior references.
  for (const [path, bytes] of outputs) {
    const target = join(root, 'docs', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return [...entries.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}

export async function generateNotices(root = resolve(import.meta.dirname, '..')) {
  const entries = await collectDependencyNotices(root);
  const license = await upstream(engineLicense);
  await writeFile(join(root, 'docs/licenses/OpenCode-MIT.txt'), license);
  await writeFile(
    join(root, 'docs/dependency-licenses.json'),
    JSON.stringify(entries, null, 2) + '\n',
  );
  const binary = await readFile(join(root, 'node_modules/opencode-windows-x64/bin/opencode.exe'));
  await writeFile(
    join(root, 'docs/engine-lock.json'),
    JSON.stringify(
      {
        version: engineVersion,
        platform: 'windows-x64',
        package: 'opencode-windows-x64',
        sdk: '@opencode-ai/sdk',
        source: `https://github.com/anomalyco/opencode/releases/tag/v${engineVersion}`,
        license: 'MIT',
        licenseSource: `https://raw.githubusercontent.com/anomalyco/opencode/v${engineVersion}/LICENSE`,
        binarySha256: sha(binary),
        modified: false,
      },
      null,
      2,
    ) + '\n',
  );
  return {
    packages: entries.length,
    licenseFiles: entries.reduce((sum, row) => sum + row.licenseFiles.length, 0),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateNotices();
  console.log(
    `Recorded ${result.packages} unique installed dependency versions and ${result.licenseFiles} license originals. No missing license originals accepted.`,
  );
}
