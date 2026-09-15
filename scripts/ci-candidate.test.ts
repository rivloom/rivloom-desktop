import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  candidateConfig,
  candidateIdentifier,
  candidateProfile,
  candidateTarget,
  captureVerifiedRuntime,
  configureCandidate,
  measureRuntimeTree,
  recordCandidate,
  validateCandidateContext,
  type CandidateContext,
} from './ci-candidate.ts';
import { ciRoot } from './ci-workspace.ts';

const context: CandidateContext = {
  commit: '1'.repeat(40),
  expectedCommit: '1'.repeat(40),
  workingTree: 'clean',
  refType: 'tag',
  refName: 'ci-v0.1.3',
  node: '24.19.0',
  rust: '1.98.1',
  cargo: '1.98.1',
};

test('Rivloom candidate context rejects tag, source, dirty-tree and toolchain drift', () => {
  validateCandidateContext('0.1.3', context);
  validateCandidateContext('0.1.3', { ...context, refType: 'branch', refName: 'main' });
  assert.throws(
    () => validateCandidateContext('0.1.3', { ...context, refType: 'branch', refName: 'feature' }),
    /candidate branch must be main/,
  );
  for (const change of [
    { expectedCommit: '2'.repeat(40) },
    { workingTree: 'dirty' as const },
    { refName: 'v0.1.3' },
    { refName: 'ci-v0.1.4' },
    { refName: 'ci-preview-v0.1.3' },
    { node: '24.18.0' },
    { rust: '1.97.0' },
    { cargo: '1.97.0' },
  ])
    assert.throws(() => validateCandidateContext('0.1.3', { ...context, ...change }));
  const config = candidateConfig('0.1.3', context);
  assert.equal(candidateProfile, 'desktop');
  assert.equal(config.productName, 'Rivloom');
  assert.equal(config.identifier, 'com.rivloom.desktop');
  assert.equal(config.identifier, candidateIdentifier);
  assert.equal(config.build.beforeBuildCommand, null);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.throws(
    () => validateCandidateContext('0.1.3-beta.1', { ...context, refName: 'ci-v0.1.3-beta.1' }),
    /requires a release version/,
  );
});

test('candidate record binds verified unchanged Rivloom runtime and cannot imply publication', async () => {
  mkdirSync(join(ciRoot, 'test-results'), { recursive: true });
  const root = mkdtempSync(join(ciRoot, 'test-results', 'ci-candidate-selftest-'));
  mkdirSync(join(root, 'src-tauri', 'resources', 'runtime'), { recursive: true });
  for (const file of [
    'package.json',
    'package-lock.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'src-tauri/tauri.preview.conf.json',
  ])
    cpSync(join(ciRoot, file), join(root, file));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const source = { ...context, refName: `ci-v${version}` };
  configureCandidate(root, source);
  const directory = join(root, 'test-results', 'candidate');
  const manifestPath = join(root, 'src-tauri', 'resources', 'runtime', 'runtime-manifest.json');
  const payload = join(root, 'src-tauri', 'resources', 'runtime', 'server.js');
  writeFileSync(payload, 'original payload');
  const manifest = {
    schemaVersion: 1,
    product: { kind: candidateProfile, identifier: candidateIdentifier, version },
    target: { platform: 'win32', arch: 'x64' },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(directory, 'runtime-before.json'), JSON.stringify({ status: 'failed' }));
  assert.throws(() => captureVerifiedRuntime(root), /gate did not pass/);
  writeFileSync(join(directory, 'runtime-before.json'), JSON.stringify({ status: 'passed' }));
  captureVerifiedRuntime(root);
  writeFileSync(join(directory, 'runtime-after.json'), JSON.stringify({ status: 'passed' }));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, unexpected: true }));
  await assert.rejects(() => recordCandidate(root, source), /Runtime changed/);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(payload, 'modified payload');
  await assert.rejects(() => recordCandidate(root, source), /Runtime tree changed/);
  writeFileSync(payload, 'original payload');
  const bundle = join(root, 'src-tauri', 'target', candidateTarget, 'release', 'bundle', 'nsis');
  mkdirSync(bundle, { recursive: true });
  // Synthetic PE header only: this verifies packaging metadata, never a usable installer.
  const executable = Buffer.alloc(512);
  executable.write('MZ');
  executable.writeUInt32LE(128, 0x3c);
  executable.write('PE\0\0', 128);
  writeFileSync(join(bundle, `Rivloom_${version}_x64-setup.exe`), executable);
  const record = await recordCandidate(root, source);
  assert.equal(record.status, 'candidate');
  assert.equal(record.product.identifier, candidateIdentifier);
  assert.deepEqual(record.publication, { published: false, channel: null, url: null });
  assert.equal(record.signing.verified, false);
  assert.equal(record.runtimeTree.files, 2);
  await assert.rejects(() => recordCandidate(root, source), /already exists|EEXIST/);
});

test('runtime tree evidence binds empty files and directories and rejects junctions', () => {
  mkdirSync(join(ciRoot, 'test-results'), { recursive: true });
  const root = mkdtempSync(join(ciRoot, 'test-results', 'ci-candidate-tree-selftest-'));
  const runtime = join(root, 'src-tauri', 'resources', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'empty'), '');
  const before = measureRuntimeTree(root);
  assert.equal(before.files, 1);
  assert.equal(before.size, 0);
  mkdirSync(join(runtime, 'new-directory'));
  assert.notEqual(measureRuntimeTree(root).sha256, before.sha256);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'payload'), 'external');
  symlinkSync(outside, join(runtime, 'link'), 'junction');
  assert.throws(() => measureRuntimeTree(root), /symbolic links or junctions/);
});
