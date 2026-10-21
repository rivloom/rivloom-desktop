// Generate target-specific inventories without rewriting the reviewed Windows notices.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { generateNotices } from './notices.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type CargoNoticePackage = { name: string; version: string; license: string | null; repository: string | null; source: string | null };
const objc2Repository = 'https://github.com/madsmtm/objc2';
const frameworkRevision = '7b1abfd750a2cacaea71d6a56ecfb83cb7de560b';
const objc2Revisions = new Map<string, string>([
  ['block2@0.6.2', 'b4167b582b2f75f9a1be75495c41b765344fd03c'],
  ['objc2@0.6.4', '8852b424193ca41602281b3d7540d7c8ed51e49a'],
  ['dispatch2@0.3.1', '8852b424193ca41602281b3d7540d7c8ed51e49a'],
  ['objc2-encode@4.1.0', '8d214f5477365ffcbcbb7de058c86ed9a518efb7'],
  ['objc2-exception-helper@0.1.1', '8d214f5477365ffcbcbb7de058c86ed9a518efb7'],
  ...['app-kit', 'cloud-kit', 'core-data', 'core-foundation', 'core-graphics', 'core-image',
    'core-location', 'core-text', 'foundation', 'io-surface', 'osa-kit', 'quartz-core',
    'ui-kit', 'user-notifications', 'web-kit'].map(name => [`objc2-${name}@0.3.2`, frameworkRevision] as const),
]);
const originalCache = new Map<string, Promise<Buffer>>();
async function pinnedOriginal(url: string, expected: string) {
  const key = `${url}:${expected}`;
  if (!originalCache.has(key)) originalCache.set(key, (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    assert(response.ok, `Pinned license source fetch failed (${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 100 && bytes.length < 100_000, 'Invalid pinned license source');
    assert.equal(sha256(bytes), expected, 'Pinned license source differs from its reviewed original');
    return bytes;
  })());
  return originalCache.get(key)!;
}

// A registry source tree does not contain the checksum file used by `cargo vendor`.
// Bind the copied source archive to the exact package and registry in Cargo.lock.
export function lockedCrateChecksum(lock: string, pkg: Pick<CargoNoticePackage, 'name' | 'version' | 'source'>) {
  const rows = lock.replace(/\r\n/g, '\n').split(/^\[\[package\]\][ \t]*$/m).slice(1).map(block => {
    const value = (field: string) => block.match(new RegExp(`^${field} = "([^"\\r\\n]+)"$`, 'm'))?.[1];
    return { name: value('name'), version: value('version'), source: value('source'), checksum: value('checksum') };
  }).filter(row => row.name === pkg.name && row.version === pkg.version && row.source === pkg.source);
  assert.equal(rows.length, 1, `Missing or ambiguous Cargo source checksum: ${pkg.name}`);
  assert(rows[0].checksum && /^[a-f0-9]{64}$/.test(rows[0].checksum), `Invalid Cargo source checksum: ${pkg.name}`);
  return rows[0].checksum;
}

