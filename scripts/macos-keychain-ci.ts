import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacosKeychainHelper, verifyMacosKeychainExecutable } from './macos-keychain-build.ts';

const root = resolve(import.meta.dirname, '..');
export const macosKeychainStatePath = join(root, 'test-results/macos/keychain-state.json');
type KeychainState = {
  schemaVersion: 1;
  status: 'prepared' | 'active' | 'cleaned';
  keychainPath: string;
  previousDefault: string;
  previousSearchList: string[];
  helperSHA256: string;
};

function requireRunner() {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Keychain CI setup requires native macOS ARM64');
  assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true', 'Only an ephemeral GitHub Actions runner may replace its default test keychain');
}

function realDirectory(path: string) {
  const absolute = resolve(path);
  assert(absolute.startsWith(root + '/'), 'CI keychain output must remain inside this checkout');
  const components = absolute.slice(root.length + 1).split('/');
  let cursor = root;
  for (const component of components) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const stat = lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.(), 'CI keychain directory must be owned and real');
  }
  chmodSync(absolute, 0o700);
}

function validateState(value: unknown): KeychainState {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid CI keychain state');
  const state = value as KeychainState;
  assert(state.schemaVersion === 1 && ['prepared', 'active', 'cleaned'].includes(state.status), 'Invalid CI keychain state');
  assert(typeof state.keychainPath === 'string' && dirname(dirname(state.keychainPath)) === join(root, '.data')
    && /^rivloom-macos-keychain-[0-9a-f-]{36}$/.test(basename(dirname(state.keychainPath)))
    && basename(state.keychainPath) === 'rivloom-macos-ci.keychain-db', 'Unexpected CI keychain path');
  assert(typeof state.previousDefault === 'string' && state.previousDefault.startsWith('/') && state.previousDefault.length <= 4096, 'Invalid prior default keychain');
  assert(Array.isArray(state.previousSearchList) && state.previousSearchList.length <= 32 && state.previousSearchList.every(path => typeof path === 'string' && path.startsWith('/') && path.length <= 4096), 'Invalid prior keychain list');
  assert(/^[0-9a-f]{64}$/.test(state.helperSHA256), 'Invalid CI helper digest');
  const parent = lstatSync(dirname(state.keychainPath));
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.(), 'CI keychain directory has changed');
  return state;
}

function control(helper: string, request: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(helper, [], {
    input: JSON.stringify({ version: 1, ...request }), encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Only fixed operation/phase labels and numeric OSStatus values are diagnostic.
  // Never surface native stderr, raw stdout or the request's temporary password.
  const operation = ['test-snapshot', 'test-create', 'test-activate', 'test-restore'].includes(String(request.operation)) ? String(request.operation) : 'unknown';
  if (result.error || result.signal !== null || result.status === null) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code && ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'ENOMEM'].includes(code) ? code : 'process-failed';
    const signal = result.signal && /^SIG[A-Z]+$/.test(result.signal) ? result.signal : 'none';
    throw new Error(`Isolated CI keychain operation failed: stage=${operation}, code=${reason}, signal=${signal}`);
  }
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Invalid isolated CI keychain response'); }
  assert(response && typeof response === 'object' && !Array.isArray(response), 'Invalid isolated CI keychain response');
  const value = response as Record<string, unknown>;
  if (value.version === 1 && value.ok === false) {
    const phases = ['disable-interaction', 'snapshot-default', 'snapshot-search-list', 'verify-default', 'verify-search-list', 'create', 'create-restore-search-list', 'create-cleanup-delete', 'unlock-created', 'configure-created', 'created-path', 'activate-open', 'activate-default', 'activate-search-list', 'restore-current-default', 'restore-default', 'restore-search-list', 'restore-delete'];
    const codes = ['not-found', 'duplicate', 'access-denied', 'unavailable', 'invalid-request', 'invalid-data', 'internal-error'];
    assert(Object.keys(value).every(key => ['version', 'ok', 'error', 'phase', 'nativeStatus'].includes(key)) && phases.includes(String(value.phase)) && codes.includes(String(value.error)) && (value.nativeStatus === undefined || Number.isInteger(value.nativeStatus) && Number(value.nativeStatus) >= -2147483648 && Number(value.nativeStatus) <= 2147483647), 'Invalid isolated CI keychain failure response');
    throw new Error(`Isolated CI keychain operation failed: stage=${operation}/${value.phase}, code=${value.error}${value.nativeStatus === undefined ? '' : `, OSStatus=${value.nativeStatus}`}`);
  }
  assert(result.status === 0 && value.version === 1 && value.ok === true, 'Isolated CI keychain operation failed');
  return value;
}

