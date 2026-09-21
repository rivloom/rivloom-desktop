import { cp, mkdir, readFile, writeFile, rm, access, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { prepareEngine } from './engine-prepare.ts';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'src-tauri', 'resources', 'runtime');
const cache = join(root, '.data', 'desktop-downloads');
const nodeVersion = '24.19.0';
const nodeHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--profile'))
  throw new Error(
    'Usage: node scripts/desktop-prepare.ts [--profile desktop|conversation-preview]',
  );
const profile = args[1] ?? 'desktop';
if (profile !== 'desktop' && profile !== 'conversation-preview')
  throw new Error('Invalid desktop runtime profile');
const formalConfig = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const productConfig =
  profile === 'conversation-preview'
    ? {
        ...formalConfig,
        ...JSON.parse(await readFile(join(root, 'src-tauri/tauri.preview.conf.json'), 'utf8')),
      }
    : formalConfig;
const rustInventory = join(root, 'docs', 'desktop-dependency-licenses.json');
// A missing native license inventory is a preparation failure, never an optional omission.
await access(rustInventory);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function download(url: string, target: string) {
  if (await exists(target)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`官方资源下载失败 (${response.status}): ${url}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('当前安装包只支持 Windows x64');
await mkdir(cache, { recursive: true });
const cachedNode = join(cache, 'node.exe');
if (!(await exists(cachedNode)) && sha(await readFile(process.execPath)) === nodeHash) {
  await cp(process.execPath, cachedNode);
}
await download(`https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`, cachedNode);
if (sha(await readFile(cachedNode)) !== nodeHash) throw new Error('Node 官方二进制哈希不匹配');
const nodeLicense = join(cache, 'Node-LICENSE.txt');
await download(
  `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
  nodeLicense,
);
const engine = await prepareEngine(root);

// This is a disposable, fixed build output. Never clean data directories or user projects.
const relativeDestination = relative(root, destination);
if (
  isAbsolute(relativeDestination) ||
  relativeDestination !== join('src-tauri', 'resources', 'runtime')
)
  throw new Error('非法构建输出目录');
for (const path of [root, join(root, 'src-tauri')])
  if ((await lstat(path)).isSymbolicLink()) throw new Error('构建输出父目录不能是链接');
// Git does not preserve this generated parent directory in a fresh checkout.
const resources = join(root, 'src-tauri/resources');
await mkdir(resources, { recursive: true });
const resourcesEntry = await lstat(resources);
if (resourcesEntry.isSymbolicLink() || !resourcesEntry.isDirectory())
  throw new Error('构建输出父目录必须是实际目录');
async function rejectLinks(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error('构建输出不能包含链接');
  if (entry.isDirectory()) for (const child of await readdir(path)) await rejectLinks(join(path, child));
}
if (await exists(destination)) await rejectLinks(destination);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const directory of ['server', 'shared', 'dist']) {
  await cp(join(root, directory), join(destination, directory), { recursive: true });
}
await cp(cachedNode, join(destination, 'node.exe'));
await cp(engine.directory, join(destination, engine.source.artifactPath), { recursive: true });
await cp(nodeLicense, join(destination, 'Node-LICENSE.txt'));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(destination, 'THIRD_PARTY_NOTICES.md'));
for (const notice of ['LICENSE', 'NOTICE']) {
  await cp(join(root, notice), join(destination, notice));
}
const documents: { path: string; sha256: string }[] = [];
for (const [source, path] of [
  [join(root, 'DESKTOP-README.md'), 'README.md'],
  [join(root, 'SECURITY.md'), 'SECURITY.md'],
] as const) {
  const bytes = await readFile(source);
  await writeFile(join(destination, path), bytes);
  documents.push({ path, sha256: sha(bytes) });
}
await cp(join(root, 'docs', 'licenses'), join(destination, 'docs', 'licenses'), {
  recursive: true,
});
await cp(
  join(root, 'docs', 'dependency-licenses.json'),
  join(destination, 'docs', 'dependency-licenses.json'),
);
await cp(rustInventory, join(destination, 'docs', 'desktop-dependency-licenses.json'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes.toString('utf8'));
const packages: { path: string; version: string; integrity?: string }[] = [];
for (const [path, value] of Object.entries(lock.packages) as [
  string,
  { dev?: boolean; optional?: boolean; version: string; integrity?: string },
][]) {
  if (!path || value.dev || !(await exists(join(root, path)))) continue;
  if (!path.startsWith('node_modules/') || path.includes('..')) throw new Error('非法依赖路径');
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await cp(join(root, path), join(destination, path), {
    recursive: true,
    dereference: true,
    filter: (source) => !relative(join(root, path), source).split(/[\\/]/).includes('node_modules'),
  });
  packages.push({ path, version: value.version, integrity: value.integrity });
}
await writeFile(
  join(destination, 'package.json'),
  JSON.stringify(
    {
      name: 'rivloom-desktop-runtime',
      version: manifest.version,
      private: true,
      license: manifest.license,
      type: 'module',
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
    },
    null,
    2,
  ),
);
async function noticeFiles(path: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(join(destination, path), { withFileTypes: true })).map((entry) =>
        entry.isDirectory() ? noticeFiles(`${path}/${entry.name}`) : [`${path}/${entry.name}`],
      ),
    )
  ).flat();
}
const noticePaths = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'Node-LICENSE.txt',
  'docs/dependency-licenses.json',
  'docs/desktop-dependency-licenses.json',
  `${engine.source.artifactPath}/LICENSE`,
  ...(await noticeFiles('docs/licenses')),
].sort();
const notices = await Promise.all(
  noticePaths.map(async (path) => ({
    path,
    sha256: sha(await readFile(join(destination, path))),
  })),
);
await writeFile(
  join(destination, 'runtime-manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      product: {
        kind: profile,
        identifier: productConfig.identifier,
        version: productConfig.version,
      },
      target: { platform: 'win32', arch: 'x64' },
      inputs: {
        packageLockSha256: sha(lockBytes),
        cargoLockSha256: sha(await readFile(join(root, 'src-tauri/Cargo.lock'))),
      },
      node: {
        version: nodeVersion,
        sha256: nodeHash,
        source: `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
      },
      opencode: { version: engine.source.version, sha256: engine.binarySHA256, source: `${engine.source.repository}#${engine.source.commit}` },
      documents,
      notices,
      packages,
    },
    null,
    2,
  ),
);
console.log(
  `Desktop runtime prepared: Node ${nodeVersion}, Rivloom OpenCode ${engine.source.version}, ${packages.length} runtime packages. No user data or credentials copied.`,
);
