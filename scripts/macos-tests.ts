import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBatch } from './ci-tests.ts';
import { macosNativeFiles } from './ci-test-suites.ts';

assert(process.platform === 'darwin' && process.arch === 'arm64', 'Mac tests require native Apple Silicon');
const root = resolve(import.meta.dirname, '..');
const result = await runBatch([
  'tests/macos-runtime.test.ts', 'tests/macos-process.test.ts', 'tests/macos-identity.test.ts', ...macosNativeFiles,
].map(path => resolve(root, path)), root);
await mkdir(resolve(root, 'test-results/macos'), { recursive: true });
await writeFile(resolve(root, 'test-results/macos/unit-tests.json'), JSON.stringify(result, null, 2) + '\n');
assert(result.passed, 'Every selected Mac test must execute and pass; no skipped tests accepted');
