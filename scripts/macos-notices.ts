// Generate target-specific inventories without rewriting the reviewed Windows notices.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { generateNotices } from './notices.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function within(base: string, path: string) {
  const target = resolve(base, path), rel = relative(base, target);
  assert(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(path).startsWith('\\\\'), 'Unsafe license path');
  return target;
}
async function copyOriginal(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  assert(!info.isSymbolicLink(), 'License originals must not follow links');
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) await copyOriginal(join(source, entry), join(target, entry));
  } else {
    assert(info.isFile() && info.size > 0, 'License original is empty or not a file');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
  }
}

export async function prepareMacosNotices(root: string) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Mac notices require the native Apple Silicon dependency installation');
  const output = join(root, '.data', 'macos-notices');
  const docs = join(output, 'docs'), licenseRoot = join(docs, 'licenses');
  await mkdir(licenseRoot, { recursive: true });
  await generateNotices(root, output);
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin'], {
    cwd: join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 30_000_000,
  }));
  const previous = JSON.parse(await readFile(join(root, 'docs', 'desktop-dependency-licenses.json'), 'utf8'));
  const nodes = new Map<string, any>(metadata.resolve.nodes.map((node: any) => [node.id, node]));
  const reachable = new Set<string>();
  const pending: string[] = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id); assert(node, `Missing Cargo resolve node: ${id}`);
    pending.push(...node.dependencies);
  }
  const packages = [];
  for (const pkg of metadata.packages.filter((pkg: any) => reachable.has(pkg.id) && pkg.id !== metadata.resolve.root)) {
    assert(/^[A-Za-z0-9._-]+$/.test(pkg.name) && /^[A-Za-z0-9.+_-]+$/.test(pkg.version));
    const source = dirname(pkg.manifest_path);
    const files = (await readdir(source)).filter(file => /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(file));
    if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
    const target = join(licenseRoot, 'rust', `${pkg.name}-${pkg.version}`);
    await mkdir(target, { recursive: true });
    const upstreamNotices: string[] = [];
    for (const file of files) await copyOriginal(within(source, file), within(target, file));
    if (!files.length) {
      const cached = previous.packages.find((item: any) => item.name === pkg.name && item.version === pkg.version && item.license === pkg.license && item.repository === pkg.repository);
      if (cached?.licenseFiles?.length) {
        for (const file of cached.licenseFiles) {
          await copyOriginal(within(join(root, 'docs', 'licenses', 'rust', `${pkg.name}-${pkg.version}`), file), within(target, file));
          files.push(file);
        }
        upstreamNotices.push(...cached.upstreamNotices);
      }
    }
    if (!files.length) {
      const vcs = JSON.parse(await readFile(join(source, '.cargo_vcs_info.json'), 'utf8'));
      assert(/^[a-f0-9]{40}$/.test(vcs.git.sha1), 'Missing exact crate source revision');
      const repository = String(pkg.repository ?? '').replace(/\.git\/?$/, '').replace(/\/$/, '');
      assert(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), `Unreviewed license upstream: ${pkg.name}`);
      for (const name of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE_MIT', 'LICENSE_APACHE', 'LICENSE_APACHE-2.0', 'LICENSE.txt', 'LICENSE.md']) {
        const url = `${repository.replace('github.com', 'raw.githubusercontent.com')}/${vcs.git.sha1}/${name}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
        if (response.status === 404) continue;
        assert(response.ok, `License fetch failed (${response.status}): ${pkg.name}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert(bytes.length > 100 && bytes.length < 1_000_000, 'Invalid license original');
        await writeFile(join(target, name), bytes); files.push(name); upstreamNotices.push(url);
      }
      assert(files.length, `Missing license original: ${pkg.name}`);
    }
    let bundledSource: string | null = null;
    if (pkg.license?.includes('MPL-2.0')) {
      const archive = join(dirname(dirname(source)), '..', 'cache', source.split(/[\\/]/).at(-2)!, `${pkg.name}-${pkg.version}.crate`);
      const bytes = await readFile(archive);
      const checksum = JSON.parse(await readFile(join(source, '.cargo-checksum.json'), 'utf8'));
      assert.equal(sha256(bytes), checksum.package, `Crate source checksum mismatch: ${pkg.name}`);
      bundledSource = `${pkg.name}-${pkg.version}.crate`;
      await writeFile(join(target, bundledSource), bytes);
    }
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, licenseFiles: files, upstreamNotices, bundledSource });
  }
  assert(packages.length > 0);
  const inventoryPath = join(docs, 'desktop-dependency-licenses.json');
  await writeFile(inventoryPath, JSON.stringify({ date: new Date().toISOString(), scope: 'Cargo dependencies reachable for aarch64-apple-darwin, including build dependencies; not a complete binary SBOM', packages }, null, 2) + '\n');
  return { inventoryPath, npmInventoryPath: join(docs, 'dependency-licenses.json'), licenseRoot };
}
