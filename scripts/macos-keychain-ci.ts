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
  // Do not surface native stderr or the input, which may contain the temporary password.
  assert(!result.error && result.signal === null && result.status === 0, 'Isolated CI keychain operation failed');
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Invalid isolated CI keychain response'); }
  assert(response && typeof response === 'object' && !Array.isArray(response), 'Invalid isolated CI keychain response');
  const value = response as Record<string, unknown>;
  assert(value.version === 1 && value.ok === true, 'Isolated CI keychain operation failed');
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
  const result = control(built.path, { operation: 'test-create', keychainPath, password: randomBytes(32).toString('hex') });
  const state = validateState({ schemaVersion: 1, status: 'prepared', keychainPath: result.keychainPath,
    previousDefault: result.previousDefault, previousSearchList: result.previousSearchList, helperSHA256: built.sha256 });
  assert.equal(state.keychainPath, keychainPath, 'The system created an unexpected keychain location');
  // Persist recovery information before changing either default or search list.
  writeState(state);
  try {
    control(built.path, { operation: 'test-activate', keychainPath });
    state.status = 'active';
    writeState(state);
  } catch {
    await cleanupMacosTestKeychain();
    throw new Error('Could not activate the isolated CI keychain');
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
  if (!existsSync(macosKeychainStatePath)) { console.log('No isolated macOS CI keychain was prepared.'); return; }
  const stat = lstatSync(macosKeychainStatePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 24 * 1024 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'Invalid CI keychain recovery file');
  const state = validateState(JSON.parse(readFileSync(macosKeychainStatePath, 'utf8')));
  if (state.status === 'cleaned') { console.log('Isolated macOS CI keychain was already restored and deleted.'); return; }
  const helper = join(root, '.data/macos-keychain-control/native/rivloom-keychain-testing');
  assert.equal(verifyMacosKeychainExecutable(helper), state.helperSHA256, 'CI keychain control helper has changed');
  control(helper, { operation: 'test-restore', keychainPath: state.keychainPath,
    previousDefault: state.previousDefault, previousSearchList: state.previousSearchList });
  state.status = 'cleaned';
  writeState(state);
  console.log('Original macOS keychain settings restored; only the isolated CI keychain was deleted.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3 && ['setup', 'cleanup'].includes(process.argv[2]), 'Usage: node scripts/macos-keychain-ci.ts setup|cleanup');
  if (process.argv[2] === 'setup') await setupMacosTestKeychain();
  else await cleanupMacosTestKeychain();
}
