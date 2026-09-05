// The PowerShell wrapper owns NSIS and HKCU restoration. This module never installs anything.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { measureInstaller } from './release-files.ts';
import { releaseVersionSchema } from './release-record.ts';
import { verifyRuntime } from './ci-verify-runtime.ts';
import { modelFixture, ServiceClient, until } from './m34-fixtures.ts';

export const previewProduct = 'Rivloom UI Preview';
export const previewIdentifier = 'com.rivloom.conversationpreview';
const repository = resolve(import.meta.dirname, '..');
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const sourceCommit = z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/);
const treeSchema = z.object({
  algorithm: z.literal('sha256-path-kind-size-content-v1'),
  sha256,
  files: z.number().int().positive().max(50_000),
  directories: z.number().int().positive().max(50_000),
  size: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 ** 3),
});
const candidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('candidate'),
    profile: z.literal('conversation-preview'),
    product: z.object({
      kind: z.literal('conversation-preview'),
      identifier: z.literal(previewIdentifier),
      version: releaseVersionSchema,
    }),
    target: z.literal('x86_64-pc-windows-msvc'),
    source: z
      .object({
        commit: sourceCommit,
        expectedCommit: sourceCommit,
        workingTree: z.literal('clean'),
        refType: z.enum(['branch', 'tag']),
        refName: z
          .string()
          .min(1)
          .max(250)
          .regex(/^[^\r\n]+$/),
        node: z.literal('24.19.0'),
        rust: z.literal('1.98.1'),
        cargo: z.literal('1.98.1'),
      })
      .passthrough(),
    artifact: z.object({
      fileName: z.string(),
      bytes: z
        .number()
        .int()
        .positive()
        .max(2 * 1024 ** 3),
      sha256,
    }),
    runtimeManifestSha256: sha256,
    runtimeTree: treeSchema,
    checks: z
      .object({
        runtimeBefore: z.literal('passed'),
        runtimeAfter: z.literal('passed'),
        runtimeUnchangedDuringBuild: z.literal(true),
      })
      .passthrough(),
    signing: z.object({
      requested: z.literal(false),
      verified: z.literal(false),
      updaterArtifacts: z.literal(false),
    }),
    publication: z.object({ published: z.literal(false), channel: z.null(), url: z.null() }),
  })
  .passthrough();
type Candidate = z.infer<typeof candidateSchema>;

export function validateCandidateRecord(value: unknown, expectedCommit: string): Candidate {
  sourceCommit.parse(expectedCommit);
  const record = candidateSchema.parse(value);
  assert.equal(
    record.source.commit,
    expectedCommit,
    'Candidate source differs from the requested commit',
  );
  assert.equal(
    record.source.expectedCommit,
    expectedCommit,
    'Candidate build requested another commit',
  );
  assert.equal(
    record.artifact.fileName,
    `${previewProduct}_${record.product.version}_x64-setup.exe`,
    'Unexpected candidate installer name',
  );
  if (record.source.refType === 'tag')
    assert.equal(
      record.source.refName,
      `ci-preview-v${record.product.version}`,
      'Candidate tag/version mismatch',
    );
  return record;
}

export function requireDescendant(parent: string, path: string) {
  const suffix = relative(resolve(parent), resolve(path));
  assert(
    suffix &&
      !isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith(`..\\`) &&
      !suffix.startsWith('../'),
    'Path must remain inside its permitted directory',
  );
  return suffix;
}

export function regularPath(parent: string, path: string, kind: 'file' | 'directory') {
  const suffix = requireDescendant(parent, path);
  const base = lstatSync(parent);
  assert(
    base.isDirectory() && !base.isSymbolicLink(),
    'The permitted parent must be a regular directory',
  );
  let cursor = resolve(parent);
  const parts = suffix.split(/[\\/]/);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = lstatSync(cursor);
    assert(!info.isSymbolicLink(), 'Links and junctions are not accepted');
    assert(
      index === parts.length - 1 && kind === 'file' ? info.isFile() : info.isDirectory(),
      'Unexpected path type',
    );
  }
  requireDescendant(realpathSync(parent), realpathSync(path));
  return resolve(path);
}

function readJson(parent: string, path: string) {
  regularPath(parent, path, 'file');
  assert(lstatSync(path).size <= 2 * 1024 * 1024, 'Verification JSON exceeds 2 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function systemEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles|programfiles\(x86\)|programdata|userprofile|homedrive|homepath|appdata|localappdata|temp|tmp|psmodulepath)$/i.test(
        name,
      ),
    ),
  );
}

