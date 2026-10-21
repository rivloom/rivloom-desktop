import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const tailLimit = 64 * 1024;
const errorNames = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AggregateError', 'AbortError', 'TimeoutError', 'SystemError', 'PlatformError', 'ResolveMessage', 'ConfigurationError'] as const;
const errorCodes = ['ENOENT', 'ENOEXEC', 'EBADF', 'EPIPE', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_URL', 'ABORT_ERR'] as const;
type ErrorName = typeof errorNames[number] | 'unknown';
type ErrorCode = typeof errorCodes[number] | 'unknown';

export type MacosStartupEvidence = {
  schemaVersion: 1;
  status: 'read' | 'missing' | 'rejected' | 'unavailable';
  reason?: 'invalid-directory' | 'unsafe-path' | 'changed-file' | 'read-failed';
  exists: boolean;
  bytes: number;
  sampledBytes: number;
  tailTruncated: boolean;
  partialStartDiscarded: boolean;
  partialEndDiscarded: boolean;
  lines: { complete: number; parsed: number; unparsed: number; error: number; warn: number };
  observedRoutes: { health: boolean; provider: boolean };
  errorNames: ErrorName[];
  errorCodes: ErrorCode[];
  markers: { moduleMissing: boolean; permissionDenied: boolean; networkFailure: boolean; timeout: boolean };
};

function emptyEvidence(): MacosStartupEvidence {
  return { schemaVersion: 1, status: 'unavailable', exists: false, bytes: 0, sampledBytes: 0,
    tailTruncated: false, partialStartDiscarded: false, partialEndDiscarded: false,
    lines: { complete: 0, parsed: 0, unparsed: 0, error: 0, warn: 0 },
    observedRoutes: { health: false, provider: false }, errorNames: [], errorCodes: [],
    markers: { moduleMissing: false, permissionDenied: false, networkFailure: false, timeout: false } };
}

class Rejected extends Error {
  readonly reason: 'invalid-directory' | 'unsafe-path' | 'changed-file';
  constructor(reason: 'invalid-directory' | 'unsafe-path' | 'changed-file') { super(reason); this.reason = reason; }
}

function sameFile(a: Stats, b: Stats) { return a.dev === b.dev && a.ino === b.ino; }
function owned(info: Stats) { return typeof process.getuid !== 'function' || info.uid === process.getuid(); }
function directory(info: Stats) {
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Rejected('unsafe-path');
}
function regular(info: Stats) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info)
    || !Number.isSafeInteger(info.size) || info.size < 0) throw new Rejected('unsafe-path');
}

// Values are used only for fixed classifications below and are never returned.
function fields(line: string): Map<string, string> | undefined {
  const result = new Map<string, string>();
  const token = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s"=\\]+)/y;
  let position = 0;
  while (position < line.length) {
    token.lastIndex = position;
    const match = token.exec(line);
    if (!match) return undefined;
    let value: unknown = match[2];
    if (match[2].startsWith('"')) {
      try { value = JSON.parse(match[2]); } catch { return undefined; }
    }
    if (typeof value !== 'string') return undefined;
    // The formatter writes its authoritative level before message fields.
    if (!result.has(match[1])) result.set(match[1], value);
    position = token.lastIndex;
    if (position < line.length && line[position++] !== ' ') return undefined;
  }
  return result;
}

