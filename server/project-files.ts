import { lstat, realpath, opendir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validProjectChangePath, sensitiveProjectChangePath } from '../shared/project-changes.ts';
import { editableTextLimit, officeFileLimit, textEditable, type ProjectFileListing } from '../shared/office-files.ts';
import { decodeOfficeText } from './office-parser.ts';
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const hidden = /^(?:\.git|node_modules|\.data|\.codex|\.agents|\.rivloom-knowledge)$/i;
export class ProjectFileError extends Error { status: number; constructor(code: string, status = 409) { super(code); this.status = status; } }
export async function projectFilePath(directory: string, path: string, allowRoot = false) {
  const root = resolve(directory);
  if (!same(root, await realpath(root)) || !(await lstat(root)).isDirectory()) throw new ProjectFileError('office_path');
  if (allowRoot && !path) return root;
  if (!validProjectChangePath(path) || sensitiveProjectChangePath(path) || path.split('/').some(part => hidden.test(part) || /[:\x00-\x1f]|[. ]$/.test(part)))
    throw new ProjectFileError('office_path', 403);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || !same(current, await realpath(current)) || info.isFile() && info.nlink !== 1)
      throw new ProjectFileError('office_path', 403);
  }
  const rel = relative(root, current); if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ProjectFileError('office_path', 403);
  return current;
}
export async function readProjectFile(directory: string, path: string, limit = officeFileLimit) {
  const target = await projectFilePath(directory, path); const before = await lstat(target);
  if (!before.isFile() || before.size > limit) throw new ProjectFileError('office_too_large', 413);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat(); if (info.ino !== before.ino || info.dev !== before.dev || info.size > limit || info.nlink !== 1) throw new ProjectFileError('office_changed');
    const buffer = Buffer.alloc(info.size); let offset = 0;
    while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) throw new ProjectFileError('office_changed'); offset += read.bytesRead; }
    const after = await handle.stat(); const current = await lstat(await projectFilePath(directory, path));
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.ino !== info.ino || current.dev !== info.dev)
      throw new ProjectFileError('office_changed');
    return { buffer, path: target, revision: createHash('sha256').update(buffer).digest('hex'), name: basename(path) };
  } finally { await handle.close(); }
}
export async function listProjectFiles(directory: string, path = '', search = ''): Promise<ProjectFileListing> {
  const start = await projectFilePath(directory, path, true); const result: ProjectFileListing = { path, entries: [], truncated: false };
  let scanned = 0;
  const walk = async (parent: string, prefix: string, depth: number) => {
    const children = await opendir(parent);
    for await (const child of children) {
      if (++scanned > 5000 || result.entries.length >= 500) { result.truncated = true; return; }
      const entry = prefix ? `${prefix}/${child.name}` : child.name;
      if (hidden.test(child.name) || sensitiveProjectChangePath(entry) || child.isSymbolicLink()) continue;
      try {
        const verified = await projectFilePath(directory, entry); const info = await lstat(verified);
        if ((!search || child.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (info.isFile() || info.isDirectory()))
          result.entries.push({ name: child.name, path: entry, directory: info.isDirectory(), bytes: info.size });
        if (search && info.isDirectory() && depth < 6) await walk(verified, entry, depth + 1);
      } catch { /* Inaccessible or concurrently moved entries are not selectable. */ }
      if (result.truncated) return;
    }
  };
  await walk(start, path, 0); result.entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)); return result;
}
const saving = new Set<string>();
export async function saveProjectText(directory: string, path: string, expectedRevision: string, text: string) {
  if (!textEditable(path) || Buffer.byteLength(text) > editableTextLimit || text.includes('\0')) throw new ProjectFileError('office_edit_unavailable');
  const target = await projectFilePath(directory, path); const key = process.platform === 'win32' ? target.toLowerCase() : target;
  if (saving.has(key)) throw new ProjectFileError('office_busy'); saving.add(key);
  const temporary = join(dirname(target), `.rivloom-save-${randomUUID()}.tmp`); let created = false;
  try {
    const current = await readProjectFile(directory, path, editableTextLimit);
    if (current.revision !== expectedRevision) throw new ProjectFileError('office_changed');
    if (decodeOfficeText(current.buffer).encoding !== 'utf-8') throw new ProjectFileError('office_edit_unavailable');
    const bytes = Buffer.from((current.buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? '\uFEFF' : '') + text);
    const handle = await open(temporary, 'wx', (await lstat(target)).mode); created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const latest = await readProjectFile(directory, path, editableTextLimit);
    if (latest.revision !== expectedRevision) throw new ProjectFileError('office_changed');
    await rename(temporary, target); created = false;
    return { revision: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  } finally { saving.delete(key); if (created) await unlink(temporary).catch(() => {}); }
}
