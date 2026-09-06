import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureInstaller } from './release-files.ts';
import { releaseVersionSchema } from './release-record.ts';
import { checkVersions } from './ci-version-check.ts';
import { ciRoot } from './ci-workspace.ts';

export const candidateProfile = 'desktop';
export const candidateIdentifier = 'com.rivloom.desktop';
export const candidateNode = '24.19.0';
export const candidateRust = '1.98.1';
export const candidateCargo = '1.98.1';
export const candidateTarget = 'x86_64-pc-windows-msvc';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const outputDirectory = (root: string) => join(root, 'test-results', 'candidate');
const runtimeManifest = (root: string) =>
  join(root, 'src-tauri', 'resources', 'runtime', 'runtime-manifest.json');

// Bind every bundled file, including server/shared/dist and dependencies, to the
// pre-build gate. Only aggregate evidence is published, never the runtime tree.
export function measureRuntimeTree(root: string) {
  const runtime = join(root, 'src-tauri', 'resources', 'runtime');
  for (const directory of ['src-tauri', 'src-tauri/resources', 'src-tauri/resources/runtime']) {
    const info = lstatSync(join(root, directory));
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      'Runtime parents must be regular directories',
    );
  }
  const entries: Array<{
    path: string;
    kind: 'directory' | 'file';
    size?: number;
    sha256?: string;
  }> = [];
  let size = 0;
  let files = 0;
  let directories = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  const walk = (relative: string) => {
    const absolute = join(runtime, relative);
    const before = lstatSync(absolute);
    assert(!before.isSymbolicLink(), 'Runtime tree cannot contain symbolic links or junctions');
    assert(
      relative.length <= 512 && !/[\u0000-\u001f\u007f]/.test(relative),
      'Invalid runtime path',
    );
    assert(entries.length < 50_000, 'Runtime tree exceeds its entry limit');
    if (before.isDirectory()) {
      directories += 1;
      entries.push({ path: relative, kind: 'directory' });
      for (const name of readdirSync(absolute).sort())
        walk(relative ? `${relative}/${name}` : name);
      const after = lstatSync(absolute);
      assert(
        after.isDirectory() &&
          !after.isSymbolicLink() &&
          before.ino === after.ino &&
          before.dev === after.dev &&
          before.mtimeMs === after.mtimeMs,
        'Runtime directory changed while measuring',
      );
      return;
    }
    assert(before.isFile(), 'Runtime tree accepts regular files and directories only');
    size += before.size;
    files += 1;
    assert(size <= 8 * 1024 ** 3, 'Runtime tree exceeds its byte limit');
    const descriptor = openSync(absolute, 'r');
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      const opened = fstatSync(descriptor);
      assert(
        opened.ino === before.ino && opened.dev === before.dev,
        'Runtime file changed before reading',
      );
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count;
        assert(bytes <= before.size, 'Runtime file grew while measuring');
        digest.update(buffer.subarray(0, count));
      }
      const after = fstatSync(descriptor);
      const pathAfter = lstatSync(absolute);
      assert(
        bytes === before.size &&
          after.size === before.size &&
          before.mtimeMs === after.mtimeMs &&
          pathAfter.isFile() &&
          !pathAfter.isSymbolicLink() &&
          pathAfter.ino === before.ino &&
          pathAfter.dev === before.dev &&
          pathAfter.size === before.size &&
          pathAfter.mtimeMs === before.mtimeMs,
        'Runtime file changed while measuring',
      );
    } finally {
      closeSync(descriptor);
    }
    entries.push({ path: relative, kind: 'file', size: before.size, sha256: digest.digest('hex') });
  };
  walk('');
  assert(files > 0, 'Runtime tree cannot be empty');
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    algorithm: 'sha256-path-kind-size-content-v1',
    sha256: hash(Buffer.from(JSON.stringify(entries))),
    files,
    directories,
    size,
  };
}

export interface CandidateContext {
  commit: string;
  expectedCommit: string;
  workingTree: 'clean' | 'dirty';
  refType: 'branch' | 'tag';
  refName: string;
  node: string;
  rust: string;
  cargo: string;
}

export function validateCandidateContext(version: string, context: CandidateContext) {
  releaseVersionSchema.parse(version);
  assert(!version.split('+')[0].includes('-'), 'Rivloom candidate requires a release version');
  assert.match(
    context.commit,
    /^(?!0{40}$)[0-9a-f]{40}$/,
    'Candidate requires a full source commit',
  );
  assert.equal(
    context.commit,
    context.expectedCommit,
    'Checkout commit differs from the requested GitHub commit',
  );
  assert.equal(context.workingTree, 'clean', 'Candidate source must be clean');
  assert.equal(context.node, candidateNode, 'Candidate Node toolchain drift');
  assert.equal(context.rust, candidateRust, 'Candidate Rust toolchain drift');
  assert.equal(context.cargo, candidateCargo, 'Candidate Cargo toolchain drift');
  assert(['branch', 'tag'].includes(context.refType), 'Unknown candidate ref type');
  assert(
    context.refName.length > 0 && context.refName.length <= 250 && !/[\r\n]/.test(context.refName),
    'Invalid candidate ref',
  );
  if (context.refType === 'tag')
    assert.equal(
      context.refName,
      `ci-v${version}`,
      'Rivloom candidate tag must match the application version',
    );
}

export function candidateConfig(version: string, context: CandidateContext) {
  validateCandidateContext(version, context);
  return {
    productName: 'Rivloom',
    identifier: candidateIdentifier,
    version,
    build: { beforeBuildCommand: null, beforeBundleCommand: null },
    bundle: {
      targets: ['nsis'],
      createUpdaterArtifacts: false,
      windows: { certificateThumbprint: null, signCommand: null },
    },
  };
}

