import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { enginePackage } from '../server/engine.ts';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { parseHeadlessControl, publishHeadlessControl } from '../server/headless-control.ts';
import { privateDirectory, readPrivateFile, writePrivateFile } from '../server/private-storage.ts';
import { linuxMediaProcessCount } from '../server/workflow-quiescence.ts';
import { acquireDataLock, linuxProcessIdentity } from '../server/process-lock.ts';

test('engine targets select the pinned Rivloom fork on Windows and Linux x64', () => {
  assert.equal(enginePackage('win32', 'x64'), 'rivloom-opencode-runtime');
  assert.equal(enginePackage('linux', 'x64'), 'rivloom-opencode-runtime');
  assert.throws(() => enginePackage('linux', 'arm64'), /Unsupported/);
  for (const [platform, arch] of [['linux', 'ia32'], ['darwin', 'arm64'], ['win32', 'arm64']] as const)
    assert.throws(() => enginePackage(platform, arch), /Unsupported/);
});

test('local headless credentials cannot redirect authentication off loopback', () => {
  const value = { version: 1, pid: 123, url: 'http://127.0.0.1:4310', token: randomBytes(32).toString('base64url') };
  assert.deepEqual(parseHeadlessControl(value), value);
  for (const url of ['http://192.168.1.2:4310', 'http://localhost:4310', 'https://127.0.0.1:4310',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:4310@evil.test', 'http://127.0.0.1:4310/path'])
    assert.throws(() => parseHeadlessControl({ ...value, url }), /Invalid/);
  assert.throws(() => parseHeadlessControl({ ...value, token: 'weak' }), /Invalid/);
  assert.throws(() => parseHeadlessControl({ ...value, pid: -1 }), /Invalid/);
});

test('headless shutdown removes only its own control record', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-control-'));
  privateDirectory(root);
  const path = join(root, 'headless-control.json');
  const cleanup = publishHeadlessControl(root, 'http://127.0.0.1:4310', randomBytes(32).toString('base64url'));
  assert.equal(JSON.parse(readPrivateFile(path)).pid, process.pid);
  writePrivateFile(path, 'replacement');
  cleanup();
  assert.equal(readPrivateFile(path), 'replacement');
  const mine = publishHeadlessControl(root, 'http://127.0.0.1:4311', randomBytes(32).toString('base64url'));
  mine();
  assert.equal(existsSync(path), false);
});

if (process.platform === 'linux') test('Linux node identity persists with private OS permissions and refuses unsafe or mismatched keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-linux-identity-'));
  const path = join(root, 'node-identity.json');
  const first = loadNodeIdentity(root);
  const original = readPrivateFile(path);
  assert.equal(loadNodeIdentity(root).nodeID, first.nodeID);
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(original).protection, 'linux-user-file');
  assert(verify(null, Buffer.from('headless-test'), createPublicKey({ key: Buffer.from(first.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(first.sign('headless-test'), 'base64url')));
  chmodSync(path, 0o644);
  assert.throws(() => loadNodeIdentity(root), /permissions 0600/);
  chmodSync(path, 0o600);
  const stored = JSON.parse(original);
  stored.nodeID = 'A'.repeat(32);
  writePrivateFile(path, JSON.stringify(stored));
  assert.throws(() => loadNodeIdentity(root), /公私钥不匹配/);
  assert.equal(JSON.parse(readPrivateFile(path)).nodeID, stored.nodeID);
  stored.protection = 'windows-dpapi-current-user';
  writePrivateFile(path, JSON.stringify(stored));
  assert.throws(() => loadNodeIdentity(root), /平台不匹配/);
  const linkedRoot = join(root, 'linked');
  symlinkSync(root, linkedRoot);
  assert.throws(() => privateDirectory(linkedRoot), /real directory/);
  const other = mkdtempSync(join(tmpdir(), 'rivloom-dangling-identity-'));
  symlinkSync(join(other, 'missing'), join(other, 'node-identity.json'));
  assert.throws(() => loadNodeIdentity(other), /symbolic link/);
});

if (process.platform === 'linux') test('Linux handoff process audit detects an active foreground media process', async () => {
  const child = spawn(process.execPath, ['-e', "process.title='ffmpeg'; console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((done, reject) => { child.stdout!.once('data', () => done()); child.once('error', reject); });
    assert(await linuxMediaProcessCount() >= 1);
  } finally {
    const stopped = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGTERM'); await stopped;
  }
});

if (process.platform === 'linux') test('Linux reboot and PID reuse cannot keep an unrelated process as workspace owner', () => {
  const identity = linuxProcessIdentity();
  for (const previous of [{ ...identity, bootID: '00000000-0000-0000-0000-000000000000' }, { ...identity, startTime: '0' }]) {
    const root = mkdtempSync(join(tmpdir(), 'rivloom-linux-lock-'));
    const path = join(root, 'app.lock');
    writeFileSync(path, JSON.stringify({ pid: process.pid, nonce: 'previous', linux: previous }), { mode: 0o600 });
    acquireDataLock(root);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).linux, identity);
    assert.throws(() => acquireDataLock(root), /已有运行实例/);
  }
});

if (process.platform === 'linux') test('Linux engine owner stops the owned shell process group after IPC disconnect', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-linux-processes-'));
  const childPath = join(root, 'child.mjs');
  const pidPath = join(root, 'pid');
  // The child reaps its subprocess on TERM, like a cooperative engine shutdown.
  writeFileSync(childPath, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';\nconst child=spawn('sleep',['60']); writeFileSync(${JSON.stringify(pidPath)},String(child.pid));\nprocess.on('SIGTERM',()=>{child.kill(); child.once('exit',()=>process.exit(0));}); setInterval(()=>{},1000);`);
  const host = spawn(process.execPath, [resolve('server/engine-host.mjs'), process.execPath, childPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = new Promise<number | null>((done, reject) => { host.once('exit', done); host.once('error', reject); });
  try {
    for (let i = 0; i < 100 && !existsSync(pidPath); i++) await delay(30);
    assert(existsSync(pidPath));
    const pid = Number(readFileSync(pidPath, 'utf8'));
    host.disconnect();
    assert.equal(await exit, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { if (host.connected) host.disconnect(); }
});

test('private data helper refuses ordinary files in place of a directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-private-'));
  mkdirSync(join(root, 'directory'));
  writeFileSync(join(root, 'file'), 'test');
  assert.throws(() => privateDirectory(join(root, 'file')));
  assert.throws(() => readPrivateFile(join(root, 'directory')), /regular file/);
});
