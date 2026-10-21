import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateDirectory, readPrivateFile } from './private-storage.ts';
import { assertMacosPrivateKey, createMacosKeychainStore, macosKeychainReferencePattern, type MacosKeychainStore } from './macos-keychain.ts';

export const nodeProtocolVersion = 1;

type IdentityMetadata = {
  version: 1;
  nodeID: string;
  brainID: string;
  createdAt: string;
  publicKey: string;
};
type StoredIdentity = IdentityMetadata & (
  | { protection: 'windows-dpapi-current-user' | 'linux-user-file'; protectedPrivateKey: string }
  | { protection: 'macos-keychain'; keychainReference: string }
);

export type NodeIdentity = {
  nodeID: string;
  brainID: string;
  createdAt: string;
  publicKey: string;
  fingerprint: string;
  sign(value: string): string;
};

const protectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$protected = [System.Security.Cryptography.ProtectedData]::Protect($value, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const unprotectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($value, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

function dpapi(script: string, value: Buffer) {
  if (process.platform !== 'win32')
    throw new Error('节点身份当前只支持 Windows DPAPI；非 Windows 平台不会启动节点网络。');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      input: value.toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    if (process.env.RIVLOOM_NODE_DEBUG === '1')
      console.error('Rivloom DPAPI diagnostic', {
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stderr: result.stderr.trim().slice(0, 1000),
      });
    throw new Error('Windows 无法保护节点私钥；节点网络保持关闭。');
  }
  try {
    return Buffer.from(result.stdout.trim(), 'base64');
  } catch {
    throw new Error('Windows 返回的节点密钥保护数据无效。');
  }
}

const protectedPrivateKey = (value: Buffer) => dpapi(protectScript, value).toString('base64');
const privateKey = (value: string) => dpapi(unprotectScript, Buffer.from(value, 'base64'));
const publicKeyBytes = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }) as Buffer;
export const nodeIDForPublicKey = (publicKey: Buffer) =>
  createHash('sha256').update(publicKey).digest('base64url').slice(0, 32);
export const fingerprintForPublicKey = (publicKey: Buffer) =>
  createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join(':');

function validateStored(value: unknown): StoredIdentity {
  if (!value || typeof value !== 'object') throw new Error('节点身份文件不是对象。');
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.nodeID !== 'string' ||
    !/^[A-Za-z0-9_-]{32}$/.test(item.nodeID) ||
    typeof item.brainID !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(item.brainID) ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.publicKey !== 'string' ||
    (item.protection === 'macos-keychain'
      ? typeof item.keychainReference !== 'string' || !macosKeychainReferencePattern.test(item.keychainReference) || 'protectedPrivateKey' in item
      : typeof item.protectedPrivateKey !== 'string' || !['windows-dpapi-current-user', 'linux-user-file'].includes(String(item.protection)))
  )
    throw new Error('节点身份文件字段无效。');
  return item as StoredIdentity;
}

function materialize(stored: StoredIdentity, platform: NodeJS.Platform = process.platform, keychain?: MacosKeychainStore): NodeIdentity {
  const expected = platform === 'win32' ? 'windows-dpapi-current-user' : platform === 'linux' ? 'linux-user-file' : platform === 'darwin' ? 'macos-keychain' : null;
  if (!expected || stored.protection !== expected)
    throw new Error('节点身份保护方式与当前平台不匹配；不会自动替换设备身份。');
  let secret: KeyObject;
  let publicBytes: Buffer;
  let secretBytes: Buffer | undefined;
  try {
    secretBytes = stored.protection === 'macos-keychain'
      ? keychain!.read(stored.keychainReference)
      : stored.protection === 'linux-user-file' ? Buffer.from(stored.protectedPrivateKey, 'base64') : privateKey(stored.protectedPrivateKey);
    if (stored.protection === 'macos-keychain') assertMacosPrivateKey(secretBytes);
    secret = createPrivateKey({
      key: secretBytes,
      format: 'der',
      type: 'pkcs8',
    });
    publicBytes = publicKeyBytes(createPublicKey(secret));
  } catch {
    throw new Error('节点私钥无法由当前系统用户读取；不会自动替换设备身份。');
  } finally {
    secretBytes?.fill(0);
  }
  if (
    stored.publicKey !== publicBytes.toString('base64') ||
    stored.nodeID !== nodeIDForPublicKey(publicBytes)
  )
    throw new Error('节点身份公私钥不匹配；不会自动替换设备身份。');
  return {
    nodeID: stored.nodeID,
    brainID: stored.brainID,
    createdAt: stored.createdAt,
    publicKey: stored.publicKey,
    fingerprint: fingerprintForPublicKey(publicBytes),
    sign: (value) => sign(null, Buffer.from(value), secret).toString('base64url'),
  };
}