function writeState(state: KeychainState) {
  writeFileSync(macosKeychainStatePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(macosKeychainStatePath, 0o600);
}

export async function setupMacosTestKeychain() {
  requireRunner();
  realDirectory(dirname(macosKeychainStatePath));
  if (existsSync(macosKeychainStatePath)) {
    const previous = validateState(JSON.parse(readFileSync(macosKeychainStatePath, 'utf8')));
    assert.equal(previous.status, 'cleaned', 'An earlier isolated keychain must be restored before another setup');
  }
  const built = await prepareMacosKeychainHelper(root, join(root, '.data/macos-keychain-control'), { testing: true });
  const directory = join(root, '.data', `rivloom-macos-keychain-${randomUUID()}`);
  realDirectory(directory);
  const keychainPath = join(directory, 'rivloom-macos-ci.keychain-db');
  const snapshot = control(built.path, { operation: 'test-snapshot', keychainPath });
  const state = validateState({ schemaVersion: 1, status: 'prepared', keychainPath,
    previousDefault: snapshot.previousDefault, previousSearchList: snapshot.previousSearchList, helperSHA256: built.sha256 });
  // Creation itself may alter the search list. Persist recovery before that first mutation.
  writeState(state);
  try {
    const result = control(built.path, { operation: 'test-create', keychainPath, password: randomBytes(32).toString('hex'),
      previousDefault: state.previousDefault, previousSearchList: state.previousSearchList });
    assert.equal(result.keychainPath, keychainPath, 'The system created an unexpected keychain location');
    control(built.path, { operation: 'test-activate', keychainPath });
    state.status = 'active';
    writeState(state);
  } catch (error) {
    try { await cleanupMacosTestKeychain(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Isolated CI keychain setup and recovery both failed'); }
    throw error;
  }
  console.log('Isolated macOS CI keychain is active; the original default and search list are recorded for cleanup.');
}

export function requireIsolatedMacosKeychain() {
  requireRunner();
  const stat = lstatSync(macosKeychainStatePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 24 * 1024 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'Invalid CI keychain state file');
  const state = validateState(JSON.parse(readFileSync(macosKeychainStatePath, 'utf8')));
  assert.equal(state.status, 'active', 'Native identity checks require an active isolated CI keychain');
  return state;
}

export async function cleanupMacosTestKeychain() {
  requireRunner();
  if (!existsSync(macosKeychainStatePath)) { console.log('No isolated CI keychain recovery state exists; setup did not reach its first mutation.'); return; }
  const stat = lstatSync(macosKeychainStatePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 24 * 1024 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'Invalid CI keychain recovery file');
  const state = validateState(JSON.parse(readFileSync(macosKeychainStatePath, 'utf8')));
  if (state.status === 'cleaned') { console.log('Original keychain settings were already restored; no isolated CI keychain remains active.'); return; }
  const helper = join(root, '.data/macos-keychain-control/native/rivloom-keychain-testing');
  assert.equal(verifyMacosKeychainExecutable(helper), state.helperSHA256, 'CI keychain control helper has changed');
  const result = control(helper, { operation: 'test-restore', keychainPath: state.keychainPath,
    previousDefault: state.previousDefault, previousSearchList: state.previousSearchList });
  assert.equal(typeof result.deleted, 'boolean', 'Missing isolated keychain deletion result');
  state.status = 'cleaned';
  writeState(state);
  console.log(result.deleted ? 'Original macOS keychain settings restored; only the isolated CI keychain was deleted.'
    : 'Original macOS keychain settings restored; no temporary keychain file existed to delete.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3 && ['setup', 'cleanup'].includes(process.argv[2]), 'Usage: node scripts/macos-keychain-ci.ts setup|cleanup');
  if (process.argv[2] === 'setup') await setupMacosTestKeychain();
  else await cleanupMacosTestKeychain();
}
