import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const rootDirectory = resolve(import.meta.dirname, '..');

export function verifyMacosKeychainExecutable(path: string) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0, 'Keychain helper must be an immutable-to-other-users regular file');
  const bytes = readFileSync(path);
  assert(bytes.length > 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c, 'Keychain helper must be a native ARM64 Mach-O executable');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return digest(bytes);
}

export async function prepareMacosKeychainHelper(root: string, destination: string, options: { testing?: boolean } = {}) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Build the Keychain helper on native macOS ARM64');
  const absoluteRoot = resolve(root), outputRoot = resolve(destination);
  const inside = relative(absoluteRoot, outputRoot);
  assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'Keychain helper output must stay within this checkout');
  let cursor = absoluteRoot;
  for (const segment of inside.split('/')) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const stat = lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Keychain build output must not contain links');
  }
  const directory = join(outputRoot, 'native');
  if (!existsSync(directory)) mkdirSync(directory);
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Keychain output must be a real directory');
  const source = join(absoluteRoot, 'native/macos-keychain.swift');
  assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'Keychain helper source must be a regular file');
  const sourceSHA256 = digest(readFileSync(source));
  const compiler = execFileSync('/usr/bin/xcrun', ['swiftc', '--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  const testing = options.testing === true;
  const name = testing ? 'rivloom-keychain-testing' : 'rivloom-keychain';
  const path = join(directory, name);
  const recordPath = `${path}.build.json`;
  const inputs = { schemaVersion: 1, sourceSHA256, compiler, target: 'arm64-apple-macosx14.0', testing };
  if (existsSync(path) && existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const sha256 = verifyMacosKeychainExecutable(path);
    if (JSON.stringify(record.inputs) === JSON.stringify(inputs) && record.sha256 === sha256)
      return { path, sha256, sourceSHA256, testing };
  }
  // Keep the signed helper stable across desktop-prepare's disposable runtime directory.
  // An ad-hoc signature changing unnecessarily would invalidate Keychain access decisions.
  const cacheSegments = ['.data', 'macos-keychain-build', digest(JSON.stringify(inputs))];
  let cache = absoluteRoot;
  for (const segment of cacheSegments) {
    cache = join(cache, segment);
    if (!existsSync(cache)) mkdirSync(cache);
    const stat = lstatSync(cache);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Keychain build cache must be a real directory');
  }
  const cachedPath = join(cache, name);
  const cachedRecord = `${cachedPath}.build.json`;
  if (existsSync(cachedPath) && existsSync(cachedRecord)) {
    const record = JSON.parse(readFileSync(cachedRecord, 'utf8'));
    assert.deepEqual(record.inputs, inputs, 'Keychain cache inputs differ');
    assert.equal(verifyMacosKeychainExecutable(cachedPath), record.sha256, 'Keychain cache bytes differ');
  } else {
  const temporary = join(cache, `${name}.stage-${randomUUID()}`);
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', inputs.target, '-framework', 'Security',
      ...(testing ? ['-D', 'RIVLOOM_KEYCHAIN_TESTING'] : []), source, '-o', temporary],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1024 * 1024 });
    chmodSync(temporary, 0o755);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier',
      testing ? 'com.rivloom.macospreview.keychain.test' : 'com.rivloom.macospreview.keychain', temporary],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const sha256 = verifyMacosKeychainExecutable(temporary);
    renameSync(temporary, cachedPath);
    writeFileSync(cachedRecord, JSON.stringify({ inputs, sha256 }, null, 2) + '\n', { mode: 0o644 });
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  }
  const sha256 = verifyMacosKeychainExecutable(cachedPath);
  const copied = join(directory, `${name}.copy-${randomUUID()}`);
  try {
    copyFileSync(cachedPath, copied);
    chmodSync(copied, 0o755);
    assert.equal(verifyMacosKeychainExecutable(copied), sha256, 'Copied Keychain helper differs');
    if (existsSync(path)) assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Keychain helper destination must be regular');
    renameSync(copied, path);
    writeFileSync(recordPath, JSON.stringify({ inputs, sha256 }, null, 2) + '\n', { mode: 0o644 });
  } finally { if (existsSync(copied)) unlinkSync(copied); }
  return { path, sha256, sourceSHA256, testing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/macos-keychain-build.ts');
  const result = await prepareMacosKeychainHelper(rootDirectory, join(rootDirectory, 'src-tauri/resources/runtime'));
  console.log(JSON.stringify({ helper: relative(rootDirectory, result.path), sha256: result.sha256, sourceSHA256: result.sourceSHA256 }));
}
