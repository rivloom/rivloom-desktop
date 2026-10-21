import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareMacosProcessHelper(root: string, destination: string) {
  assert.equal(process.platform, 'darwin', 'The macOS process helper requires native macOS');
  assert.equal(process.arch, 'arm64', 'The preview process helper requires Apple Silicon');
  const source = join(root, 'native/macos-process.c');
  const output = join(destination, 'native/rivloom-process');
  await mkdir(dirname(output), { recursive: true });
  const options = { encoding: 'utf8' as const, timeout: 120_000, maxBuffer: 1024 * 1024 };
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const inputs = { sourceSHA256: sha(await readFile(source)), buildScriptSHA256: sha(await readFile(fileURLToPath(import.meta.url))),
    compiler: execFileSync('/usr/bin/xcrun', ['clang', '--version'], options).trim(),
    sdk: execFileSync('/usr/bin/xcrun', ['--show-sdk-version'], options).trim() };
  try {
    const stat = await lstat(output);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Process helper output must be a regular file');
    const previous = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    if (previous.schemaVersion === 1 && previous.platform === 'darwin' && previous.arch === 'arm64' &&
        JSON.stringify(previous.inputs) === JSON.stringify(inputs) && previous.binarySHA256 === sha(await readFile(output))) {
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], options);
      return { path: output, ...previous };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  execFileSync('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=14.0', source, '-o', output], options);
  await chmod(output, 0o755);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], options);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], options);
  const record = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', inputs, binarySHA256: sha(await readFile(output)) };
  await writeFile(`${output}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return { path: output, ...record };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  assert(process.argv.length <= 3, 'Usage: node scripts/macos-process-build.ts [RUNTIME_DIRECTORY]');
  await prepareMacosProcessHelper(root, process.argv[2] ? resolve(process.argv[2]) : join(root, 'src-tauri/resources/runtime'));
  console.log('macOS process helper prepared and ad-hoc signature verified.');
}
