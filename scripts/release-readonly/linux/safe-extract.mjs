// Task-owned tar shim: inspect all member paths/types before extraction.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
assert.equal(process.platform, 'linux');
const [sandbox, operation, fileName] = process.argv.slice(2);
assert.match(sandbox || '', /^\/var\/tmp\/rivloom-public-x64-[A-Za-z0-9]+$/);
assert.equal(resolve(sandbox), sandbox); assert.equal(await realpath('/var/tmp'), '/var/tmp'); assert.equal(await realpath(sandbox), sandbox);
const info = await lstat(sandbox); assert(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o077, 0);
assert.equal(operation, '-xzf'); assert.equal(fileName, 'Rivloom_0.1.30_linux_x64.tar.gz'); assert.equal(process.argv.length, 5);
const archive = join(sandbox, fileName), archiveInfo = await lstat(archive); assert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink());
const inspector = `import json, os, pathlib, sys, tarfile
archive, sandbox = sys.argv[1:]
root = pathlib.Path(sandbox)
seen = set()
files = directories = 0
with tarfile.open(archive, 'r:gz') as source:
 for member in source.getmembers():
  name = member.name.rstrip('/')
  assert name and not name.startswith('/') and '\\\\' not in name and ':' not in name
  assert all(ord(c) >= 32 and ord(c) != 127 for c in name)
  parts = name.split('/')
  assert parts[0] == 'rivloom' and all(p and p not in ('.', '..') for p in parts)
  assert member.isdir() or member.isfile(), 'Links and special tar members are forbidden'
  assert name not in seen, 'Duplicate member path'
  seen.add(name)
  target = root.joinpath(*parts)
  assert target == root / 'rivloom' or str(target).startswith(str(root / 'rivloom') + '/')
  for existing in [target, *target.parents]:
   if existing == root.parent: break
   assert not existing.is_symlink(), 'Existing extraction path is a symlink'
  files += int(member.isfile())
  directories += int(member.isdir())
assert files > 0 and 'rivloom' in seen
print(json.dumps({'files': files, 'directories': directories, 'links': 0, 'specialFiles': 0, 'pathsConfined': True}))
`;
const metadata = JSON.parse(execFileSync('/usr/bin/python3', ['-c', inspector, archive, sandbox], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
execFileSync('/usr/bin/tar', ['-xzf', archive, '--directory', sandbox, '--no-same-owner', '--no-same-permissions'], { stdio: 'inherit' });
await writeFile(join(sandbox, 'tar-extraction-boundary.json'), JSON.stringify({ at: new Date().toISOString(), sandbox, archive: fileName, ...metadata }) + '\n', { mode: 0o600 });
