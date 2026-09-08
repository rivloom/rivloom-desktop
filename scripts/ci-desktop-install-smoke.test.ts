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
  assertDefaultDiscoveryBindings,
  desktopDiscoveryPort,
  desktopProduct,
  discoveryBindings,
  parseNetstatUDPBindings,
  powershellJson,
  measureInstalledTree,
  preservationCheckpoint,
  desktopIdentifier,
  regularPath,
  requireDescendant,
  requireHostedRunner,
  validateCandidateRecord,
  verifyUiAssets,
  verifyIsolatedRoot,
  verifyUninstalled,
} from './ci-desktop-install-smoke.ts';

const commit = '1'.repeat(40);
const digest = 'a'.repeat(64);
const repository = resolve(import.meta.dirname, '..');
const netstatHeader = 'Active Connections\r\n  Proto Local Address Foreign Address State PID\r\n';

test('netstat parser preserves every IPv4 and IPv6 discovery owner and ignores TCP and other ports', () => {
  const parsed = parseNetstatUDPBindings(
    netstatHeader +
      [
        '  UDP 0.0.0.0:43531 *:* 100',
        '  UDP [::]:43531 *:* 100',
        '  UDP [fe80::1234%12]:43531 *:* 100',
        '  UDP 127.0.0.1:43531 192.0.2.2:65535 100',
        '  UDP 127.0.0.1:4353 *:* 200',
        '  UDP 127.0.0.1:5353 198.51.100.1:43531 43531',
        '  UDP [::ffff:192.0.2.1]:54353 [fe80::1%12]:0 200',
        '  TCP 0.0.0.0:43531 0.0.0.0:0 LISTENING 300',
      ].join('\r\n'),
  );
  assert.deepEqual(
    parsed,
    Array.from({ length: 4 }, () => ({ LocalPort: 43531, OwningProcess: 100 })),
  );
  assertDefaultDiscoveryBindings(parsed, 100);
  const conflict = parseNetstatUDPBindings(
    netstatHeader + 'UDP 0.0.0.0:43531 *:* 100\nUDP [::]:43531 *:* 200',
  );
  assert.throws(() => assertDefaultDiscoveryBindings(conflict, 100), /exclusively owned/);
  assert.deepEqual(parseNetstatUDPBindings(netstatHeader), []);
  assert.deepEqual(
    parseNetstatUDPBindings(
      'localized heading\n 协议 本地地址 外部地址 状态 PID\nUDP [::]:4353 *:* 100',
    ),
    [],
  );
});

test('zero port, scope and unavailable owner records do not hide discovery conflicts', () => {
  assert.deepEqual(
    parseNetstatUDPBindings(netstatHeader + 'UDP 0.0.0.0:0 *:* 0\nUDP [::%0]:5353 *:* 0'),
    [],
  );
  const unknownOwner = parseNetstatUDPBindings(netstatHeader + 'UDP [::%0]:43531 *:* 0');
  assert.deepEqual(unknownOwner, [{ LocalPort: 43531, OwningProcess: 0 }]);
  assert.throws(() => assertDefaultDiscoveryBindings(unknownOwner));
  assert.throws(() => assertDefaultDiscoveryBindings(unknownOwner, 100));
  const scoped = parseNetstatUDPBindings(netstatHeader + 'UDP [::%0]:43531 *:* 100');
  assertDefaultDiscoveryBindings(scoped, 100);
});

