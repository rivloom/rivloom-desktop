import { cp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = join(root, 'src-tauri', 'resources', 'runtime');
const cache = join(root, '.data', 'desktop-downloads');
const nodeVersion = '24.19.0';
const nodeHash = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const engineHash = 'ef06e41a35795066e95acde276a42fbbf85d7a683c2787f6a19ed20bcde9b6ff';
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
const engineFile = join(root, 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe');
if (sha(await readFile(engineFile)) !== engineHash)
  throw new Error('OpenCode 官方二进制哈希不匹配');

// This is a disposable, fixed build output. Never clean data directories or user projects.
const relativeDestination = relative(root, destination);
if (
  isAbsolute(relativeDestination) ||
  relativeDestination !== join('src-tauri', 'resources', 'runtime')
)
  throw new Error('非法构建输出目录');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const directory of ['server', 'shared', 'dist']) {
  await cp(join(root, directory), join(destination, directory), { recursive: true });
}
await cp(cachedNode, join(destination, 'node.exe'));
await cp(nodeLicense, join(destination, 'Node-LICENSE.txt'));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(destination, 'THIRD_PARTY_NOTICES.md'));
await cp(join(root, 'docs', 'licenses'), join(destination, 'docs', 'licenses'), {
  recursive: true,
});
await cp(
  join(root, 'docs', 'dependency-licenses.json'),
  join(destination, 'docs', 'dependency-licenses.json'),
);
const rustInventory = join(root, 'docs', 'desktop-dependency-licenses.json');
if (await exists(rustInventory))
  await cp(rustInventory, join(destination, 'docs', 'desktop-dependency-licenses.json'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
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
      type: 'module',
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);
await writeFile(
  join(destination, 'runtime-manifest.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      node: {
        version: nodeVersion,
        sha256: nodeHash,
        source: `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
      },
      opencode: { version: '1.18.25', sha256: engineHash, source: 'opencode-windows-x64@1.18.25' },
      packages,
    },
    null,
    2,
  ),
);
console.log(
  `Desktop runtime prepared: Node ${nodeVersion}, official OpenCode 1.18.25, ${packages.length} runtime packages. No user data or credentials copied.`,
);
