import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMacosKeychainStore } from '../server/macos-keychain.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { requireIsolatedMacosKeychain } from './macos-keychain-ci.ts';

const checkout = resolve(import.meta.dirname, '..');
const marker = 'rivloom-macos-native-identity-check';

export async function macosIdentitySmoke() {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Run native identity checks on macOS ARM64');
  requireIsolatedMacosKeychain();
  const directory = join(checkout, 'test-results/macos');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'identity-native-'));
  const path = join(root, 'node-identity.json');
  const store = createMacosKeychainStore();
  let reference: string | undefined;
  try {
    const first = loadNodeIdentity(root);
    const snapshot = readFileSync(path, 'utf8');
    const stored = JSON.parse(snapshot);
    assert.equal(stored.protection, 'macos-keychain');
    assert.equal('protectedPrivateKey' in stored, false);
    reference = stored.keychainReference;
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', root], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.equal(result.nodeID, first.nodeID);
    assert.equal(result.brainID, first.brainID);
    assert.equal(result.publicKey, first.publicKey);
    assert(verify(null, Buffer.from(marker), createPublicKey({ key: Buffer.from(first.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(result.signature, 'base64url')));
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    store.remove(reference!);
    assert.throws(() => loadNodeIdentity(root), /不会自动替换设备身份/);
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    const report = { platform: process.platform, arch: process.arch, status: 'passed', protection: 'macos-keychain',
      checks: ['native-keychain-create-read', 'cross-process-stable-identity', 'ed25519-signature', 'private-file-modes', 'missing-key-fails-without-replacement', 'own-item-deleted'] };
    writeFileSync(join(directory, 'identity-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (reference) store.remove(reference);
    // Keep only public identity metadata as bounded verification evidence; the private item is gone.
    if (existsSync(path)) assert.equal('protectedPrivateKey' in JSON.parse(readFileSync(path, 'utf8')), false);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--child') {
    assert.equal(process.argv.length, 4);
    requireIsolatedMacosKeychain();
    const root = resolve(process.argv[3]);
    assert(root.startsWith(join(checkout, 'test-results/macos/identity-native-')), 'Unexpected native identity fixture');
    const identity = loadNodeIdentity(root);
    console.log(JSON.stringify({ nodeID: identity.nodeID, brainID: identity.brainID, publicKey: identity.publicKey, signature: identity.sign(marker) }));
  } else {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/macos-identity-smoke.ts');
    await macosIdentitySmoke();
  }
}