test('netstat malformed UDP records fail even when their port is unrelated', () => {
  for (const row of [
    'UDP',
    'UDP 0.0.0.0:43531 *:*',
    'UDP 0.0.0.0:43531 *:* 100 extra',
    'UDP 0.0.0.0:43531 *:* missing',
    'UDP 0.0.0.0:43531 *:* 100x',
    'UDP 0.0.0.0:43531 *:* -1',
    'UDP 0.0.0.0:43531 *:* 4294967296',
    'UDP 0.0.0.0:43531 *:* 0100',
    'UDP 0.0.0.0:43531x *:* 100',
    'UDP 0.0.0.0:543531 *:* 100',
    'UDP 0.0.0.0:-1 *:* 100',
    'UDP 0.0.0.0:043531 *:* 100',
    'UDP 999.0.0.0:43531 *:* 100',
    'UDP *:43531 *:* 100',
    'UDP ::1:43531 *:* 100',
    'UDP [invalid]:43531 *:* 100',
    'UDP [::1%scope]:43531 *:* 100',
    'UDP [::1%00]:43531 *:* 100',
    'UDP [::1%-1]:43531 *:* 100',
    'UDP [::1%4294967296]:43531 *:* 100',
    'UDP 127.0.0.1:43531 remote 100',
    'UDP 0.0.0.0:5353 *:* missing',
  ])
    assert.throws(() => parseNetstatUDPBindings(netstatHeader + row), /discovery-bindings/);
  for (const output of ['', ' \r\n', 'not a table', 'UDP 0.0.0.0:43531 *:* 100'])
    assert.throws(() => parseNetstatUDPBindings(output), /discovery-bindings/);
});

test(
  'native Windows netstat output is parseable without changing any ports or services',
  { skip: process.platform !== 'win32' },
  () => {
    const result = discoveryBindings();
    assert(Array.isArray(result));
    for (const endpoint of result) {
      assert.equal(endpoint.LocalPort, desktopDiscoveryPort);
      assert(
        Number.isSafeInteger(endpoint.OwningProcess) &&
          endpoint.OwningProcess >= 0 &&
          endpoint.OwningProcess <= 0xffff_ffff,
      );
    }
  },
);

test(
  'PowerShell query errors expose only their fixed operation label',
  { skip: process.platform !== 'win32' },
  () => {
    assert.deepEqual(powershellJson('installer-resource', 'Write-Output "{}"'), {});
    for (const script of [
      'throw "SYNTHETIC_PRIVATE_ERROR"',
      'Write-Output "SYNTHETIC_PRIVATE_OUTPUT"',
    ]) {
      assert.throws(
        () => powershellJson('process-inventory', script),
        (error) => {
          assert(error instanceof Error);
          assert.equal(error.message, 'process-inventory: system query failed');
          assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/);
          return true;
        },
      );
    }
  },
);