function summarize(bytes: Buffer, offset: number, evidence: MacosStartupEvidence) {
  let content = bytes.toString('utf8');
  if (offset > 0) {
    evidence.partialStartDiscarded = true;
    const newline = content.indexOf('\n');
    content = newline < 0 ? '' : content.slice(newline + 1);
  }
  if (content && !content.endsWith('\n')) {
    evidence.partialEndDiscarded = true;
    content = content.slice(0, content.lastIndexOf('\n') + 1);
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    evidence.lines.complete++;
    const values = fields(line);
    if (!values) { evidence.lines.unparsed++; continue; }
    evidence.lines.parsed++;
    const level = values.get('level')?.toUpperCase();
    if (level === 'ERROR' || level === 'FATAL') evidence.lines.error++;
    if (level === 'WARN' || level === 'WARNING') evidence.lines.warn++;
    for (const key of ['path', 'route', 'url', 'request.path', 'http.path']) {
      const value = values.get(key);
      if (value === '/global/health') evidence.observedRoutes.health = true;
      if (value === '/provider') evidence.observedRoutes.provider = true;
    }
    if (level !== 'ERROR' && level !== 'FATAL' && level !== 'WARN' && level !== 'WARNING') continue;
    for (const [key, value] of values) {
      if (/^(?:(?:error|cause)\.)*name$/.test(key)) {
        const name = errorNames.find(item => item === value) ?? 'unknown';
        if (!evidence.errorNames.includes(name)) evidence.errorNames.push(name);
      }
      if (/^(?:(?:error|cause)\.)*code$/.test(key)) {
        const code = errorCodes.find(item => item === value) ?? 'unknown';
        if (!evidence.errorCodes.includes(code)) evidence.errorCodes.push(code);
      }
      if (!/^(message|error|cause|(?:error|cause)\.(?:message|code|stack))$/.test(key)) continue;
      // The core formatter serializes native Error objects into strings, not .name/.code fields.
      for (const name of errorNames) {
        if (new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(value) && !evidence.errorNames.includes(name)) evidence.errorNames.push(name);
      }
      for (const code of errorCodes) {
        if (new RegExp(`(^|[^A-Za-z0-9_])${code}($|[^A-Za-z0-9_])`).test(value) && !evidence.errorCodes.includes(code)) evidence.errorCodes.push(code);
      }
      // These flags report literal markers, not a diagnosis of the startup failure.
      evidence.markers.moduleMissing ||= /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)|Module not found/.test(value);
      evidence.markers.permissionDenied ||= /\b(?:EACCES|EPERM)\b|[Pp]ermission denied/.test(value);
      evidence.markers.networkFailure ||= /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/.test(value);
      evidence.markers.timeout ||= /\b(?:ETIMEDOUT|TimeoutError)\b|[Tt]imed out/.test(value);
    }
  }
  evidence.errorNames.sort();
  evidence.errorCodes.sort();
}

/** Reads only the fixed core log under an owned app-data directory; never returns raw log values. */
export async function readMacosStartupEvidence(dataDirectory: string): Promise<MacosStartupEvidence> {
  const evidence = emptyEvidence();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) throw new Rejected('invalid-directory');
    const rootInfo = await lstat(dataDirectory);
    directory(rootInfo);
    // macOS /var is itself an OS alias; resolve ancestors once, then reject links below the supplied root.
    const root = await realpath(dataDirectory);
    const canonicalInfo = await lstat(root);
    directory(canonicalInfo);
    if (!sameFile(rootInfo, canonicalInfo)) throw new Rejected('changed-file');
    const parents: Array<{ path: string; info: Stats }> = [{ path: root, info: canonicalInfo }];
    let path = root;
    for (const segment of ['engine', 'data', 'opencode', 'log']) {
      path = join(path, segment);
      const info = await lstat(path);
      directory(info);
      parents.push({ path, info });
    }
    path = join(path, 'opencode.log');
    const before = await lstat(path);
    evidence.exists = true;
    regular(before);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await file.stat();
    regular(opened);
    if (!sameFile(before, opened)) throw new Rejected('changed-file');
    for (const parent of parents) {
      const now = await lstat(parent.path);
      directory(now);
      if (!sameFile(parent.info, now)) throw new Rejected('changed-file');
    }
    const offset = Math.max(0, opened.size - tailLimit);
    const bytes = Buffer.alloc(Math.min(opened.size, tailLimit));
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, offset + count);
      if (!read.bytesRead) throw new Rejected('changed-file');
      count += read.bytesRead;
    }
    const after = await file.stat(), named = await lstat(path);
    regular(after); regular(named);
    if (!sameFile(opened, after) || !sameFile(opened, named) || after.size < opened.size
      || (after.size === opened.size && after.mtimeMs !== opened.mtimeMs)) throw new Rejected('changed-file');
    evidence.status = 'read';
    evidence.bytes = opened.size;
    evidence.sampledBytes = count;
    evidence.tailTruncated = offset > 0;
    summarize(bytes, offset, evidence);
  } catch (error) {
    if (error instanceof Rejected) { evidence.status = 'rejected'; evidence.reason = error.reason; }
    else if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') evidence.status = 'missing';
    else { evidence.status = 'unavailable'; evidence.reason = 'read-failed'; }
  } finally { await file?.close().catch(() => {}); }
  return evidence;
}