/** A narrow injected store keeps creation/race/failure behavior testable without changing the OS. */
export function loadMacosNodeIdentity(root: string, keychain: MacosKeychainStore = createMacosKeychainStore()): NodeIdentity {
  privateDirectory(root);
  const path = join(root, 'node-identity.json');
  function loadExisting() {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384)
      throw new Error('Node identity must be a bounded regular file, not a symbolic link.');
    return materialize(validateStored(JSON.parse(readPrivateFile(path))), 'darwin', keychain);
  }
  let present = false;
  try { lstatSync(path); present = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) return loadExisting();

  const pair = generateKeyPairSync('ed25519');
  const publicBytes = publicKeyBytes(pair.publicKey);
  const secretBytes = pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const reference = randomUUID();
  const stored: StoredIdentity = {
    version: 1, nodeID: nodeIDForPublicKey(publicBytes), brainID: randomUUID(),
    createdAt: new Date().toISOString(), publicKey: publicBytes.toString('base64'),
    protection: 'macos-keychain', keychainReference: reference,
  };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let keyCreated = false;
  let published = false;
  function discardOwnKey() {
    try { keychain.remove(reference); }
    catch { throw new Error('节点身份未替换，但临时钥匙串条目无法清理；请检查钥匙串访问。'); }
    keyCreated = false;
  }
  try {
    try { keychain.create(reference, secretBytes); keyCreated = true; }
    catch { throw new Error('macOS 无法保护节点私钥；节点网络保持关闭。'); }
    writeFileSync(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      // Atomic create-only publication. A racing process cannot replace a persisted identity.
      linkSync(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch (error) {
    if (keyCreated && !published) discardOwnKey();
    throw error;
  } finally {
    secretBytes.fill(0);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  if (!published) {
    discardOwnKey();
    return loadExisting();
  }
  return materialize(stored, 'darwin', keychain);
}

export function loadNodeIdentity(root: string): NodeIdentity {
  if (process.platform === 'darwin') return loadMacosNodeIdentity(root);
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('节点身份只支持 Windows 与 Linux。');
  if (process.platform === 'linux') privateDirectory(root);
  else mkdirSync(root, { recursive: true });
  const path = join(root, 'node-identity.json');
  if (process.platform === 'linux') {
    // existsSync follows links, including dangling links. Such an existing identity
    // must be rejected rather than silently replaced with a different device key.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Node identity must not be a symbolic link.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (existsSync(path)) return materialize(validateStored(JSON.parse(process.platform === 'linux' ? readPrivateFile(path) : readFileSync(path, 'utf8'))));

  const pair = generateKeyPairSync('ed25519');
  const publicBytes = publicKeyBytes(pair.publicKey);
  const stored: StoredIdentity = {
    version: 1,
    nodeID: nodeIDForPublicKey(publicBytes),
    brainID: randomUUID(),
    createdAt: new Date().toISOString(),
    publicKey: publicBytes.toString('base64'),
    protectedPrivateKey: process.platform === 'linux'
      ? (pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64')
      : protectedPrivateKey(pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer),
    protection: process.platform === 'linux' ? 'linux-user-file' : 'windows-dpapi-current-user',
  };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows access is primarily enforced by DPAPI. */
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return materialize(stored);
}