test(
  'PowerShell runner and metadata guards reject existing installations and unrecognized partial changes',
  { skip: process.platform !== 'win32' },
  () => {
    // Extract only these pure function definitions from the AST. The wrapper's
    // top-level code, registry access, installers and process helpers never run.
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskTokens = $null
$taskErrors = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile($env:RIVLOOM_CI_DESKTOP_TEST_SCRIPT, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count -ne 0) { throw 'PowerShell wrapper has a syntax error.' }
foreach ($taskName in @('Read-Value', 'Same-Metadata', 'Assert-SafePreviousBinary', 'Safe-PartialMetadata', 'Assert-GitHubHostedRunner', 'Assert-AbsentInstallationMetadata', 'Assert-FreshInstallation', 'Assert-PreviewUnchanged', 'Assert-DefaultDiscoveryAvailable', 'Assert-NoRivloom')) {
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
Assert-GitHubHostedRunner 'true' 'github-hosted'
foreach ($taskEnvironment in @('self-hosted', 'local', '')) { Expect-Failure { Assert-GitHubHostedRunner 'true' $taskEnvironment } }
Expect-Failure { Assert-GitHubHostedRunner 'false' 'github-hosted' }
Assert-AbsentInstallationMetadata @($taskMissing, $taskMissing)
Expect-Failure { Assert-AbsentInstallationMetadata @($taskMissing, (Metadata @())) }
Assert-SafePreviousBinary $taskMissing
Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'String' 'Rivloom.exe')))
foreach ($taskUnsafeName in @('..\outside.exe', 'C:\outside.exe', 'another.exe', '')) {
  Expect-Failure { Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'String' $taskUnsafeName))) }
}
Expect-Failure { Assert-SafePreviousBinary (Metadata @((Value 'MainBinaryName' 'DWord' 1))) }
$taskInstall = 'C:\synthetic-desktop\app'
$taskPlan = @{ version = '0.1.3' }
$taskRivloomProductKey = 'Software\rivloom\Rivloom'
$taskRivloomUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom'
$taskUninstallAttempted = $false
$taskPartial = Metadata @((Value 'InstallLocation' 'String' ('"' + $taskInstall + '"')), (Value 'DisplayVersion' 'String' '0.1.3'), (Value 'NoModify' 'DWord' 1))
if (-not (Safe-PartialMetadata $taskRivloomUninstallKey $taskPartial $taskMissing)) { throw 'Known partial state rejected.' }
foreach ($taskUnexpected in @((Value 'DisplayVersion' 'String' '0.1.4'), (Value 'NoModify' 'String' '1'), (Value 'EstimatedSize' 'DWord' 123), (Value 'UninstallString' 'String' 'C:\outside.exe'), (Value 'ConcurrentValue' 'String' 'new'))) {
  $taskAltered = Metadata @((Value 'InstallLocation' 'String' ('"' + $taskInstall + '"')), $taskUnexpected)
  if (Safe-PartialMetadata $taskRivloomUninstallKey $taskAltered $taskMissing) { throw 'Unrecognized partial metadata accepted.' }
}
$taskOriginal = Metadata @((Value 'UnrelatedOriginal' 'String' 'preserve me'))
if (Safe-PartialMetadata $taskRivloomUninstallKey $taskPartial $taskOriginal) { throw 'Deleted original metadata accepted.' }
$taskWithOriginal = Metadata @($taskPartial.Values + $taskOriginal.Values)
if (-not (Safe-PartialMetadata $taskRivloomUninstallKey $taskWithOriginal $taskOriginal)) { throw 'Unchanged original metadata rejected.' }
if (Safe-PartialMetadata $taskRivloomUninstallKey $taskMissing $taskOriginal) { throw 'Unexplained deleted key accepted.' }
$taskUninstallAttempted = $true
if (-not (Safe-PartialMetadata $taskRivloomUninstallKey $taskMissing $taskOriginal)) { throw 'Known uninstall deletion rejected.' }
if (Safe-PartialMetadata $taskRivloomProductKey $taskMissing $taskOriginal) { throw 'Uninstaller cannot delete the product key in update mode.' }

