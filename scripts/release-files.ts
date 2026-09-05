import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  immutableReleaseDirectory,
  parseReleaseRecord,
  type ReleaseRecord,
} from './release-record.ts';

const maximumRecordBytes = 2 * 1024 * 1024;
export async function readReleaseJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maximumRecordBytes)
    throw new Error('Release metadata must be a regular JSON file no larger than 2 MiB');
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumRecordBytes) throw new Error('Release metadata exceeds 2 MiB');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

/** Measure an explicit final PE installer; no discovery of existing Preview builds. */
export async function measureInstaller(path: string) {
  const absolute = resolve(path);
  const beforePath = await lstat(absolute, { bigint: true });
  if (
    !beforePath.isFile() ||
    beforePath.size < 64n ||
    beforePath.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Installer must be a nonempty regular PE file');
  const handle = await open(absolute, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (before.ino !== beforePath.ino || before.dev !== beforePath.dev)
      throw new Error('Installer changed before hashing');
    const header = Buffer.alloc(64);
    await handle.read(header, 0, header.length, 0);
    const peOffset = header.readUInt32LE(60);
    if (header.toString('ascii', 0, 2) !== 'MZ' || BigInt(peOffset) + 4n > before.size)
      throw new Error('Installer is not a Windows PE executable');
    const pe = Buffer.alloc(4);
    await handle.read(pe, 0, 4, peOffset);
    if (!pe.equals(Buffer.from([0x50, 0x45, 0, 0])))
      throw new Error('Installer is not a Windows PE executable');
    // An NSIS bootstrap executable may be x86 even when its contained application is x64.
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    if (
      [after, afterPath].some(
        (info) =>
          !info.isFile() ||
          info.dev !== before.dev ||
          info.ino !== before.ino ||
          info.size !== before.size ||
          info.mtimeNs !== before.mtimeNs ||
          info.ctimeNs !== before.ctimeNs,
      ) ||
      BigInt(bytes) !== before.size
    )
      throw new Error(
        'Installer changed while hashing; finish all signing/build steps before generating metadata',
      );
    return { fileName: basename(absolute), bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function verifyInstaller(record: ReleaseRecord, path: string) {
  const measured = await measureInstaller(path);
  for (const key of ['fileName', 'bytes', 'sha256'] as const)
    if (measured[key] !== record.artifact[key])
      throw new Error(`Installer ${key} does not match the release record`);
  return measured;
}

export async function writeCandidateRecord(record: ReleaseRecord, outputRoot: string) {
  const parsed = parseReleaseRecord(record);
  if (parsed.status !== 'candidate') throw new Error('This local generator only writes candidates');
  const directory = immutableReleaseDirectory(parsed.product, parsed.channel, parsed.version);
  const target = join(resolve(outputRoot), ...directory.split('/').filter(Boolean));
  await mkdir(target, { recursive: true });
  const path = join(target, 'candidate.json');
  // Never overwrite even an identical record. Use a separate candidate run root to rebuild.
  await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', { flag: 'wx' });
  return path;
}

export function releaseArguments(args: string[], permitted: string[], required: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!permitted.includes(key) || values.has(key))
      throw new Error(`Unknown or duplicate argument: ${key}`);
    if (key === '--require-published') values.set(key, 'true');
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      values.set(key, value);
    }
  }
  for (const key of required)
    if (!values.has(key)) throw new Error(`Missing required argument: ${key}`);
  return values;
}

export function isReleaseCli(moduleUrl: string) {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}
