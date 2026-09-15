import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type RuntimeProfile = 'desktop' | 'conversation-preview';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/);
const fileRecord = z.strictObject({ path: z.string().min(1), sha256: digest });
export const runtimeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  builtAt: z.iso.datetime(),
  product: z.strictObject({
    kind: z.enum(['desktop', 'conversation-preview']),
    identifier: z.string().min(1),
    version,
  }),
  target: z.strictObject({ platform: z.literal('win32'), arch: z.literal('x64') }),
  inputs: z.strictObject({ packageLockSha256: digest, cargoLockSha256: digest }),
  node: z.strictObject({ version, sha256: digest, source: z.string().min(1) }),
  opencode: z.strictObject({ version, sha256: digest, source: z.string().min(1) }),
  documents: z.array(fileRecord).min(2),
  notices: z.array(fileRecord).min(5),
  packages: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        version,
        integrity: z.string().min(1),
      }),
    )
    .min(1),
});
const npmInventorySchema = z
  .array(
    z.object({
      name: z.string().min(1),
      version,
      license: z.string().min(1),
      developmentOnly: z.boolean(),
      integrity: z.string().min(1),
      licenseFile: z.string().min(1).nullable(),
      licenseFiles: z.array(z.string().min(1)).min(1).optional(),
    }),
  )
  .min(1);
const rustInventorySchema = z.object({
  date: z.iso.datetime(),
  scope: z.string().min(1),
  packages: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        version,
        license: z.string().min(1),
        licenseFiles: z.array(z.string().min(1)).min(1),
        upstreamNotices: z.array(z.url()),
        bundledSource: z.string().min(1).nullable(),
      }),
    )
    .min(1),
});
type LockedPackage = {
  version: string;
  dev?: boolean;
  optional?: boolean;
  integrity?: string;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
};
export interface CargoPackage {
  name: string;
  version: string;
  license: string | null;
  manifestPath: string;
}
export interface RuntimeVerificationOptions {
  root?: string;
  runtimeRoot?: string;
  profile?: RuntimeProfile;
}
// Only the programmatic fixture tests substitute process boundaries. The CLI has no skip/mock flags.
export interface RuntimeVerificationTools {
  binaryVersion?: (file: string) => Promise<string>;
  cargoPackages?: (root: string) => Promise<CargoPackage[]>;
}