# Controlled stubs exercise the wrapper's checks without registry/process/network access.
$taskHives = @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)
$taskViews = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
$taskRegistryFixture = @{}
function Read-Metadata([string]$Key, [Microsoft.Win32.RegistryView]$View, [Microsoft.Win32.RegistryHive]$Hive) {
  $taskLookup = "$Hive|$View|$Key"
  if ($taskRegistryFixture.ContainsKey($taskLookup)) { return $taskRegistryFixture[$taskLookup] }
  return $taskMissing
}
Assert-FreshInstallation
foreach ($taskHive in $taskHives) {
  foreach ($taskView in $taskViews) {
    foreach ($taskKey in @($taskRivloomProductKey, $taskRivloomUninstallKey)) {
      $taskLookup = "$taskHive|$taskView|$taskKey"
      $taskRegistryFixture[$taskLookup] = Metadata @()
      Expect-Failure { Assert-FreshInstallation }
      $taskRegistryFixture.Remove($taskLookup)
    }
  }
}
$taskPreviewKeys = @('Software\rivloom\Rivloom UI Preview', 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Rivloom UI Preview')
$taskPreviewBefore = @{}
foreach ($taskHive in $taskHives) {
  foreach ($taskView in $taskViews) {
    foreach ($taskKey in $taskPreviewKeys) { $taskPreviewBefore["$taskHive|$taskView|$taskKey"] = $taskMissing }
  }
}
Assert-PreviewUnchanged
foreach ($taskLookup in @($taskPreviewBefore.Keys)) {
  $taskRegistryFixture[$taskLookup] = Metadata @()
  Expect-Failure { Assert-PreviewUnchanged }
  $taskRegistryFixture.Remove($taskLookup)
}
$taskEndpointFixture = @()
function Get-NetUDPEndpoint([string]$ErrorAction) { return $taskEndpointFixture }
Assert-DefaultDiscoveryAvailable
$taskEndpointFixture = @(@{ LocalPort = 43531; OwningProcess = 100 })
Expect-Failure { Assert-DefaultDiscoveryAvailable }
$taskProcessFixture = @()
function Get-Process([string]$Name, [string]$ErrorAction) { return $taskProcessFixture }
Assert-NoRivloom
$taskProcessFixture = @(@{ ProcessName = 'Rivloom' })
Expect-Failure { Assert-NoRivloom }
Write-Output 'Pure metadata guard tests passed.'
`;
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: {
          ...process.env,
          RIVLOOM_CI_DESKTOP_TEST_SCRIPT: join(
            repository,
            'scripts',
            'ci-desktop-install-smoke.ps1',
          ),
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.match(output, /Pure metadata guard tests passed/);
  },
);

test('hosted runner and default discovery checks reject local runs, port conflicts and foreign ownership', () => {
  assert.equal(desktopProduct, 'Rivloom');
  assert.equal(desktopIdentifier, 'com.rivloom.desktop');
  requireHostedRunner({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
  for (const environment of [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
    assert.throws(() => requireHostedRunner(environment), /GitHub-hosted/);
  const endpoint = { LocalPort: desktopDiscoveryPort, OwningProcess: 100 };
  assertDefaultDiscoveryBindings([]);
  assert.throws(() => assertDefaultDiscoveryBindings([endpoint]), /already in use/);
  assertDefaultDiscoveryBindings([endpoint], 100);
  assert.throws(() => assertDefaultDiscoveryBindings([], 100), /exclusively owned/);
  assert.throws(() => assertDefaultDiscoveryBindings([endpoint], 200), /exclusively owned/);
  assert.throws(() =>
    assertDefaultDiscoveryBindings([endpoint, { ...endpoint, OwningProcess: 200 }], 100),
  );
  assert.throws(() => assertDefaultDiscoveryBindings([{ ...endpoint, LocalPort: 12345 }], 100));
  assert.throws(() => assertDefaultDiscoveryBindings([endpoint], 0));
});

// Synthetic files only. These tests do not inspect/write registry keys, execute
// installers, launch Rivloom/OpenCode or connect to a model service.
function fixture() {
  const parent = join(repository, 'test-results');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'desktop-smoke-selftest-'));
}

function candidate() {
  return {
    schemaVersion: 1,
    status: 'candidate',
    profile: 'desktop',
    product: { kind: 'desktop', identifier: desktopIdentifier, version: '0.1.3' },
    target: 'x86_64-pc-windows-msvc',
    source: {
      commit,
      expectedCommit: commit,
      workingTree: 'clean',
      refType: 'tag',
      refName: 'ci-v0.1.3',
      node: '24.19.0',
      rust: '1.98.1',
      cargo: '1.98.1',
    },
    artifact: { fileName: 'Rivloom_0.1.3_x64-setup.exe', bytes: 512, sha256: digest },
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
  assert.equal(validateCandidateRecord(candidate(), commit).product.identifier, desktopIdentifier);
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
      record.product.identifier = 'com.rivloom.conversationpreview';
    },
    (record: ReturnType<typeof candidate>) => {
      record.product.version = '0.1.4';
    },
    (record: ReturnType<typeof candidate>) => {
      record.product.version = '0.1.3-beta.1';
      record.source.refName = 'ci-v0.1.3-beta.1';
      record.artifact.fileName = 'Rivloom_0.1.3-beta.1_x64-setup.exe';
    },
    (record: ReturnType<typeof candidate>) => {
      record.profile = 'conversation-preview';
    },
    (record: ReturnType<typeof candidate>) => {
      record.source.refName = 'ci-preview-v0.1.3';
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

test('UI assets verify the referenced wordmark and favicon and reject missing or altered bytes', () => {
  const root = fixture();
  const assets = join(root, 'dist', 'assets');
  const sources = join(root, 'src', 'assets', 'brand');
  mkdirSync(assets, { recursive: true });
  mkdirSync(sources, { recursive: true });
  const wordmark = 'rivloom-wordmark-fixture.png';
  const favicon = 'rivloom-favicon-fixture.png';
  for (const name of ['rivloom-wordmark', 'rivloom-favicon']) {
    writeFileSync(join(sources, `${name}.png`), `original ${name}`);
    writeFileSync(join(assets, `${name}-fixture.png`), `original ${name}`);
  }
  const script = `const wordmark = "/assets/${wordmark}";`;
  writeFileSync(join(assets, 'index-fixture.js'), script);
  writeFileSync(join(assets, 'index-fixture.css'), ':root{--accent:#245eea;}');
  writeFileSync(join(root, 'src', 'styles.css'), ':root { --accent: #245eea; }');
  writeFileSync(
    join(root, 'dist', 'index.html'),
    `<link rel="icon" href="/assets/${favicon}"><script src="/assets/index-fixture.js"></script><link href="/assets/index-fixture.css">`,
  );
  assert.equal(verifyUiAssets(root, root).brands, 2);
  for (const name of [wordmark, favicon]) {
    const path = join(assets, name);
    const original = readFileSync(path);
    unlinkSync(path);
    assert.throws(() => verifyUiAssets(root, root), /Expected one installed/);
    writeFileSync(path, 'corrupt image');
    assert.throws(() => verifyUiAssets(root, root), /differs from the original brand asset/);
    writeFileSync(path, original);
  }
  const duplicate = join(assets, 'rivloom-wordmark-duplicate.png');
  writeFileSync(duplicate, readFileSync(join(assets, wordmark)));
  assert.throws(() => verifyUiAssets(root, root), /Expected one installed/);
  unlinkSync(duplicate);
  writeFileSync(join(assets, 'index-fixture.js'), 'const removedWordmark = true;');
  assert.throws(() => verifyUiAssets(root, root), /does not reference its brand image/);
  writeFileSync(join(assets, 'index-fixture.js'), script);
  writeFileSync(join(assets, 'index-fixture.css'), ':root{--accent:#ffffff;}');
  assert.throws(() => verifyUiAssets(root, root), /does not contain the source brand accent/);
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
    `desktop-install-${randomUUID().replaceAll('-', '')}`,
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
    identifier: desktopIdentifier,
    assertions: [],
    preservedData: preservationCheckpoint(data),
  };
  const save = () => writeFileSync(reportPath, JSON.stringify(report));
  save();
  const names = [
    'RIVLOOM_CI_DESKTOP_INSTALL_GUARDED',
    'RIVLOOM_CI_DESKTOP_INSTALL_ROOT',
    'GITHUB_ACTIONS',
    'RUNNER_ENVIRONMENT',
  ] as const;
  const original = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    }),
  );
  process.env.RIVLOOM_CI_DESKTOP_INSTALL_GUARDED = '1';
  process.env.RIVLOOM_CI_DESKTOP_INSTALL_ROOT = testRoot;
  process.env.GITHUB_ACTIONS = 'true';
  process.env.RUNNER_ENVIRONMENT = 'github-hosted';
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
      () => verifyIsolatedRoot(root, join(root, 'test-results', 'desktop-install-manual')),
      /Unexpected Rivloom/,
    );
    delete process.env.RIVLOOM_CI_DESKTOP_INSTALL_GUARDED;
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /HKCU protection/);
    process.env.RIVLOOM_CI_DESKTOP_INSTALL_GUARDED = '1';
    process.env.RIVLOOM_CI_DESKTOP_INSTALL_ROOT = root;
    assert.throws(() => verifyUninstalled(root, testRoot, commit), /another test/);
    process.env.RIVLOOM_CI_DESKTOP_INSTALL_ROOT = testRoot;
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
      /changed the separate Rivloom data/,
    );
    writeFileSync(database, before);
    const wal = join(data, 'rivloom.sqlite-wal');
    const walBefore = readFileSync(wal);
    unlinkSync(wal);
    assert.throws(
      () => verifyUninstalled(root, testRoot, commit),
      /changed the separate Rivloom data/,
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