function powershellJson(script: string, environment: NodeJS.ProcessEnv = {}) {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`],
      {
        env: { ...systemEnvironment(), ...environment },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).trim(),
  );
}

export async function verifyCandidate(root: string, directory: string, expectedCommit: string) {
  regularPath(root, join(root, 'test-results'), 'directory');
  regularPath(join(root, 'test-results'), directory, 'directory');
  const record = validateCandidateRecord(
    readJson(directory, join(directory, 'candidate-build.json')),
    expectedCommit,
  );
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  assert.equal(
    git(['rev-parse', 'HEAD']),
    expectedCommit,
    'Verification checkout is not the candidate commit',
  );
  assert.equal(
    git(['status', '--porcelain', '--untracked-files=all']),
    '',
    'Verification requires a clean checkout',
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    record.product.version,
    'Source application version differs',
  );
  const manifestPath = regularPath(directory, join(directory, 'runtime-manifest.json'), 'file');
  assert.equal(
    digest(readFileSync(manifestPath)),
    record.runtimeManifestSha256,
    'Candidate runtime manifest hash mismatch',
  );
  const manifest = readJson(directory, manifestPath);
  assert.equal(manifest.schemaVersion, 1, 'Unexpected runtime manifest schema');
  assert.deepEqual(manifest.product, record.product, 'Candidate runtime profile/version differs');
  assert.deepEqual(manifest.target, { platform: 'win32', arch: 'x64' });
  for (const name of ['runtime-before.json', 'runtime-after.json']) {
    const gate = readJson(directory, join(directory, name));
    assert.equal(gate.status, 'passed', `${name} did not pass`);
    assert.deepEqual(gate.product, record.product, `${name} belongs to another product`);
  }
  const installer = regularPath(directory, join(directory, record.artifact.fileName), 'file');
  assert.deepEqual(
    await measureInstaller(installer),
    record.artifact,
    'Installer bytes differ from the candidate record',
  );
  assert.equal(process.platform, 'win32', 'Installer resource inspection requires Windows');
  const resource = powershellJson(
    '$taskInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:RIVLOOM_PREVIEW_INSPECT_FILE); @{ ProductName = $taskInfo.ProductName; ProductVersion = $taskInfo.ProductVersion; FileDescription = $taskInfo.FileDescription } | ConvertTo-Json -Compress',
    { RIVLOOM_PREVIEW_INSPECT_FILE: installer },
  );
  assert.equal(
    resource.ProductName,
    previewProduct,
    'Installer PE resource is not the Preview product',
  );
  assert.equal(resource.FileDescription, previewProduct, 'Installer PE description is not Preview');
  assert.equal(resource.ProductVersion, record.product.version, 'Installer PE version differs');
  return {
    record,
    installer,
    candidateDirectory: resolve(directory),
    version: record.product.version,
    commit: expectedCommit,
    productName: previewProduct,
  };
}

// Same canonical algorithm as the build evidence, applied to the installed directory.
export function measureInstalledTree(directory: string) {
  const parent = lstatSync(directory);
  assert(
    parent.isDirectory() && !parent.isSymbolicLink(),
    'Installed runtime must be a regular directory',
  );
  const entries: Array<{
    path: string;
    kind: 'directory' | 'file';
    size?: number;
    sha256?: string;
  }> = [];
  const buffer = Buffer.alloc(1024 * 1024);
  let files = 0,
    directories = 0,
    size = 0;
  const walk = (suffix: string) => {
    assert(
      entries.length < 50_000 && suffix.length <= 512 && !/[\u0000-\u001f\u007f]/.test(suffix),
      'Installed runtime exceeds its path/entry limit',
    );
    const file = join(directory, suffix);
    const before = lstatSync(file);
    assert(!before.isSymbolicLink(), 'Installed runtime cannot contain a link or junction');
    if (before.isDirectory()) {
      directories++;
      entries.push({ path: suffix, kind: 'directory' });
      for (const name of readdirSync(file).sort()) walk(suffix ? `${suffix}/${name}` : name);
      const after = lstatSync(file);
      assert(
        after.isDirectory() &&
          !after.isSymbolicLink() &&
          after.ino === before.ino &&
          after.dev === before.dev &&
          after.mtimeMs === before.mtimeMs,
        'Installed directory changed while reading',
      );
      return;
    }
    assert(before.isFile(), 'Installed runtime accepts regular files only');
    files++;
    size += before.size;
    assert(size <= 8 * 1024 ** 3, 'Installed runtime exceeds its byte limit');
    const descriptor = openSync(file, 'r');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const opened = fstatSync(descriptor);
      assert(
        opened.ino === before.ino && opened.dev === before.dev,
        'Installed file changed before reading',
      );
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count;
        assert(bytes <= before.size, 'Installed file grew while reading');
        hash.update(buffer.subarray(0, count));
      }
      const after = fstatSync(descriptor),
        pathAfter = lstatSync(file);
      assert(
        bytes === before.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          pathAfter.isFile() &&
          !pathAfter.isSymbolicLink() &&
          pathAfter.ino === before.ino &&
          pathAfter.dev === before.dev &&
          pathAfter.size === before.size &&
          pathAfter.mtimeMs === before.mtimeMs,
        'Installed file changed while reading',
      );
    } finally {
      closeSync(descriptor);
    }
    entries.push({ path: suffix, kind: 'file', size: before.size, sha256: hash.digest('hex') });
  };
  walk('');
  assert(files > 0, 'Installed runtime is empty');
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    algorithm: 'sha256-path-kind-size-content-v1',
    sha256: digest(JSON.stringify(entries)),
    files,
    directories,
    size,
  };
}

export function verifyIsolatedRoot(root: string, testRoot: string) {
  const suffix = requireDescendant(join(root, 'test-results'), testRoot);
  assert(
    /^preview-install-[a-f0-9]{32}$/.test(suffix),
    'Unexpected Preview installation test directory',
  );
  return regularPath(root, testRoot, 'directory');
}

type ProcessInfo = {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  ExecutablePath: string | null;
  Created: string;
};
function processes(): ProcessInfo[] {
  return powershellJson(
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name="Created";Expression={if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")} else {""}}})',
  );
}
function sameProcess(left: ProcessInfo, right: ProcessInfo) {
  return (
    Boolean(left.Created && right.Created) &&
    left.ProcessId === right.ProcessId &&
    left.Created === right.Created &&
    left.ExecutablePath?.toLowerCase() === right.ExecutablePath?.toLowerCase()
  );
}
function noRivloom() {
  assert(
    !processes().some((item) => item.Name.toLowerCase() === 'rivloom.exe'),
    'A Rivloom process is running; it must not be stopped by this test',
  );
}

function guardedRoot(root: string, testRoot: string) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(
    process.env.RIVLOOM_PREVIEW_INSTALL_GUARDED,
    '1',
    'Use preview-install-smoke.ps1 for HKCU protection',
  );
  assert.equal(
    resolve(process.env.RIVLOOM_PREVIEW_INSTALL_ROOT || '.'),
    resolve(testRoot),
    'PowerShell guard belongs to another test',
  );
  return verifyIsolatedRoot(root, testRoot);
}

function assetPaths(root: string, runtime: string) {
  const dist = regularPath(runtime, join(runtime, 'dist'), 'directory');
  const directory = regularPath(dist, join(dist, 'assets'), 'directory');
  const files = readdirSync(directory);
  assert(files.length <= 2000, 'Too many UI assets');
  const brands = ['rivloom-wordmark', 'rivloom-symbol-gradient', 'rivloom-symbol-white'].map(
    (name) => {
      const source = regularPath(root, join(root, 'src', 'assets', 'brand', `${name}.png`), 'file');
      const matches = files.filter((file) => file.startsWith(`${name}-`) && file.endsWith('.png'));
      assert.equal(matches.length, 1, `Expected one installed ${name} image`);
      const path = regularPath(dist, join(directory, matches[0]), 'file');
      const sha256 = digest(readFileSync(path));
      assert.equal(
        sha256,
        digest(readFileSync(source)),
        `Installed ${name} differs from the original brand asset`,
      );
      return { path: `/assets/${matches[0]}`, sha256 };
    },
  );
  const index = readFileSync(regularPath(dist, join(dist, 'index.html'), 'file'), 'utf8');
  const references = [...index.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert(
    references.some((path) => path.endsWith('.js')) &&
      references.some((path) => path.endsWith('.css')),
    'Installed UI is missing its entry assets',
  );
  const entryAssets = [...new Set(references)].map((path) => {
    const file = regularPath(dist, join(dist, path.slice(1)), 'file');
    return { path, sha256: digest(readFileSync(file)) };
  });
  const expectedAccent = readFileSync(join(root, 'src', 'styles.css'), 'utf8')
    .match(/--accent\s*:\s*(#[\da-f]{6})\s*;/i)?.[1]
    .toLowerCase();
  assert(expectedAccent, 'Source brand accent is missing');
  const css = entryAssets
    .filter((item) => item.path.endsWith('.css'))
    .map((item) => readFileSync(join(dist, item.path.slice(1)), 'utf8'))
    .join('\n');
  assert(
    new RegExp(`--accent\\s*:\\s*${expectedAccent}(?:;|})`, 'i').test(css),
    'Installed UI does not contain the source brand accent',
  );
  return {
    indexSha256: digest(index),
    assets: [...entryAssets, ...brands],
    brands: brands.length,
    accent: expectedAccent,
  };
}

export function preservationCheckpoint(data: string) {
  const names = ['KEEP.txt', 'rivloom.sqlite', 'node-identity.json', 'brain-topology.json'];
  for (const optional of ['rivloom.sqlite-wal', 'rivloom.sqlite-shm'])
    if (existsSync(join(data, optional))) names.push(optional);
  return names.map((path) => {
    const file = regularPath(data, join(data, path), 'file');
    return { path, bytes: lstatSync(file).size, sha256: digest(readFileSync(file)) };
  });
}

async function runInstalled(
  root: string,
  directory: string,
  expectedCommit: string,
  testRoot: string,
) {
  guardedRoot(root, testRoot);
  const candidate = await verifyCandidate(root, directory, expectedCommit);
  const installation = regularPath(testRoot, join(testRoot, 'app'), 'directory');
  const executable = regularPath(installation, join(installation, 'Rivloom.exe'), 'file');
  const runtime = regularPath(installation, join(installation, 'runtime'), 'directory');
  regularPath(installation, join(installation, 'uninstall.exe'), 'file');
  const data = join(testRoot, 'data');
  assert(!existsSync(data), 'Preview smoke data must be new');
  const assertions: string[] = [];
  const proof: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'running',
    commit: expectedCommit,
    version: candidate.version,
    identifier: previewIdentifier,
    candidateSha256: candidate.record.artifact.sha256,
    testDirectory: relative(root, testRoot).replaceAll('\\', '/'),
    assertions,
    limits: [
      'Unsigned isolated Preview installation only; no public release or updater.',
      'No real model request, old-version upgrade, interactive GUI or physical-device acceptance.',
    ],
  };
  let desktop: ChildProcess | null = null;
  let known: ProcessInfo[] = [];
  let fixture: Awaited<ReturnType<typeof modelFixture>> | null = null;
  let failure: unknown;
  const rememberOwned = () => {
    const all = processes();
    const owned = all.filter((item) =>
      item.ExecutablePath?.toLowerCase().startsWith(installation.toLowerCase() + '\\'),
    );
    const identifiers = new Set(owned.map((item) => item.ProcessId));
    for (const previous of known) {
      const current = all.find((item) => item.ProcessId === previous.ProcessId);
      if (current && sameProcess(previous, current)) identifiers.add(previous.ProcessId);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of all)
        if (identifiers.has(item.ParentProcessId) && !identifiers.has(item.ProcessId)) {
          identifiers.add(item.ProcessId);
          owned.push(item);
          changed = true;
        }
    }
    for (const item of owned) {
      assert(
        item.Created,
        'Owned process creation time is unavailable; refusing ambiguous process cleanup',
      );
      if (!known.some((old) => sameProcess(old, item))) known.push(item);
    }
    return all;
  };
  const stopOwned = async () => {
    const all = rememberOwned();
    const errors: unknown[] = [];
    const stop = (owned: ProcessInfo) => {
      const current = processes().find((item) => sameProcess(item, owned));
      if (!current) return;
      try {
        execFileSync('taskkill.exe', ['/PID', String(current.ProcessId), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 20_000,
        });
      } catch (error) {
        // A process can exit after CIM inspection; continue cleaning its other
        // known children and only report errors for identities still alive.
        if (processes().some((item) => sameProcess(item, owned))) errors.push(error);
      }
    };
    const native = desktop?.pid
      ? all.find(
          (item) =>
            item.ProcessId === desktop!.pid &&
            item.ExecutablePath?.toLowerCase() === executable.toLowerCase(),
        )
      : undefined;
    if (native) stop(native);
    for (const owned of known) stop(owned);
    await until(
      async () => processes(),
      (values) => !values.some((item) => known.some((owned) => sameProcess(owned, item))),
      'owned Preview process cleanup',
      20_000,
    );
    desktop = null;
    known = [];
    if (errors.length)
      throw new AggregateError(errors, 'Owned Preview processes failed to stop cleanly');
  };
  try {
    assert.deepEqual(
      measureInstalledTree(runtime),
      candidate.record.runtimeTree,
      'Installed runtime differs from the build-verified file tree',
    );
    assert.equal(
      digest(readFileSync(join(runtime, 'runtime-manifest.json'))),
      candidate.record.runtimeManifestSha256,
    );
    const runtimeGate = await verifyRuntime({
      root,
      runtimeRoot: runtime,
      profile: 'conversation-preview',
    });
    proof.runtime = runtimeGate;
    assertions.push(
      'Installed runtime tree, identity, original licenses and pinned binaries match the candidate',
    );
    const ui = assetPaths(root, runtime);
    proof.ui = { brandImages: ui.brands, accent: ui.accent, assets: ui.assets.length };
    mkdirSync(data);
    writeFileSync(join(data, 'KEEP.txt'), 'Preview install smoke: retain this isolated data.\n', {
      flag: 'wx',
    });
    fixture = await modelFixture();
    fixture.configure(data);
    const socket = createSocket('udp4');
    await new Promise<void>((ok, fail) => {
      socket.once('error', fail);
      socket.bind(0, '127.0.0.1', ok);
    });
    const port = socket.address().port;
    await new Promise<void>((ok) => socket.close(ok));
    const environment = systemEnvironment();
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
      environment[name] = join(testRoot, 'environment', name.toLowerCase());
      mkdirSync(environment[name]!, { recursive: true });
    }
    Object.assign(environment, {
      RIVLOOM_DATA_DIR: data,
      RIVLOOM_DISCOVERY_PORT: String(port),
      RIVLOOM_MDNS_NETWORK: 'disabled',
      RIVLOOM_DISCOVERY_FALLBACK: 'enabled',
    });
    const expectedProtocol = Number(
      readFileSync(join(root, 'server', 'node-identity.ts'), 'utf8').match(
        /export const nodeProtocolVersion = (\d+);/,
      )?.[1],
    );
    assert(
      Number.isSafeInteger(expectedProtocol) && expectedProtocol > 0,
      'Source protocol version missing',
    );
    const start = async () => {
      noRivloom();
      desktop = spawn(executable, [], {
        cwd: installation,
        env: environment,
        windowsHide: true,
        stdio: 'ignore',
      });
      let spawnError: Error | null = null;
      desktop.once('error', (error) => {
        spawnError = error;
      });
      rememberOwned();
      const info = await until(
        async () => {
          if (spawnError) throw spawnError;
          assert(
            desktop!.exitCode === null && desktop!.signalCode === null,
            'Installed Preview exited during startup',
          );
          return readJson(data, join(data, 'desktop-runtime.json'));
        },
        (item) => item.desktopPID === desktop!.pid,
        'installed Preview runtime',
        75_000,
      );
      assert.equal(info.version, candidate.version);
      const url = new URL(info.url);
      assert(
        url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          Number(url.port) >= 49152 &&
          Number(url.port) <= 65535 &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        'Installed Preview returned an unexpected service URL',
      );
      const all = rememberOwned();
      assert(
        all.some(
          (item) =>
            item.ProcessId === info.backendPID &&
            item.ExecutablePath?.toLowerCase() === join(runtime, 'node.exe').toLowerCase(),
        ),
        'Backend is not the installed runtime',
      );
      const client = new ServiceClient(data);
      client.base = url.origin;
      await until(
        () => client.call<{ engineReady: boolean }>('/health'),
        (value) => value.engineReady,
        'installed official engine health',
        90_000,
      );
      await client.authenticate();
      const state = await client.bootstrap();
      assert.equal(state.engine.version, '1.18.25');
      assert.deepEqual(
        state.engine.models.map((model) => model.id),
        ['fixture/m34'],
      );
      const network = await client.network();
      assert(
        network.local && network.local.protocolVersion === expectedProtocol,
        'Installed protocol API is not available',
      );
      assert.equal(network.pairings.length, 0, 'Isolated test unexpectedly has pairings');
      const owned = rememberOwned();
      assert(
        owned.some(
          (item) =>
            item.ExecutablePath?.toLowerCase() ===
            join(
              runtime,
              'node_modules',
              'opencode-windows-x64',
              'bin',
              'opencode.exe',
            ).toLowerCase(),
        ),
        'Official engine did not start from installed resources',
      );
      return { client, nodeID: network.local.id };
    };
    const first = await start();
    const get = async (path: string) => {
      const response = await fetch(new URL(path, first.client.base), {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, `Installed UI failed to serve ${path}`);
      return Buffer.from(await response.arrayBuffer());
    };
    assert.equal(digest(await get('/')), ui.indexSha256, 'Served HTML differs from installed UI');
    for (const asset of ui.assets)
      assert.equal(
        digest(await get(asset.path)),
        asset.sha256,
        'Served UI asset differs from installed bytes',
      );
    assertions.push(
      'Installed EXE starts the bundled Node/OpenCode, authenticated protocol API and original blue UI assets',
    );
    await stopOwned();
    const second = await start();
    assert.equal(
      second.nodeID,
      first.nodeID,
      'Installed Preview lost its isolated identity across restart',
    );
    await stopOwned();
    assertions.push(
      'Installed Preview restarts with the same isolated identity; only owned process trees were stopped',
    );
    assert.equal(fixture.requests, 0, 'Installer smoke must not issue model requests');
    proof.modelRequests = 0;
    proof.preservedData = preservationCheckpoint(data);
    proof.status = 'awaiting-uninstall';
  } catch (error) {
    failure = error;
    proof.status = 'failed';
    proof.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await stopOwned();
    } catch (error) {
      failure ??= error;
      proof.status = 'failed';
      proof.cleanupError = error instanceof Error ? error.message : String(error);
    }
    if (fixture) {
      proof.modelRequests = fixture.requests;
      try {
        await fixture.close();
      } catch (error) {
        failure ??= error;
        proof.status = 'failed';
        proof.fixtureCleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    proof.checkedAt = new Date().toISOString();
    writeFileSync(join(testRoot, 'verification.json'), JSON.stringify(proof, null, 2) + '\n', {
      flag: 'wx',
    });
  }
  if (failure) throw failure;
  return { status: proof.status, testDirectory: proof.testDirectory };
}

export function verifyUninstalled(root: string, testRoot: string, expectedCommit: string) {
  sourceCommit.parse(expectedCommit);
  guardedRoot(root, testRoot);
  const proof = readJson(testRoot, join(testRoot, 'verification.json'));
  assert.equal(proof.status, 'awaiting-uninstall', 'Installed smoke did not pass');
  assert.equal(proof.commit, expectedCommit);
  assert.equal(proof.identifier, previewIdentifier);
  assert(
    !existsSync(join(testRoot, 'app', 'Rivloom.exe')) &&
      !existsSync(join(testRoot, 'app', 'runtime', 'node.exe')),
    'Isolated uninstall left installed executables',
  );
  assert.deepEqual(
    preservationCheckpoint(join(testRoot, 'data')),
    proof.preservedData,
    'Uninstall changed the separate Preview data',
  );
  proof.assertions.push(
    'Exact isolated uninstaller removed binaries and preserved the checked database, identity/topology and marker files byte for byte',
  );
  proof.status = 'awaiting-metadata-restore';
  writeFileSync(join(testRoot, 'verification.json'), JSON.stringify(proof, null, 2) + '\n');
  return { status: proof.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...arguments_] = process.argv.slice(2);
    const options = new Map<string, string>();
    for (let index = 0; index < arguments_.length; index += 2) {
      const key = arguments_[index],
        value = arguments_[index + 1];
      assert(
        ['--candidate-directory', '--expected-commit', '--root'].includes(key) &&
          value &&
          !value.startsWith('--') &&
          !options.has(key),
        'Unexpected Preview smoke arguments',
      );
      options.set(key, value);
    }
    const expected = sourceCommit.parse(options.get('--expected-commit'));
    if (operation === 'verify') {
      assert(options.size === 2 && options.has('--candidate-directory'));
      console.log(
        JSON.stringify(
          await verifyCandidate(
            repository,
            resolve(options.get('--candidate-directory')!),
            expected,
          ),
        ),
      );
    } else if (operation === 'installed') {
      assert(options.size === 3);
      console.log(
        JSON.stringify(
          await runInstalled(
            repository,
            resolve(options.get('--candidate-directory')!),
            expected,
            resolve(options.get('--root')!),
          ),
        ),
      );
    } else if (operation === 'uninstalled') {
      assert(options.size === 2 && options.has('--root'));
      console.log(
        JSON.stringify(verifyUninstalled(repository, resolve(options.get('--root')!), expected)),
      );
    } else
      throw new Error(
        'Use preview-install-smoke.ps1; internal operations: verify | installed | uninstalled',
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