export function captureContext(root: string): CandidateContext {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const version = (tool: string) =>
    execFileSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true })
      .trim()
      .split(/\s+/)[1]!;
  return {
    commit: git(['rev-parse', 'HEAD']),
    expectedCommit: process.env.RIVLOOM_CANDIDATE_SHA || process.env.GITHUB_SHA || '',
    workingTree: git(['status', '--porcelain', '--untracked-files=all']) ? 'dirty' : 'clean',
    refType: (process.env.RIVLOOM_CANDIDATE_REF_TYPE ||
      process.env.GITHUB_REF_TYPE) as CandidateContext['refType'],
    refName: process.env.RIVLOOM_CANDIDATE_REF_NAME || process.env.GITHUB_REF_NAME || '',
    node: process.versions.node,
    rust: version('rustc'),
    cargo: version('cargo'),
  };
}

export function configureCandidate(root: string, context: CandidateContext) {
  const version = checkVersions(root).versions.package as string;
  const configuration = candidateConfig(version, context);
  const directory = outputDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'build-config.json'),
    JSON.stringify(configuration, null, 2) + '\n',
    { flag: 'wx' },
  );
  writeFileSync(join(directory, 'source-context.json'), JSON.stringify(context, null, 2) + '\n', {
    flag: 'wx',
  });
  return configuration;
}

export function captureVerifiedRuntime(root: string) {
  const report = JSON.parse(
    readFileSync(join(outputDirectory(root), 'runtime-before.json'), 'utf8'),
  );
  assert.equal(report.status, 'passed', 'Pre-build runtime gate did not pass');
  const bytes = readFileSync(runtimeManifest(root));
  writeFileSync(
    join(outputDirectory(root), 'runtime-before-hash.json'),
    JSON.stringify({ sha256: hash(bytes), tree: measureRuntimeTree(root) }) + '\n',
    { flag: 'wx' },
  );
}

export async function recordCandidate(root: string, context: CandidateContext) {
  const version = checkVersions(root).versions.package as string;
  validateCandidateContext(version, context);
  const directory = outputDirectory(root);
  const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
  assert.deepEqual(
    read('source-context.json'),
    context,
    'Candidate source/toolchain changed during build',
  );
  assert.deepEqual(
    read('build-config.json'),
    candidateConfig(version, context),
    'Candidate configuration changed during build',
  );
  for (const file of ['runtime-before.json', 'runtime-after.json'])
    assert.equal(read(file).status, 'passed', `${file} did not pass`);
  const manifestBytes = readFileSync(runtimeManifest(root));
  assert.equal(
    hash(manifestBytes),
    read('runtime-before-hash.json').sha256,
    'Runtime changed after the pre-build gate',
  );
  const runtimeTree = measureRuntimeTree(root);
  assert.deepEqual(
    runtimeTree,
    read('runtime-before-hash.json').tree,
    'Runtime tree changed after the pre-build gate',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unknown runtime manifest schema');
  assert.deepEqual(
    manifest.product,
    { kind: candidateProfile, identifier: candidateIdentifier, version },
    'Prepared runtime is not this Rivloom candidate',
  );
  assert.deepEqual(
    manifest.target,
    { platform: 'win32', arch: 'x64' },
    'Unexpected runtime target',
  );
  const fileName = `Rivloom_${version}_x64-setup.exe`;
  const installer = join(
    root,
    'src-tauri',
    'target',
    candidateTarget,
    'release',
    'bundle',
    'nsis',
    fileName,
  );
  const artifact = await measureInstaller(installer);
  const record = {
    schemaVersion: 1,
    status: 'candidate',
    profile: candidateProfile,
    product: manifest.product,
    target: candidateTarget,
    source: context,
    artifact,
    runtimeManifestSha256: hash(manifestBytes),
    runtimeTree,
    checks: { runtimeBefore: 'passed', runtimeAfter: 'passed', runtimeUnchangedDuringBuild: true },
    signing: { requested: false, verified: false, updaterArtifacts: false },
    publication: { published: false, channel: null, url: null },
    limitations: [
      'Build/configuration and runtime identity checked; NSIS content has not been independently extracted or installed.',
      'No signature, clean-machine install, upgrade or physical-device acceptance is claimed.',
      'This build manifest is not a public release record or an updater manifest.',
    ],
  };
  // Copy only the final explicit installer and limited metadata. Never upload the runtime tree.
  cpSync(installer, join(directory, fileName), { force: false, errorOnExist: true });
  assert.deepEqual(
    await measureInstaller(join(directory, fileName)),
    artifact,
    'Copied candidate bytes differ',
  );
  writeFileSync(join(directory, 'runtime-manifest.json'), manifestBytes, { flag: 'wx' });
  writeFileSync(join(directory, 'candidate-build.json'), JSON.stringify(record, null, 2) + '\n', {
    flag: 'wx',
  });
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.platform, 'win32', 'Candidate builds require Windows');
  assert.equal(process.arch, 'x64', 'Candidate builds require x64');
  assert(
    !process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_PRIVATE_KEY,
    'Candidate workflow must not receive signing keys',
  );
  const operation = process.argv[2];
  if (operation === 'configure') configureCandidate(ciRoot, captureContext(ciRoot));
  else if (operation === 'capture-runtime') captureVerifiedRuntime(ciRoot);
  else if (operation === 'record')
    console.log(JSON.stringify(await recordCandidate(ciRoot, captureContext(ciRoot)), null, 2));
  else throw new Error('Use ci-candidate.ts configure | capture-runtime | record');
}