function inside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
function portablePath(value: string) {
  assert(
    value && !value.includes('\\') && !value.includes(':') && !value.includes('\0'),
    `Invalid manifest path: ${value}`,
  );
  assert(
    !value.startsWith('/') && value.split('/').every((p) => p && p !== '.' && p !== '..'),
    `Invalid manifest path: ${value}`,
  );
  return value;
}
async function regularFile(root: string, path: string) {
  portablePath(path);
  const file = resolve(root, path);
  assert(inside(root, file), `File escapes verification root: ${path}`);
  const info = await lstat(file);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size > 0,
    `Missing/empty/nonregular file: ${path}`,
  );
  assert(
    inside(await realpath(root), await realpath(file)),
    `File resolves outside verification root: ${path}`,
  );
  return file;
}
async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function json(root: string, path: string) {
  return JSON.parse(await readFile(await regularFile(root, path), 'utf8'));
}
function unique<T>(rows: T[], key: (row: T) => string, label: string) {
  const map = new Map<string, T>();
  for (const row of rows) {
    const name = key(row);
    assert(!map.has(name), `Duplicate ${label}: ${name}`);
    map.set(name, row);
  }
  return map;
}
function equalSet(actual: Iterable<string>, expected: Iterable<string>, label: string) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} membership differs`);
}
async function walkFiles(root: string, path: string): Promise<string[]> {
  portablePath(path);
  const directory = resolve(root, path);
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `Not a regular directory: ${path}`);
  assert(
    inside(await realpath(root), await realpath(directory)),
    `Directory escapes root: ${path}`,
  );
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const child = `${path}/${entry.name}`;
        assert(!entry.isSymbolicLink(), `Symbolic link is not an immutable runtime file: ${child}`);
        if (entry.isDirectory()) return walkFiles(root, child);
        await regularFile(root, child);
        return [child];
      }),
    )
  ).flat();
}
async function packagePaths(root: string, directory = 'node_modules'): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    assert(
      entry.isDirectory() && !entry.isSymbolicLink(),
      `Unexpected node_modules entry: ${entry.name}`,
    );
    const candidates = entry.name.startsWith('@')
      ? (await readdir(join(root, directory, entry.name))).map(
          (name) => `${directory}/${entry.name}/${name}`,
        )
      : [`${directory}/${entry.name}`];
    for (const path of candidates) {
      await regularFile(root, `${path}/package.json`);
      result.push(path);
      try {
        await lstat(join(root, path, 'node_modules'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      result.push(...(await packagePaths(root, `${path}/node_modules`)));
    }
  }
  return result;
}
function supports(values: string[] | undefined, target: string) {
  if (!values?.length) return true;
  return (
    !values.includes('!' + target) &&
    (values.every((v) => v.startsWith('!')) || values.includes(target))
  );
}
function sourcePin(script: string, name: string) {
  const matches = [...script.matchAll(new RegExp(`^const ${name} = '([^'\\r\\n]+)';$`, 'gm'))];
  assert.equal(matches.length, 1, `Missing/ambiguous reviewed runtime pin: ${name}`);
  return matches[0][1];
}
async function windowsX64Executable(file: string) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    assert.equal(
      (await handle.read(header, 0, 64, 0)).bytesRead,
      64,
      'Truncated executable DOS header',
    );
    assert.equal(
      header.toString('ascii', 0, 2),
      'MZ',
      'Runtime binary is not a Windows executable',
    );
    const pe = Buffer.alloc(26);
    assert.equal(
      (await handle.read(pe, 0, 26, header.readUInt32LE(60))).bytesRead,
      26,
      'Truncated PE header',
    );
    assert.equal(pe.toString('ascii', 0, 4), 'PE\0\0', 'Runtime binary has no PE signature');
    assert.equal(pe.readUInt16LE(4), 0x8664, 'Runtime binary is not x64');
    assert.equal(pe.readUInt16LE(24), 0x20b, 'Runtime binary is not PE32+');
  } finally {
    await handle.close();
  }
}
function systemEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles|programfiles\(x86\)|programdata)$/i.test(
        key,
      ),
    ),
  );
}
async function actualBinaryVersion(file: string) {
  assert.equal(process.platform, 'win32', 'Real runtime binary checks require Windows');
  const parent = await realpath(tmpdir());
  const scratch = await mkdtemp(join(parent, 'rivloom-runtime-version-'));
  try {
    const env = systemEnvironment();
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
    ]) {
      env[key] = join(scratch, key.toLowerCase());
      await mkdir(env[key]!, { recursive: true });
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
    });
    return execFileSync(file, ['--version'], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16_384,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } finally {
    assert(
      inside(parent, scratch) && inside(parent, await realpath(scratch)),
      'Invalid probe cleanup target',
    );
    await rm(scratch, { recursive: true, force: true });
  }
}
async function actualCargoPackages(root: string): Promise<CargoPackage[]> {
  // No builds, fetches or license generation: independently resolve the locked Windows graph offline.
  const env = systemEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(home|userprofile|homedrive|homepath|cargo_home|rustup_home|rustup_toolchain|temp|tmp)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  const selectedToolchain = Object.entries(env).find(
    ([key]) => key.toUpperCase() === 'RUSTUP_TOOLCHAIN',
  );
  assert(
    !selectedToolchain || /^1\.98\.1(?:-x86_64-pc-windows-msvc)?$/.test(selectedToolchain[1] ?? ''),
    'Runtime Cargo verification requires the pinned Rust 1.98.1 toolchain',
  );
  if (selectedToolchain) delete env[selectedToolchain[0]];
  env.RUSTUP_TOOLCHAIN = '1.98.1';
  env.RUSTUP_AUTO_INSTALL = '0';
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--locked',
        '--offline',
        '--format-version',
        '1',
        '--filter-platform',
        'x86_64-pc-windows-msvc',
      ],
      {
        cwd: join(root, 'src-tauri'),
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 30_000_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  assert(Array.isArray(metadata.packages) && metadata.resolve?.root, 'Incomplete Cargo metadata');
  return metadata.packages
    .filter((pkg: { id: string }) => pkg.id !== metadata.resolve.root)
    .map(
      (pkg: { name: string; version: string; license: string | null; manifest_path: string }) => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        manifestPath: pkg.manifest_path,
      }),
    );
}

