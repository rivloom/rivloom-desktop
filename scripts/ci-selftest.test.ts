import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { auditCoverage, auditNetworkCases, exactPattern, networkCases } from './ci-test-suites.ts';
import { checkVersions } from './ci-version-check.ts';
import { ciRoot, testEnvironment } from './ci-workspace.ts';
import { runServiceScript } from './ci-services.ts';

const base = join(ciRoot, 'test-results');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'ci-selftest-'));

test('version gate rejects Cargo drift and preview identity reuse', () => {
  const directory = join(root, 'versions');
  mkdirSync(join(directory, 'src-tauri'), { recursive: true });
  for (const file of [
    'package.json',
    'package-lock.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/tauri.preview.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  ])
    cpSync(join(ciRoot, file), join(directory, file));
  const baseline = checkVersions(directory);
  const cargo = readFileSync(join(directory, 'src-tauri/Cargo.toml'), 'utf8');
  writeFileSync(
    join(directory, 'src-tauri/Cargo.toml'),
    cargo.replace(`version = "${baseline.versions.package}"`, 'version = "9.8.7"'),
  );
  assert.throws(() => checkVersions(directory), /version mismatch: cargo/);
  writeFileSync(join(directory, 'src-tauri/Cargo.toml'), cargo);
  writeFileSync(
    join(directory, 'src-tauri/tauri.preview.conf.json'),
    JSON.stringify({ identifier: baseline.identifiers.desktop }),
  );
  assert.throws(() => checkVersions(directory), /preview product identifier/);
});

test('network mapping rejects omitted, duplicate and unrecognized declarations', () => {
  const source = readFileSync(join(ciRoot, 'tests/node-network.test.ts'), 'utf8');
  assert.equal(auditNetworkCases(source, networkCases), 33);
  assert.throws(
    () => auditNetworkCases(source, { ...networkCases, mdns: [] }),
    /incomplete or stale/,
  );
  assert.throws(
    () => auditNetworkCases(source, { ...networkCases, extra: networkCases.mdns }),
    /multiple lanes/,
  );
  assert.throws(
    () => auditNetworkCases(source + '\ntest(`dynamic ${name}`, () => {});', networkCases),
    /explicit audit/,
  );
  const specialName = 'one (test) [only] + ?';
  assert.throws(
    () =>
      auditNetworkCases(source + "\n  test('unassigned indented case', () => {});", networkCases),
    /incomplete or stale/,
  );
  assert(exactPattern([specialName]).test(specialName));
  assert(!exactPattern([specialName]).test(`${specialName} extra`));
});

test('full-suite coverage rejects an omitted or newly added test file', () => {
  const directory = join(root, 'coverage');
  mkdirSync(join(directory, 'tests'), { recursive: true });
  cpSync(join(ciRoot, 'tests'), join(directory, 'tests'), { recursive: true });
  cpSync(join(ciRoot, 'package.json'), join(directory, 'package.json'));
  auditCoverage(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  manifest.scripts.test = manifest.scripts.test.replace(' tests/node-network.test.ts', '');
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => auditCoverage(directory), /full entry must cover/);
  cpSync(join(ciRoot, 'package.json'), join(directory, 'package.json'));
  writeFileSync(join(directory, 'tests/unassigned.test.ts'), '');
  assert.throws(() => auditCoverage(directory), /must cover every/);
});

test('CI runner preserves failure, skip, missing-selection and exact-name outcomes', () => {
  const file = join(root, 'runner.test.mjs');
  writeFileSync(
    file,
    `import { test } from 'node:test';
test('selected [one]', () => {});
test('selected [one] extra', () => { throw new Error('must not be selected'); });
test('failure', () => { throw new Error('intentional CI gate failure'); });
test('skip', { skip: true }, () => {});
`,
  );
  const runner = join(root, 'runner.mjs');
  writeFileSync(
    runner,
    `import { runBatch } from ${JSON.stringify(pathToFileURL(join(ciRoot, 'scripts/ci-tests.ts')).href)};
const result = await runBatch([process.argv[2]], process.cwd(), [process.argv[3]]);
process.exitCode = result.passed ? 0 : 1;
`,
  );
  // A fresh ordinary Node process is required: node:test intentionally prevents recursive run().
  for (const [name, status] of [
    ['selected [one]', 0],
    ['failure', 1],
    ['skip', 1],
    ['missing', 1],
  ] as const) {
    const result = spawnSync(process.execPath, [runner, file, name], {
      cwd: root,
      env: testEnvironment(root),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, status, `${name}: ${result.stdout}\n${result.stderr}`);
  }
});

test('service wrapper propagates nonzero exit without inheriting task or model environment', async () => {
  const file = join(root, 'failure.mjs');
  writeFileSync(file, 'process.exitCode = 7;');
  const result = await runServiceScript(file, root);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'ci-environment-filter-sentinel';
  const environment = testEnvironment(root);
  if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previous;
  assert.equal(environment.RIVLOOM_DATA_DIR, join(root, '.data', 'default'));
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.RIVLOOM_MODEL, undefined);
});

test('service wrapper times out only its owned test process and reports failure', async () => {
  const file = join(root, 'timeout.mjs');
  writeFileSync(file, 'setInterval(() => {}, 1000);');
  const result = await runServiceScript(file, root, 300);
  assert.equal(result.status, 'failed');
  assert.equal(result.timedOut, true);
  assert(result.durationMs < 10_000, 'Owned timeout process must be reaped promptly');
});
