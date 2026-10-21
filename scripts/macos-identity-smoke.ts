import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMacosKeychainStore, MacosKeychainError, type MacosKeychainStore } from '../server/macos-keychain.ts';
import { loadMacosNodeIdentity, loadNodeIdentity, type NodeIdentity } from '../server/node-identity.ts';
import { requireIsolatedMacosKeychain } from './macos-keychain-ci.ts';
import { testEnvironment } from './ci-workspace.ts';

const checkout = resolve(import.meta.dirname, '..');
const marker = 'rivloom-macos-native-identity-check';
const failureStages = ['identity', 'helper', 'create', 'read', 'delete'];
const failureCodes = ['invalid-request', 'not-found', 'duplicate', 'access-denied', 'unavailable', 'invalid-data', 'internal-error', 'identity-invalid'];
type ChildIdentity = { ok: true; nodeID: string; brainID: string; publicKey: string; signature: string };

class NativeIdentityCheckError extends Error {
  readonly stage: string;
  readonly code: string;
  constructor(stage: string, code: string) {
    super(`Native identity check failed: stage=${stage}, code=${code}`);
    this.stage = stage;
    this.code = code;
  }
}

function childIdentity(root: string, env: NodeJS.ProcessEnv, stage: string): ChildIdentity {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', root], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status === null) throw new NativeIdentityCheckError(stage, 'process-unavailable');
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new NativeIdentityCheckError(stage, 'invalid-response'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new NativeIdentityCheckError(stage, 'invalid-response');
  const value = response as Record<string, unknown>;
  if (value.ok === false && Object.keys(value).sort().join(',') === 'code,ok,stage'
    && failureStages.includes(String(value.stage)) && failureCodes.includes(String(value.code)))
    throw new NativeIdentityCheckError(`${stage}/${value.stage}`, String(value.code));
  if (result.status !== 0 || value.ok !== true || Object.keys(value).sort().join(',') !== 'brainID,nodeID,ok,publicKey,signature'
    || !['nodeID', 'brainID', 'publicKey', 'signature'].every(key => typeof value[key] === 'string'))
    throw new NativeIdentityCheckError(stage, 'invalid-response');
  return value as ChildIdentity;
}

function assertSameIdentity(identity: NodeIdentity, result: ChildIdentity) {
  assert.equal(result.nodeID, identity.nodeID);
  assert.equal(result.brainID, identity.brainID);
  assert.equal(result.publicKey, identity.publicKey);
  assert(verify(null, Buffer.from(marker), createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(result.signature, 'base64url')));
}

function childCheck(root: string) {
  let failure: { stage: string; code: string } | undefined;
  try {
    requireIsolatedMacosKeychain();
    assert(root.startsWith(join(checkout, 'test-results/macos/identity-native-')), 'Unexpected native identity fixture');
    const before = [process.env.HOME, process.env.USER, process.env.LOGNAME, process.env.USERPROFILE, process.env.RIVLOOM_DATA_DIR];
    let store: MacosKeychainStore;
    try { store = createMacosKeychainStore(); }
    catch (error) {
      failure = { stage: 'helper', code: error instanceof MacosKeychainError ? error.code : 'unavailable' };
      throw error;
    }
    function tracked<T>(stage: string, action: () => T): T {
      try { return action(); }
      catch (error) {
        failure ||= { stage, code: error instanceof MacosKeychainError ? error.code : 'unavailable' };
        throw error;
      }
    }
    const identity = loadMacosNodeIdentity(root, {
      create(reference, secret) { tracked('create', () => store.create(reference, secret)); },
      read(reference) { return tracked('read', () => store.read(reference)); },
      remove(reference) { tracked('delete', () => store.remove(reference)); },
    });
    assert.deepEqual([process.env.HOME, process.env.USER, process.env.LOGNAME, process.env.USERPROFILE, process.env.RIVLOOM_DATA_DIR], before);
    console.log(JSON.stringify({ ok: true, nodeID: identity.nodeID, brainID: identity.brainID, publicKey: identity.publicKey, signature: identity.sign(marker) }));
  } catch {
    // Identity loading deliberately hides native failures. Preserve only its fixed operation/code.
    console.log(JSON.stringify({ ok: false, ...(failure || { stage: 'identity', code: 'identity-invalid' }) }));
    process.exitCode = 1;
  }
}

export async function macosIdentitySmoke() {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Run native identity checks on macOS ARM64');
  requireIsolatedMacosKeychain();
  const directory = join(checkout, 'test-results/macos');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'identity-native-'));
  const path = join(root, 'node-identity.json');
  const isolatedRoot = join(root, 'isolated-data');
  const isolatedPath = join(isolatedRoot, 'node-identity.json');
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const store = createMacosKeychainStore();
  const references = new Set<string>();
  const checks: string[] = [];
  let stage = 'normal-create';
  let failure: { stage: string; code: string } | undefined;
  const before = [process.env.HOME, process.env.USER, process.env.LOGNAME, process.env.USERPROFILE, process.env.RIVLOOM_DATA_DIR];
  try {
    const first = loadNodeIdentity(root);
    const snapshot = readFileSync(path, 'utf8');
    const stored = JSON.parse(snapshot);
    assert.equal(stored.protection, 'macos-keychain');
    assert.equal('protectedPrivateKey' in stored, false);
    references.add(stored.keychainReference);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    checks.push('native-keychain-create-read', 'private-file-modes');
    stage = 'normal-reload';
    assertSameIdentity(first, childIdentity(root, { ...testEnvironment(root), GITHUB_ACTIONS: 'true' }, stage));
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    checks.push('cross-process-stable-identity', 'ed25519-signature');

    // Match headless-service/task sanitization, then deliberately override account labels too.
    const isolatedEnvironment = { ...testEnvironment(root), HOME: home, USERPROFILE: home,
      USER: 'fixture-user', LOGNAME: 'fixture-login', GITHUB_ACTIONS: 'true' };
    stage = 'isolated-home-reload';
    assertSameIdentity(first, childIdentity(root, isolatedEnvironment, stage));
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    checks.push('isolated-home-read-preserves-existing-identity');
    stage = 'isolated-home-create';
    const created = childIdentity(isolatedRoot, isolatedEnvironment, stage);
    const isolatedSnapshot = readFileSync(isolatedPath, 'utf8');
    const isolatedStored = JSON.parse(isolatedSnapshot);
    references.add(isolatedStored.keychainReference);
    assert.equal(isolatedStored.protection, 'macos-keychain');
    assert.equal('protectedPrivateKey' in isolatedStored, false);
    assert.equal(lstatSync(isolatedRoot).mode & 0o777, 0o700);
    assert.equal(lstatSync(isolatedPath).mode & 0o777, 0o600);
    stage = 'original-home-reload';
    assertSameIdentity(loadNodeIdentity(isolatedRoot), created);
    assert.equal(readFileSync(isolatedPath, 'utf8'), isolatedSnapshot);
    assert.deepEqual([process.env.HOME, process.env.USER, process.env.LOGNAME, process.env.USERPROFILE, process.env.RIVLOOM_DATA_DIR], before);
    checks.push('isolated-home-create-reloads-with-original-home', 'application-environment-unchanged');
    stage = 'missing-item';
    store.remove(stored.keychainReference);
    assert.throws(() => loadNodeIdentity(root), /不会自动替换设备身份/);
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    checks.push('missing-key-fails-without-replacement');
  } catch (error) {
    failure = error instanceof NativeIdentityCheckError ? { stage: error.stage, code: error.code }
      : { stage, code: error instanceof MacosKeychainError ? error.code : 'identity-invalid' };
  } finally {
    try {
      // A child may have published metadata before a later assertion failed.
      for (const identityPath of [path, isolatedPath]) if (existsSync(identityPath)) {
        const stored = JSON.parse(readFileSync(identityPath, 'utf8'));
        assert.equal('protectedPrivateKey' in stored, false);
        references.add(stored.keychainReference);
      }
      for (const reference of references) store.remove(reference);
      checks.push('own-items-deleted');
    } catch (error) {
      failure ||= { stage: 'cleanup', code: error instanceof MacosKeychainError ? error.code : 'identity-invalid' };
    }
  }
  const report = { platform: process.platform, arch: process.arch, status: failure ? 'failed' : 'passed', protection: 'macos-keychain', checks, ...(failure ? { failure } : {}) };
  writeFileSync(join(directory, 'identity-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (failure) throw new NativeIdentityCheckError(failure.stage, failure.code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--child') {
    assert.equal(process.argv.length, 4);
    childCheck(resolve(process.argv[3]));
  } else {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/macos-identity-smoke.ts');
    await macosIdentitySmoke();
  }
}