export async function verifyRuntime(
  options: RuntimeVerificationOptions = {},
  tools: RuntimeVerificationTools = {},
) {
  const root = resolve(options.root ?? join(import.meta.dirname, '..'));
  const runtime = resolve(options.runtimeRoot ?? join(root, 'src-tauri/resources/runtime'));
  const profile = options.profile ?? 'desktop';
  assert(['desktop', 'conversation-preview'].includes(profile), 'Invalid runtime profile');
  const manifest = runtimeManifestSchema.parse(await json(runtime, 'runtime-manifest.json'));
  const app = await json(root, 'package.json');
  const lock = await json(root, 'package-lock.json');
  const formal = await json(root, 'src-tauri/tauri.conf.json');
  const tauri =
    profile === 'conversation-preview'
      ? { ...formal, ...(await json(root, 'src-tauri/tauri.preview.conf.json')) }
      : formal;
  const runtimePackage = await json(runtime, 'package.json');
  const cargoLockText = await readFile(await regularFile(root, 'src-tauri/Cargo.lock'), 'utf8');
  const cargoToml = await readFile(await regularFile(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargoToml
    .match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]
    .match(/^version\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
  const identity =
    profile === 'desktop' ? 'com.rivloom.desktop' : 'com.rivloom.conversationpreview';
  assert.equal(tauri.identifier, identity, 'Source Tauri profile identity mismatch');
  assert.deepEqual(
    manifest.product,
    { kind: profile, identifier: identity, version: app.version },
    'Runtime product identity/version mismatch',
  );
  for (const [name, value] of Object.entries({
    tauri: tauri.version,
    lock: lock.version,
    lockRoot: lock.packages?.['']?.version,
    cargo: cargoVersion,
    runtimePackage: runtimePackage.version,
  })) {
    assert.equal(value, app.version, `Application version mismatch: ${name}`);
  }
  assert.equal(runtimePackage.name, 'rivloom-desktop-runtime', 'Wrong runtime package identity');
  assert.equal(runtimePackage.private, true, 'Runtime package must be private');
  assert.equal(runtimePackage.type, 'module', 'Runtime package must use ESM');
  assert.deepEqual(
    runtimePackage.dependencies,
    app.dependencies,
    'Runtime dependencies differ from source package',
  );
  assert.deepEqual(
    lock.packages[''].dependencies,
    app.dependencies,
    'Lock root dependencies differ from source package',
  );
  assert.equal(
    manifest.inputs.packageLockSha256,
    await hashFile(await regularFile(root, 'package-lock.json')),
    'package-lock input hash drift',
  );
  assert.equal(
    manifest.inputs.cargoLockSha256,
    await hashFile(await regularFile(root, 'src-tauri/Cargo.lock')),
    'Cargo.lock input hash drift',
  );

  const documents = unique(manifest.documents, (row) => row.path, 'document');
  equalSet(documents.keys(), ['README.md', 'SECURITY.md'], 'Required documents');
  for (const [path, source] of [
    ['README.md', 'DESKTOP-README.md'],
    ['SECURITY.md', 'SECURITY.md'],
  ]) {
    const actual = await hashFile(await regularFile(runtime, path));
    assert.equal(actual, documents.get(path)!.sha256, `Bundled document hash drift: ${path}`);
    assert.equal(
      actual,
      await hashFile(await regularFile(root, source)),
      `Bundled document differs from source: ${path}`,
    );
  }

  const packages = unique(manifest.packages, (row) => portablePath(row.path), 'runtime package');
  const expected = new Map(
    Object.entries(lock.packages as Record<string, LockedPackage>).filter(
      ([path, pkg]) => path && !pkg.dev && supports(pkg.os, 'win32') && supports(pkg.cpu, 'x64'),
    ),
  );
  equalSet(packages.keys(), expected.keys(), 'Locked Windows runtime packages');
  equalSet(await packagePaths(runtime), expected.keys(), 'Actual installed runtime packages');
  for (const [path, pkg] of packages) {
    assert(
      /^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path),
      `Invalid package path: ${path}`,
    );
    const locked = expected.get(path)!;
    const actual = await json(runtime, `${path}/package.json`);
    const name = path.split('node_modules/').at(-1)!;
    assert.equal(pkg.version, locked.version, `Locked version differs: ${path}`);
    assert.equal(pkg.integrity, locked.integrity, `Locked integrity differs: ${path}`);
    assert.equal(actual.name, name, `Actual package name differs: ${path}`);
    assert.equal(actual.version, pkg.version, `Actual package version differs: ${path}`);
  }

  const notices = unique(manifest.notices, (row) => portablePath(row.path), 'notice');
  const fixedNotices = [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'Node-LICENSE.txt',
    'docs/dependency-licenses.json',
    'docs/desktop-dependency-licenses.json',
    'docs/licenses/OpenCode-MIT.txt',
  ];
  const actualNotices = [
    ...new Set([...fixedNotices, ...(await walkFiles(runtime, 'docs/licenses'))]),
  ];
  equalSet(notices.keys(), actualNotices, 'Bundled notice files');
  for (const [path, entry] of notices) {
    const actual = await hashFile(await regularFile(runtime, path));
    assert.equal(actual, entry.sha256, `Bundled notice hash drift: ${path}`);
    const source = path === 'Node-LICENSE.txt' ? '.data/desktop-downloads/Node-LICENSE.txt' : path;
    assert.equal(
      actual,
      await hashFile(await regularFile(root, source)),
      `Bundled notice differs from source: ${path}`,
    );
  }
  const npmInventory = npmInventorySchema.parse(
    await json(runtime, 'docs/dependency-licenses.json'),
  );
  const npmRows = new Map<string, (typeof npmInventory)[number]>();
  for (const row of npmInventory) {
    const key = `${row.name}@${row.version}`;
    if (npmRows.has(key))
      assert.deepEqual(row, npmRows.get(key), `Conflicting duplicate npm license: ${key}`);
    else npmRows.set(key, row);
  }
  const missingLicenses: string[] = [];
  for (const [path, pkg] of packages) {
    const name = path.split('node_modules/').at(-1)!;
    const row = npmRows.get(`${name}@${pkg.version}`);
    assert(
      row && !row.developmentOnly,
      `Missing runtime npm license inventory: ${name}@${pkg.version}`,
    );
    assert.equal(row.integrity, pkg.integrity, `npm license integrity differs: ${name}`);
    if (!row.licenseFile) {
      missingLicenses.push(`${name}@${pkg.version}`);
      continue;
    }
    const referencedFiles = row.licenseFiles ?? [row.licenseFile];
    assert(
      referencedFiles.includes(row.licenseFile),
      `npm primary license is not in licenseFiles: ${name}`,
    );
    unique(referencedFiles, (file) => file, `npm notice in ${name}`);
    for (const file of referencedFiles) {
      portablePath(file);
      assert(file.startsWith('licenses/'), `npm notice is outside licenses: ${name}`);
      assert(notices.has(`docs/${file}`), `Missing npm license original: ${name}`);
    }
    const upstreamFiles = (await readdir(join(runtime, path))).filter((file) =>
      /^licen[cs]e(?:[.\-_]|$)/i.test(file),
    );
    if (upstreamFiles.length) {
      const licenseHash = notices.get(`docs/${row.licenseFile}`)!.sha256;
      const upstreamHashes = await Promise.all(
        upstreamFiles.map(async (file) => hashFile(await regularFile(runtime, `${path}/${file}`))),
      );
      assert(
        upstreamHashes.includes(licenseHash),
        `npm license differs from actual installed original: ${name}@${pkg.version}`,
      );
    }
  }
  assert.equal(
    missingLicenses.length,
    0,
    `Runtime npm packages lack explicit license originals: ${missingLicenses.join(', ')}`,
  );

  const rust = rustInventorySchema.parse(
    await json(runtime, 'docs/desktop-dependency-licenses.json'),
  );
  const rustRows = unique(rust.packages, (row) => `${row.name}@${row.version}`, 'Rust license');
  const resolvedRust = await (tools.cargoPackages ?? actualCargoPackages)(root);
  const resolvedRows = unique(
    resolvedRust,
    (row) => `${row.name}@${row.version}`,
    'Cargo resolved package',
  );
  equalSet(rustRows.keys(), resolvedRows.keys(), 'Rust Windows dependency license inventory');
  const cargoLock = new Map(
    cargoLockText
      .split(/^\[\[package\]\]\s*$/m)
      .slice(1)
      .map((block) => {
        const value = (field: string) =>
          block.match(new RegExp(`^${field} = "([^"\\r\\n]+)"$`, 'm'))?.[1];
        return [`${value('name')}@${value('version')}`, { checksum: value('checksum') }];
      }),
  );
  assert(cargoLock.has(`rivloom-desktop@${app.version}`), 'Cargo.lock application version differs');
  for (const [key, row] of rustRows) {
    assert(cargoLock.has(key), `Rust license dependency is absent from Cargo.lock: ${key}`);
    assert.equal(row.license, resolvedRows.get(key)!.license, `Rust SPDX metadata differs: ${key}`);
    const directory = `docs/licenses/rust/${row.name}-${row.version}`;
    unique(row.licenseFiles, (file) => file, `Rust notice in ${key}`);
    for (const file of row.licenseFiles) {
      portablePath(file);
      assert(notices.has(`${directory}/${file}`), `Missing Rust license original: ${key}/${file}`);
      const upstreamRoot = dirname(resolvedRows.get(key)!.manifestPath);
      let original: string | undefined;
      try {
        original = await regularFile(upstreamRoot, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert(
          row.upstreamNotices.length > 0,
          `Rust license lacks installed original or recorded upstream source: ${key}/${file}`,
        );
      }
      if (original)
        assert.equal(
          notices.get(`${directory}/${file}`)!.sha256,
          await hashFile(original),
          `Rust license differs from actual Cargo original: ${key}/${file}`,
        );
    }
    if (row.license.includes('MPL-2.0'))
      assert(row.bundledSource, `Missing MPL source archive: ${key}`);
    if (row.bundledSource) {
      assert.equal(
        row.bundledSource,
        `${row.name}-${row.version}.crate`,
        `Wrong Rust source archive: ${key}`,
      );
      const source = `${directory}/${row.bundledSource}`;
      assert(notices.has(source), `Unlisted Rust source archive: ${key}`);
      assert.equal(
        await hashFile(await regularFile(runtime, source)),
        cargoLock.get(key)!.checksum,
        `Rust source archive differs from Cargo.lock checksum: ${key}`,
      );
    }
  }

  const prepare = await readFile(await regularFile(root, 'scripts/desktop-prepare.ts'), 'utf8');
  const engineLock = await json(root, 'docs/engine-lock.json');
  const nodeVersion = sourcePin(prepare, 'nodeVersion');
  const engineVersion = app.dependencies['opencode-windows-x64'];
  assert.equal(app.dependencies['@opencode-ai/sdk'], engineVersion, 'OpenCode SDK version differs');
  assert.equal(engineLock.version, engineVersion, 'Engine lock version differs');
  assert.equal(engineLock.modified, false, 'Engine lock is not the unmodified upstream binary');
  assert.equal(
    engineLock.binarySha256,
    sourcePin(prepare, 'engineHash'),
    'Engine lock hash differs from reviewed pin',
  );
  assert.deepEqual(
    manifest.node,
    {
      version: nodeVersion,
      sha256: sourcePin(prepare, 'nodeHash'),
      source: `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
    },
    'Node manifest differs from reviewed source pin',
  );
  assert.deepEqual(
    manifest.opencode,
    {
      version: engineVersion,
      sha256: sourcePin(prepare, 'engineHash'),
      source: `opencode-windows-x64@${engineVersion}`,
    },
    'OpenCode manifest differs from reviewed source pin',
  );
  const binaries = [
    { name: 'node', path: 'node.exe', entry: manifest.node, output: `v${nodeVersion}` },
    {
      name: 'opencode',
      path: 'node_modules/opencode-windows-x64/bin/opencode.exe',
      entry: manifest.opencode,
      output: engineVersion,
    },
  ];
  // Inspect and hash both files against reviewed pins before executing either one.
  for (const binary of binaries) {
    const file = await regularFile(runtime, binary.path);
    assert.equal(
      await hashFile(file),
      binary.entry.sha256,
      `Actual ${binary.name} binary SHA256 mismatch`,
    );
    await windowsX64Executable(file);
  }
  for (const binary of binaries) {
    const actual = await (tools.binaryVersion ?? actualBinaryVersion)(
      await regularFile(runtime, binary.path),
    );
    assert.equal(actual, binary.output, `Actual ${binary.name} --version mismatch`);
  }
  return {
    schemaVersion: 1,
    status: 'passed' as const,
    product: manifest.product,
    target: manifest.target,
    inputs: manifest.inputs,
    binaries: { node: manifest.node, opencode: manifest.opencode },
    documents: manifest.documents,
    packages: packages.size,
    licenses: { npmRuntime: packages.size, rust: rustRows.size, files: notices.size },
  };
}

export function parseRuntimeArguments(args: string[]): RuntimeVerificationOptions {
  const options: RuntimeVerificationOptions = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    assert(
      ['--root', '--runtime', '--profile'].includes(flag) &&
        value &&
        !value.startsWith('--') &&
        !seen.has(flag),
      'Usage: node scripts/ci-verify-runtime.ts [--root DIR] [--runtime DIR] [--profile desktop|conversation-preview]',
    );
    seen.add(flag);
    if (flag === '--root') options.root = resolve(value);
    if (flag === '--runtime') options.runtimeRoot = resolve(value);
    if (flag === '--profile') {
      assert(value === 'desktop' || value === 'conversation-preview', 'Invalid runtime profile');
      options.profile = value;
    }
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(await verifyRuntime(parseRuntimeArguments(process.argv.slice(2))), null, 2),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          status: 'failed',
          errors:
            error instanceof z.ZodError
              ? error.issues.map(
                  (issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`,
                )
              : [error instanceof Error ? error.message : String(error)],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
