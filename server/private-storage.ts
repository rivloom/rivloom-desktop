import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Headless secrets are protected by the OS user, not by a second key beside the file. */
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Rivloom data directory must be a real directory.');
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid?.()) throw new Error('Rivloom data directory must belong to the current user.');
    chmodSync(path, 0o700);
  }
}

export function readPrivateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Rivloom secret must be a regular file.');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    throw new Error('Rivloom secret must belong to the current user with permissions 0600.');
  return readFileSync(path, 'utf8');
}

export function writePrivateFile(path: string, value: string) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
