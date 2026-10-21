import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

export const macosKeychainReferencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const privateKeyPrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const helperErrors = new Set(['invalid-request', 'not-found', 'duplicate', 'access-denied', 'unavailable', 'invalid-data', 'internal-error']);

export type MacosKeychainStore = {
  create(reference: string, secret: Buffer): void;
  read(reference: string): Buffer;
  remove(reference: string): void;
};

export class MacosKeychainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super('macOS 钥匙串无法读取或保护节点身份；请解锁钥匙串并重新启动，现有身份不会被替换。');
    this.name = 'MacosKeychainError';
    this.code = helperErrors.has(code) ? code : 'unavailable';
  }
}

export function assertMacosPrivateKey(secret: Buffer) {
  if (secret.length !== 48 || !secret.subarray(0, privateKeyPrefix.length).equals(privateKeyPrefix))
    throw new MacosKeychainError('invalid-data');
}

function checkReference(reference: string) {
  if (!macosKeychainReferencePattern.test(reference)) throw new MacosKeychainError('invalid-request');
}

/** Strictly decode the bounded native protocol. Never include native output in an error. */
export function parseMacosKeychainResponse(output: string, operation: 'create' | 'read' | 'delete'): Buffer | undefined {
  if (Buffer.byteLength(output, 'utf8') > 8192) throw new MacosKeychainError('invalid-data');
  let response: unknown;
  try { response = JSON.parse(output); } catch { throw new MacosKeychainError('invalid-data'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new MacosKeychainError('invalid-data');
  const value = response as Record<string, unknown>;
  if (value.version !== 1 || typeof value.ok !== 'boolean') throw new MacosKeychainError('invalid-data');
  if (!value.ok) {
    if (Object.keys(value).sort().join(',') !== 'error,ok,version' || typeof value.error !== 'string' || !helperErrors.has(value.error))
      throw new MacosKeychainError('invalid-data');
    throw new MacosKeychainError(value.error);
  }
  if (operation !== 'read') {
    if (Object.keys(value).sort().join(',') !== 'ok,version') throw new MacosKeychainError('invalid-data');
    return;
  }
  if (Object.keys(value).sort().join(',') !== 'ok,secret,version' || typeof value.secret !== 'string' || !/^[A-Za-z0-9+/]{64}$/.test(value.secret))
    throw new MacosKeychainError('invalid-data');
  const secret = Buffer.from(value.secret, 'base64');
  assertMacosPrivateKey(secret);
  return secret;
}

export function resolveMacosKeychainHelper(): string {
  const candidates = [
    resolve(import.meta.dirname, '../native/rivloom-keychain'),
    resolve(import.meta.dirname, '../src-tauri/resources/runtime/native/rivloom-keychain'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
      throw new MacosKeychainError('unavailable');
    return candidate;
  }
  throw new MacosKeychainError('unavailable');
}

/** Keychain preferences belong to the effective OS user, not an overridable process HOME. */
export function macosKeychainEnvironment(): NodeJS.ProcessEnv {
  let account: { uid: number; homedir: string; username: string };
  try { account = userInfo(); } catch { throw new MacosKeychainError('unavailable'); }
  if ((process.getuid && account.uid !== process.getuid()) || (process.geteuid && account.uid !== process.geteuid())
    || !account.homedir || !isAbsolute(account.homedir)
    || account.homedir.includes('\0') || !account.username || account.username.includes('\0'))
    throw new MacosKeychainError('unavailable');
  return {
    ...Object.fromEntries(['TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    HOME: account.homedir, USER: account.username, LOGNAME: account.username,
  };
}

/** The product always uses its bundled helper and the OS default keychain. */
export function createMacosKeychainStore(): MacosKeychainStore {
  if (process.platform !== 'darwin') throw new MacosKeychainError('unavailable');
  const helper = resolveMacosKeychainHelper();
  function request(operation: 'create' | 'read' | 'delete', reference: string, secret?: Buffer) {
    checkReference(reference);
    if (secret) assertMacosPrivateKey(secret);
    const input = JSON.stringify({ version: 1, operation, reference, ...(secret ? { secret: secret.toString('base64') } : {}) });
    const result = spawnSync(helper, [], {
      input, encoding: 'utf8', timeout: 15_000, maxBuffer: 8192,
      // No data is passed as an argument, environment override or diagnostic.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: macosKeychainEnvironment(),
    });
    if (result.error || result.signal || result.status === null) throw new MacosKeychainError('unavailable');
    const value = parseMacosKeychainResponse(result.stdout, operation);
    if (result.status !== 0) throw new MacosKeychainError('unavailable');
    return value;
  }
  return {
    create(reference, secret) { request('create', reference, secret); },
    read(reference) { return request('read', reference)!; },
    remove(reference) {
      try { request('delete', reference); }
      catch (error) { if (!(error instanceof MacosKeychainError) || error.code !== 'not-found') throw error; }
    },
  };
}