/** Preserve the exact objc2 declaration and attribution, plus its selected complete license text. */
export async function prepareObjc2Notice(root: string, pkg: CargoNoticePackage, source: string, target: string) {
  if (pkg.repository !== objc2Repository) return undefined;
  const revision = objc2Revisions.get(`${pkg.name}@${pkg.version}`);
  assert(revision, `Unreviewed objc2 license revision: ${pkg.name}@${pkg.version}`);
  const vcs = JSON.parse(await readFile(join(source, '.cargo_vcs_info.json'), 'utf8'));
  assert.equal(vcs.git?.sha1, revision, 'objc2 crate source revision differs from the reviewed release');
  const mitOnly = ['objc2', 'block2', 'objc2-foundation', 'objc2-encode'].includes(pkg.name);
  assert.equal(pkg.license, mitOnly ? 'MIT' : 'Zlib OR Apache-2.0 OR MIT', 'objc2 license declaration changed');
  const selectedLicense = mitOnly ? 'MIT' : 'Apache-2.0';
  const upstream = `https://raw.githubusercontent.com/madsmtm/objc2/${revision}`;
  const originals = [
    { file: 'UPSTREAM-LICENSE.md', url: `${upstream}/LICENSE.md`, sha256: '7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54' },
    { file: 'UPSTREAM-README.md', url: `${upstream}/README.md`, sha256: revision === '8d214f5477365ffcbcbb7de058c86ed9a518efb7'
      ? '68208d19a19fa77b52003ee614309659f2470f47188e5ca4e840fc1e7d6aeb9c'
      : '84a32b17c487d0c6413b3401ec7ce5db3d2c591852d3987ee426878ca9c5b77f' },
  ];
  const files: string[] = [];
  await mkdir(target, { recursive: true });
  for (const original of originals) {
    await writeFile(join(target, original.file), await pinnedOriginal(original.url, original.sha256));
    files.push(original.file);
  }
  const attribution = [];
  for (const file of ['Cargo.toml', 'Cargo.toml.orig', 'README.md', '.cargo_vcs_info.json']) {
    const output = file === '.cargo_vcs_info.json' ? 'CRATE-vcs.json' : `CRATE-${file}`;
    await copyOriginal(within(source, file), within(target, output));
    files.push(output);
    attribution.push({ file: output, source: `published-crate/${file}`, sha256: sha256(await readFile(join(target, output))) });
  }
  // These tracked copies were compared to the primary originals. Preserve the MIT
  // template's placeholder; author metadata is kept above, never turned into a
  // fabricated copyright notice. The Apache copy only lacks its initial blank line.
  const cachedText = mitOnly ? 'docs/licenses/npm/binary/0.3.0/text%2FMIT.txt' : 'LICENSE';
  const standard = Buffer.from((mitOnly ? '' : '\n') + (await readFile(join(root, cachedText), 'utf8')).replace(/\r\n/g, '\n'));
  const standardHash = mitOnly ? 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'
    : 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
  assert.equal(sha256(standard), standardHash, 'Tracked standard license text differs from the reviewed original');
  const standardFile = `STANDARD-${selectedLicense}.txt`;
  await writeFile(join(target, standardFile), standard); files.push(standardFile);
  const standardURL = mitOnly ? 'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt'
    : 'https://www.apache.org/licenses/LICENSE-2.0.txt';
  return { files, upstreamNotices: [...originals.map(item => item.url), standardURL], selection: {
    selectedLicense, declaredLicense: pkg.license, sourceRevision: revision,
    explanation: mitOnly
      ? 'The exact upstream declaration specifies MIT only for this crate. Its original declaration, package metadata and upstream attribution accompany the unchanged full SPDX MIT standard text; no copyright holder or year has been invented.'
      : 'The exact upstream declaration permits Zlib OR Apache-2.0 OR MIT. This distribution selects Apache-2.0 and includes its complete Apache Software Foundation text alongside the original declaration and attribution.',
    originals, attribution, standardText: { file: standardFile, url: standardURL, sha256: standardHash, trackedSource: cachedText },
  } };
}

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
  const cargoLock = await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8');
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
    const objc2 = await prepareObjc2Notice(root, pkg, source, target);
    if (objc2) { files.push(...objc2.files); upstreamNotices.push(...objc2.upstreamNotices); }
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
      assert.equal(sha256(bytes), lockedCrateChecksum(cargoLock, pkg), `Crate source checksum mismatch: ${pkg.name}`);
      bundledSource = `${pkg.name}-${pkg.version}.crate`;
      await writeFile(join(target, bundledSource), bytes);
    }
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, licenseFiles: files, upstreamNotices, bundledSource,
      ...(objc2 ? { licenseSelection: objc2.selection } : {}) });
  }
  assert(packages.length > 0);
  const inventoryPath = join(docs, 'desktop-dependency-licenses.json');
  await writeFile(inventoryPath, JSON.stringify({ date: new Date().toISOString(), scope: 'Cargo dependencies reachable for aarch64-apple-darwin, including build dependencies; not a complete binary SBOM', packages }, null, 2) + '\n');
  return { inventoryPath, npmInventoryPath: join(docs, 'dependency-licenses.json'), licenseRoot };
}
