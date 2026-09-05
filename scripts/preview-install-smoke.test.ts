import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { measureRuntimeTree } from './ci-candidate.ts';
import {
  measureInstalledTree,
  preservationCheckpoint,
  previewIdentifier,
  regularPath,
  requireDescendant,
  validateCandidateRecord,
  verifyIsolatedRoot,
  verifyUninstalled,
} from './preview-install-smoke.ts';

const commit = '1'.repeat(40);
const digest = 'a'.repeat(64);
const repository = resolve(import.meta.dirname, '..');

test(
  'PowerShell metadata guards reject path-bearing old binary names and unrecognized partial changes',
  { skip: process.platform !== 'win32' },
  () => {
    // Extract only these pure function definitions from the AST. The wrapper's
    // top-level code, registry access, installers and process helpers never run.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskTokens = $null
$taskErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile($env:RIVLOOM_PREVIEW_TEST_SCRIPT, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count -ne 0) { throw 'PowerShell wrapper has a syntax error.' }
foreach ($taskName in @('Read-Value', 'Same-Metadata', 'Assert-SafePreviousBinary', 'Safe-PartialMetadata')) {
  $taskFunctions = @($taskAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $taskName }, $true))
  if ($taskFunctions.Count -ne 1) { throw 'Expected one pure guard function.' }
  . ([scriptblock]::Create($taskFunctions[0].Extent.Text))
}
function Expect-Failure([scriptblock]$Action) {
  $taskRejected = $false
  try { & $Action } catch { $taskRejected = $true }
  if (-not $taskRejected) { throw 'Unsafe synthetic metadata was accepted.' }
}
function Metadata($Values) { return @{ Exists = $true; Values = @($Values) } }
function Value([string]$Name, [string]$Kind, $Data) { return @{ Name = $Name; Kind = $Kind; Value = $Data } }
$taskMissing = @{ Exists = $false; Values = @() }
Assert-SafePreviousBinary $taskMissing
Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'String' 'Rivloom.exe')))
foreach ($taskUnsafeName in @('..\outside.exe', 'C:\outside.exe', 'another.exe', '')) {
  Expect-Failure { Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'String' $taskUnsafeName))) }
}
Expect-Failure { Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'DWord' 1))) }
$taskInstall = 'C:\synthetic-preview\app'
$taskPlan = @{ version = '0.1.3' }
$taskPreviewProductKey = 'Software\rivloom\Rivloom UI Preview'
$taskPreviewUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom UI Preview'
$taskUninstallAttempted = $false
$taskPartial = Metadata @((Value 'InstallLocation' 'String' ('"' + $taskInstall + '"')), (Value 'DisplayVersion' 'String' '0.1.3'), (Value 'NoModify' 'DWord' 1))
if (-not (Safe-PartialMetadata $taskPreviewUninstallKey $taskPartial $taskMissing)) { throw 'Known partial state rejected.' }
foreach ($taskUnexpected in @((Value 'DisplayVersion' 'String' '0.1.4'), (Value 'NoModify' 'String' '1'), (Value 'EstimatedSize' 'DWord' 123), (Value 'UninstallString' 'String' 'C:\outside.exe'), (Value 'ConcurrentValue' 'String' 'new'))) {
  $taskAltered = Metadata @((Value 'InstallLocation' 'String' ('"' + $taskInstall + '"')), $taskUnexpected)
  if (Safe-PartialMetadata $taskPreviewUninstallKey $taskAltered $taskMissing) { throw 'Unrecognized partial metadata accepted.' }
}
$taskOriginal = Metadata @((Value 'UnrelatedOriginal' 'String' 'preserve me'))
if (Safe-PartialMetadata $taskPreviewUninstallKey $taskPartial $taskOriginal) { throw 'Deleted original metadata accepted.' }
$taskWithOriginal = Metadata @($taskPartial.Values + $taskOriginal.Values)
if (-not (Safe-PartialMetadata $taskPreviewUninstallKey $taskWithOriginal $taskOriginal)) { throw 'Unchanged original metadata rejected.' }
if (Safe-PartialMetadata $taskPreviewUninstallKey $taskMissing $taskOriginal) { throw 'Unexplained deleted key accepted.' }
$taskUninstallAttempted = $true
if (-not (Safe-PartialMetadata $taskPreviewUninstallKey $taskMissing $taskOriginal)) { throw 'Known uninstall deletion rejected.' }
if (Safe-PartialMetadata $taskPreviewProductKey $taskMissing $taskOriginal) { throw 'Uninstaller cannot delete the product key in update mode.' }
Write-Output 'Pure metadata guard tests passed.'
`;
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: {
          ...process.env,
          RIVLOOM_PREVIEW_TEST_SCRIPT: join(repository, 'scripts', 'preview-install-smoke.ps1'),
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.match(output, /Pure metadata guard tests passed/);
  },
);

// Synthetic files only. These tests do not inspect/write registry keys, execute
// installers, launch Rivloom/OpenCode or connect to a model service.
function fixture() {
  const parent = join(repository, 'test-results');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'preview-smoke-selftest-'));
}

function candidate() {
  return {
    schemaVersion: 1,
    status: 'candidate',
    profile: 'conversation-preview',
    product: { kind: 'conversation-preview', identifier: previewIdentifier, version: '0.1.3' },
    target: 'x86_64-pc-windows-msvc',
    source: {
      commit,
      expectedCommit: commit,
      workingTree: 'clean',
      refType: 'tag',
      refName: 'ci-preview-v0.1.3',
      node: '24.19.0',
      rust: '1.98.1',
      cargo: '1.98.1',
    },
    artifact: { fileName: 'Rivloom UI Preview_0.1.3_x64-setup.exe', bytes: 512, sha256: digest },
    runtimeManifestSha256: digest,
    runtimeTree: {
      algorithm: 'sha256-path-kind-size-content-v1',
      sha256: digest,
      files: 1,
      directories: 1,
      size: 100,
    },
    checks: { runtimeBefore: 'passed', runtimeAfter: 'passed', runtimeUnchangedDuringBuild: true },
    signing: { requested: false, verified: false, updaterArtifacts: false },
    publication: { published: false, channel: null, url: null },
  };
}

test('installer verifier rejects source, product, artifact, runtime and publication drift', () => {
  assert.equal(validateCandidateRecord(candidate(), commit).product.identifier, previewIdentifier);
  const branch = candidate();
  branch.source.refType = 'branch';
  branch.source.refName = 'main';
  validateCandidateRecord(branch, commit);
  for (const mutate of [
    (record: ReturnType<typeof candidate>) => {
      record.source.commit = '2'.repeat(40);
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.expectedCommit = '2'.repeat(40);
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.workingTree = 'dirty';
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.refName = 'v0.1.3';
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.node = '24.18.0';
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.rust = '1.97.0';
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.cargo = '1.97.0';
    },
    (record: ReturnType<typeof candidate>) => {
      record.product.identifier = 'com.rivloom.desktop';
    },
    (record: ReturnType<typeof candidate>) => {
      record.product.version = '0.1.4';
    },
    (record: ReturnType<typeof candidate>) => {
      record.artifact.fileName = '../Rivloom.exe';
    },
    (record: ReturnType<typeof candidate>) => {
      record.artifact.sha256 = 'invalid';
    },
    (record: ReturnType<typeof candidate>) => {
      record.runtimeTree.algorithm = 'sha256';
    },
    (record: ReturnType<typeof candidate>) => {
      record.runtimeTree.size = 9 * 1024 ** 3;
    },
    (record: ReturnType<typeof candidate>) => {
      record.checks.runtimeAfter = 'failed';
    },
    (record: ReturnType<typeof candidate>) => {
      record.checks.runtimeUnchangedDuringBuild = false;
    },
    (record: ReturnType<typeof candidate>) => {
      record.signing.updaterArtifacts = true;
    },
    (record: ReturnType<typeof candidate>) => {
      record.publication.published = true;
    },
  ]) {
    const record = candidate();
    mutate(record);
    assert.throws(() => validateCandidateRecord(record, commit));
  }
  assert.throws(() => validateCandidateRecord(candidate(), '0'.repeat(40)));
});

test('installed runtime evidence matches build evidence and binds file names and empty directories', () => {
  const root = fixture();
  const runtime = join(root, 'src-tauri', 'resources', 'runtime');
  mkdirSync(join(runtime, 'dist', 'empty'), { recursive: true });
  writeFileSync(join(runtime, 'dist', 'index.html'), 'synthetic UI fixture');
  writeFileSync(join(runtime, 'empty-file'), '');
  const before = measureInstalledTree(runtime);
  assert.deepEqual(before, measureRuntimeTree(root));
  assert.equal(before.files, 2);
  assert.equal(before.directories, 3);
  renameSync(join(runtime, 'empty-file'), join(runtime, 'renamed-empty-file'));
  assert.notEqual(measureInstalledTree(runtime).sha256, before.sha256);
  const renamed = measureInstalledTree(runtime);
  mkdirSync(join(runtime, 'another-empty'));
  assert.notEqual(measureInstalledTree(runtime).sha256, renamed.sha256);
  writeFileSync(join(runtime, 'dist', 'index.html'), 'changed UI bytes');
  assert.deepEqual(measureInstalledTree(runtime), measureRuntimeTree(root));
  assert.notEqual(measureInstalledTree(runtime).sha256, before.sha256);
});

test('path boundaries reject parent paths, sibling prefixes, junctions and unexpected file types', () => {
  const root = fixture();
  const permitted = join(root, 'permitted');
  const sibling = join(root, 'permitted-other');
  mkdirSync(permitted);
  mkdirSync(sibling);
  writeFileSync(join(permitted, 'file'), 'inside');
  writeFileSync(join(sibling, 'file'), 'other directory');
  assert.equal(regularPath(permitted, join(permitted, 'file'), 'file'), join(permitted, 'file'));
  for (const path of [permitted, root, sibling, join(sibling, 'file')]) {
    assert.throws(() => requireDescendant(permitted, path));
  }
  assert.throws(() => regularPath(root, permitted, 'file'), /Unexpected path type/);
  assert.throws(
    () => regularPath(permitted, join(permitted, 'file'), 'directory'),
    /Unexpected path type/,
  );
  symlinkSync(sibling, join(permitted, 'junction'), 'junction');
  assert.throws(
    () => regularPath(permitted, join(permitted, 'junction', 'file'), 'file'),
    /Links and junctions/,
  );
  assert.throws(() => measureInstalledTree(permitted), /link or junction/);
});

function isolated(t: TestContext) {
  const root = fixture();
  const testRoot = join(
    root,
    'test-results',
    `preview-install-${randomUUID().replaceAll('-', '')}`,
  );
  const data = join(testRoot, 'data');
  mkdirSync(data, { recursive: true });
  for (const name of [
    'KEEP.txt',
    'rivloom.sqlite',
    'node-identity.json',
    'brain-topology.json',
    'rivloom.sqlite-wal',
  ]) {
    writeFileSync(join(data, name), `Synthetic preservation fixture: ${name}`);
  }
  const reportPath = join(testRoot, 'verification.json');
  const report = {
    status: 'awaiting-uninstall',
    commit,
    identifier: previewIdentifier,
    assertions: [],
    preservedData: preservationCheckpoint(data),
  };
  const save = () => writeFileSync(reportPath, JSON.stringify(report));
  save();
  const names = ['RIVLOOM_PREVIEW_INSTALL_GUARDED', 'RIVLOOM_PREVIEW_INSTALL_ROOT'] as const;
  const original = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    }),
  );
  process.env.RIVLOOM_PREVIEW_INSTALL_GUARDED = '1';
  process.env.RIVLOOM_PREVIEW_INSTALL_ROOT = testRoot;
  return { root, testRoot, data, report, reportPath, save };
}

test(
  'uninstall verification requires the exact wrapper root and successful installed evidence',
  { skip: process.platform !== 'win32' },
  (t) => {
    const context = isolated(t);
    const { root, testRoot, report, reportPath, save } = context;
    assert.equal(verifyIsolatedRoot(root, testRoot), testRoot);
    assert.throws(() => verifyIsolatedRoot(root, join(root, 'test-results')), /inside/);
    assert.throws(
      () => verifyIsolatedRoot(root, join(root, 'test-results', 'preview-install-manual')),
      /Unexpected Preview/,
    );
    delete process.env.RIVLOOM_PREVIEW_INSTALL_GUARDED;
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /HKCU protection/);
    process.env.RIVLOOM_PREVIEW_INSTALL_GUARDED = '1';
    process.env.RIVLOOM_PREVIEW_INSTALL_ROOT = root;
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /another test/);
    process.env.RIVLOOM_PREVIEW_INSTALL_ROOT = testRoot;
    report.status = 'failed';
    save();
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /Installed smoke did not pass/);
    report.status = 'awaiting-uninstall';
    save();
    assert.throws(() => verifyUninstalled(root, testRoot, '2'.repeat(40)));
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status, 'awaiting-uninstall');
  },
);

test(
  'uninstall verification detects surviving binaries and changed or removed checked data',
  { skip: process.platform !== 'win32' },
  (t) => {
    const { root, testRoot, data, report, reportPath, save } = isolated(t);
    const runtime = join(testRoot, 'app', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const fakeBinary = join(runtime, 'node.exe');
    writeFileSync(fakeBinary, 'TEXT FIXTURE ONLY, never an executable');
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /left installed executables/);
    unlinkSync(fakeBinary);
    const database = join(data, 'rivloom.sqlite');
    const before = readFileSync(database);
    writeFileSync(database, 'changed database');
    assert.throws(
      () => verifyUninstalled(root, testRoot, commit),
      /changed the separate Preview data/,
    );
    writeFileSync(database, before);
    const wal = join(data, 'rivloom.sqlite-wal');
    const walBefore = readFileSync(wal);
    unlinkSync(wal);
    assert.throws(
      () => verifyUninstalled(root, testRoot, commit),
      /changed the separate Preview data/,
    );
    writeFileSync(wal, walBefore);
    assert.deepEqual(verifyUninstalled(root, testRoot, commit), {
      status: 'awaiting-metadata-restore',
    });
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status, 'awaiting-metadata-restore');
    assert.deepEqual(preservationCheckpoint(data), report.preservedData);
    report.status = 'awaiting-uninstall';
    save();
    unlinkSync(join(data, 'node-identity.json'));
    assert.throws(() => verifyUninstalled(root, testRoot, commit));
  },
);
