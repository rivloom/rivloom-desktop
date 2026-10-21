import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { loadMacosNodeIdentity } from '../server/node-identity.ts';
import { MacosKeychainError, macosKeychainEnvironment, parseMacosKeychainResponse, type MacosKeychainStore } from '../server/macos-keychain.ts';

test('Keychain helper uses the OS account while leaving the isolated application home unchanged', () => {
  const previous = process.env;
  const account = userInfo();
  try {
    process.env = { HOME: '/fixture-home', USER: 'fixture-user', LOGNAME: 'fixture-login', LANG: 'C',
      NODE_OPTIONS: '--require=secret', DYLD_INSERT_LIBRARIES: 'secret', OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret' };
    assert.deepEqual(macosKeychainEnvironment(), { HOME: account.homedir, USER: account.username, LOGNAME: account.username, LANG: 'C' });
    assert.equal(process.env.HOME, '/fixture-home');
    assert.equal(process.env.USER, 'fixture-user');
  } finally { process.env = previous; }
});

function memoryStore() {
  const items = new Map<string, Buffer>();
  const created: string[] = [], removed: string[] = [];
  const store: MacosKeychainStore = {
    create(reference, secret) {
      assert(!items.has(reference));
      items.set(reference, Buffer.from(secret)); created.push(reference);
    },
    read(reference) {
      const bytes = items.get(reference);
      if (!bytes) throw new MacosKeychainError('not-found');
      return Buffer.from(bytes);
    },
    remove(reference) { removed.push(reference); items.delete(reference); },
  };
  return { store, items, created, removed };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-macos-identity-'));
  return { root, path: join(root, 'node-identity.json'), cleanup() {
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert(!lstatSync(root).isSymbolicLink());
    rmSync(root, { recursive: true, force: true });
  } };
}

test('macOS identity persists only an opaque Keychain reference and retains its Ed25519 identity', () => {
  const f = fixture(), memory = memoryStore();
  try {
    const first = loadMacosNodeIdentity(f.root, memory.store);
    const snapshot = readFileSync(f.path, 'utf8');
    const stored = JSON.parse(snapshot);
    const second = loadMacosNodeIdentity(f.root, memory.store);
    assert.equal(stored.protection, 'macos-keychain');
    assert.equal('protectedPrivateKey' in stored, false);
    assert.equal(memory.created.length, 1);
    assert(!snapshot.includes(memory.items.get(stored.keychainReference)!.toString('base64')));
    assert.equal(first.nodeID, second.nodeID);
    assert.equal(first.brainID, second.brainID);
    assert.equal(first.sign('same-challenge'), second.sign('same-challenge'));
    assert(verify(null, Buffer.from('same-challenge'), createPublicKey({ key: Buffer.from(first.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(first.sign('same-challenge'), 'base64url')));
    assert.equal(readFileSync(f.path, 'utf8'), snapshot);
  } finally { f.cleanup(); }
});

test('missing or denied Keychain material never replaces a persisted node identity', () => {
  const f = fixture(), memory = memoryStore();
  try {
    loadMacosNodeIdentity(f.root, memory.store);
    const snapshot = readFileSync(f.path, 'utf8');
    memory.items.clear();
    assert.throws(() => loadMacosNodeIdentity(f.root, memory.store), /不会自动替换设备身份/);
    assert.equal(memory.created.length, 1);
    assert.equal(readFileSync(f.path, 'utf8'), snapshot);
    const denied = { ...memory.store, read() { throw new Error('sensitive-diagnostic-must-not-escape'); } };
    assert.throws(() => loadMacosNodeIdentity(f.root, denied), (error: Error) => !error.message.includes('sensitive-diagnostic') && /不会自动替换/.test(error.message));
    assert.equal(readFileSync(f.path, 'utf8'), snapshot);
  } finally { f.cleanup(); }
});

test('macOS rejects legacy platform identities, invalid references and mismatched public keys', () => {
  const f = fixture(), memory = memoryStore();
  try {
    loadMacosNodeIdentity(f.root, memory.store);
    const original = JSON.parse(readFileSync(f.path, 'utf8'));
    for (const protection of ['windows-dpapi-current-user', 'linux-user-file']) {
      const stored = { ...original, protection, protectedPrivateKey: 'not-a-key' };
      delete stored.keychainReference;
      writeFileSync(f.path, JSON.stringify(stored), { mode: 0o600 });
      assert.throws(() => loadMacosNodeIdentity(f.root, memory.store), /平台不匹配/);
    }
    for (const keychainReference of ['../other-item', 'A'.repeat(36), original.keychainReference.toUpperCase()]) {
      writeFileSync(f.path, JSON.stringify({ ...original, keychainReference }), { mode: 0o600 });
      assert.throws(() => loadMacosNodeIdentity(f.root, memory.store), /字段无效/);
    }
    writeFileSync(f.path, JSON.stringify({ ...original, nodeID: 'A'.repeat(32) }), { mode: 0o600 });
    assert.throws(() => loadMacosNodeIdentity(f.root, memory.store), /公私钥不匹配/);
    assert.equal(memory.created.length, 1);
  } finally { f.cleanup(); }
});

test('a concurrent creator preserves the winning identity and deletes only its losing Keychain item', () => {
  const f = fixture(), memory = memoryStore();
  const unrelated = randomUUID();
  memory.items.set(unrelated, Buffer.from('unrelated'));
  let winner: ReturnType<typeof loadMacosNodeIdentity> | undefined;
  const racing: MacosKeychainStore = {
    ...memory.store,
    create(reference, secret) {
      memory.store.create(reference, secret);
      winner = loadMacosNodeIdentity(f.root, memory.store);
    },
  };
  try {
    const result = loadMacosNodeIdentity(f.root, racing);
    assert(winner);
    assert.equal(result.nodeID, winner.nodeID);
    assert.equal(result.brainID, winner.brainID);
    assert.equal(memory.created.length, 2);
    assert.deepEqual(memory.removed, [memory.created[0]]);
    assert.equal(memory.items.size, 2);
    assert.equal(memory.items.get(unrelated)!.toString(), 'unrelated');
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).keychainReference, memory.created[1]);
  } finally { f.cleanup(); }
});

test('a filesystem collision rolls back the new Keychain item without changing the existing entry', () => {
  const f = fixture(), memory = memoryStore();
  const collision = { ...memory.store, create(reference: string, secret: Buffer) { memory.store.create(reference, secret); mkdirSync(f.path); } };
  try {
    assert.throws(() => loadMacosNodeIdentity(f.root, collision), /regular file|EACCES|EPERM|EEXIST/);
    assert.equal(memory.created.length, 1);
    assert.deepEqual(memory.removed, memory.created);
    assert.equal(memory.items.size, 0);
    assert(lstatSync(f.path).isDirectory());
  } finally { f.cleanup(); }
});

test('failed Keychain creation does not publish plaintext or leak native errors', () => {
  const f = fixture();
  const store: MacosKeychainStore = { create() { throw new Error('sensitive-error'); }, read() { throw new Error('unused'); }, remove() { throw new Error('unused'); } };
  try {
    assert.throws(() => loadMacosNodeIdentity(f.root, store), (error: Error) => !error.message.includes('sensitive-error') && /无法保护/.test(error.message));
    assert.equal(existsSync(f.path), false);
  } finally { f.cleanup(); }
});

if (process.platform !== 'win32') test('macOS identity rejects symbolic links and oversized metadata before Keychain access', () => {
  const f = fixture(), memory = memoryStore();
  try {
    symlinkSync(join(f.root, 'missing'), f.path);
    assert.throws(() => loadMacosNodeIdentity(f.root, memory.store), /symbolic link/);
    assert.equal(memory.created.length, 0);
  } finally { f.cleanup(); }
  const oversized = fixture();
  try {
    writeFileSync(oversized.path, 'x'.repeat(16_385), { mode: 0o600 });
    assert.throws(() => loadMacosNodeIdentity(oversized.root, memory.store), /bounded regular file/);
    assert.equal(memory.created.length, 0);
  } finally { oversized.cleanup(); }
});

test('native Keychain responses reject extra data, invalid keys and unbounded or secret-bearing diagnostics', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const encoded = key.toString('base64');
  assert.deepEqual(parseMacosKeychainResponse(JSON.stringify({ version: 1, ok: true, secret: encoded }), 'read'), key);
  assert.equal(parseMacosKeychainResponse('{"version":1,"ok":true}', 'create'), undefined);
  for (const value of ['x'.repeat(8193), '{}', 'null', '[]', JSON.stringify({ version: 1, ok: true, secret: encoded, extra: true }),
    JSON.stringify({ version: 1, ok: true, secret: 'A'.repeat(64) }), JSON.stringify({ version: 1, ok: false, error: encoded }),
    JSON.stringify({ version: 1, ok: false, error: 'not-found', diagnostic: encoded })]) {
    assert.throws(() => parseMacosKeychainResponse(value, 'read'), (error: Error) => error instanceof MacosKeychainError && !error.message.includes(encoded));
  }
  assert.throws(() => parseMacosKeychainResponse('{"version":1,"ok":false,"error":"access-denied"}', 'read'), (error: MacosKeychainError) => error.code === 'access-denied');
  assert.throws(() => parseMacosKeychainResponse(JSON.stringify({ version: 1, ok: true, secret: encoded }), 'delete'), /钥匙串/);
});
