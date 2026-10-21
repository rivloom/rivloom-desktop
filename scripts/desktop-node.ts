import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertMacosArm64Executable, desktopNodeVersion, desktopPlatforms, type DesktopPlatform } from './desktop-platform.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function ordinaryFile(file: string) {
  const stat = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat) assert(stat.isFile() && !stat.isSymbolicLink(), 'Runtime cache entries must be ordinary files');
  return stat;
}
async function download(url: string, file: string, expectedHash?: string) {
  if (await ordinaryFile(file)) {
    const bytes = await readFile(file);
    if (expectedHash) assert.equal(sha(bytes), expectedHash, 'Cached Node resource SHA256 mismatch');
    return bytes;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200, `Official Node resource download failed: ${response.status}`);
  assert(Number(response.headers.get('content-length') ?? 0) <= 160 * 1024 ** 2, 'Node download is oversized');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0 && bytes.length <= 160 * 1024 ** 2, 'Node download is empty or oversized');
  if (expectedHash) assert.equal(sha(bytes), expectedHash, 'Official Node download SHA256 mismatch');
  await writeFile(file, bytes, { flag: 'wx' });
  return bytes;
}

export async function prepareDesktopNode(root: string, target: DesktopPlatform) {
  const pin = desktopPlatforms[target];
  assert.equal(process.platform, pin.platform, 'Prepare desktop Node on its native platform');
  assert.equal(process.arch, pin.arch, 'Prepare desktop Node on its native architecture');
  const cacheRoot = join(root, '.data', 'desktop-downloads');
  const cache = join(cacheRoot, target, desktopNodeVersion);
  for (const dir of [join(root, '.data'), cacheRoot, join(cacheRoot, target), cache]) {
    try { await mkdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(dir);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Node cache directories cannot be links');
  }
  const source = `https://nodejs.org/dist/v${desktopNodeVersion}/SHASUMS256.txt`;
  if (target === 'windows-x64') {
    // Reuse the verified legacy cache to avoid duplicating an unchanged executable.
    const legacy = join(cacheRoot, 'node.exe');
    const legacyStat = await ordinaryFile(legacy);
    const executable = legacyStat && sha(await readFile(legacy)) === pin.sha256 ? legacy : join(cache, pin.executable);
    if (!(await ordinaryFile(executable)) && sha(await readFile(process.execPath)) === pin.sha256) {
      await writeFile(executable, await readFile(process.execPath), { flag: 'wx' });
    }
    await download(pin.url, executable, pin.sha256);
    const license = join(cache, 'Node-LICENSE.txt');
    await download(`https://raw.githubusercontent.com/nodejs/node/v${desktopNodeVersion}/LICENSE`, license);
    return { executable, license, version: desktopNodeVersion, sha256: pin.sha256, source };
  }

  const archive = join(cache, `node-v${desktopNodeVersion}-darwin-arm64.tar.gz`);
  await download(pin.url, archive, pin.sha256);
  const executable = join(cache, pin.executable), license = join(cache, 'Node-LICENSE.txt');
  await ordinaryFile(executable); await ordinaryFile(license);
  // Read only the two expected ordinary members, without extracting archive paths.
  // Recheck existing cache bytes against the pinned archive every time.
  const extracted = JSON.parse(execFileSync('/usr/bin/python3', ['-c', `
import hashlib, json, os, sys, tarfile
archive, prefix, binary, license = sys.argv[1:]
result = {}
with tarfile.open(archive, 'r:gz') as source:
    members = source.getmembers()
    for name, destination, field in [(prefix + '/bin/node', binary, 'binary'), (prefix + '/LICENSE', license, 'license')]:
        matches = [m for m in members if m.name == name]
        assert len(matches) == 1 and matches[0].isreg(), 'Unexpected Node archive member'
        assert 0 < matches[0].size <= 160 * 1024 * 1024, 'Oversized Node archive member'
        content = source.extractfile(matches[0]).read()
        digest = hashlib.sha256(content).hexdigest()
        if os.path.lexists(destination):
            assert not os.path.islink(destination) and os.path.isfile(destination), 'Linked Node cache'
            with open(destination, 'rb') as cached: assert hashlib.sha256(cached.read()).hexdigest() == digest, 'Changed Node cache'
        else:
            with open(destination, 'xb') as output: output.write(content)
        result[field] = digest
print(json.dumps(result))
`, archive, `node-v${desktopNodeVersion}-darwin-arm64`, executable, license], { encoding: 'utf8', timeout: 60_000 }));
  const binary = await readFile(executable);
  assert.equal(sha(binary), extracted.binary, 'Extracted Node hash mismatch');
  assert.equal(sha(await readFile(license)), extracted.license, 'Extracted Node license hash mismatch');
  assertMacosArm64Executable(binary);
  await chmod(executable, 0o755);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', executable], { stdio: 'pipe', timeout: 30_000 });
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(), `v${desktopNodeVersion}`);
  return { executable, license, version: desktopNodeVersion, sha256: extracted.binary as string, source, archiveSHA256: pin.sha256, archiveURL: pin.url };
}
