import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { engineSourceFile, verifyPreparedEngine } from '../server/engine-artifact.ts';
import { readMacosProcesses, type MacosProcess } from '../server/macos-process.mjs';
import { parseEngineStartupDiagnostic } from '../server/engine-startup-diagnostic.ts';
import { assertMacosArm64Executable, desktopNodeVersion, desktopPlatforms } from './desktop-platform.ts';
import { requireIsolatedMacosKeychain } from './macos-keychain-ci.ts';
import { readMacosStartupEvidence } from './macos-startup-evidence.ts';

const checkout = resolve(import.meta.dirname, '..');
const output = join(checkout, 'test-results/macos');
const identifier = 'com.rivloom.macospreview';
const productName = 'Rivloom Mac Preview';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const sameProcess = (a: MacosProcess, b: MacosProcess) => a.pid === b.pid && a.created !== null && a.created === b.created;

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

function run(command: string, args: string[], timeout = 30_000) {
  return execFileSync(command, args, { cwd: checkout, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function within(parent: string, path: string) {
  const suffix = relative(parent, path);
  assert(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'), 'Verification path escapes its owned directory');
}

async function regular(path: string) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), 'Expected a regular verification input');
  return info;
}

type FileEvidence = { path: string; bytes: number; sha256: string; executable: boolean };
async function inventory(directory: string, prefix = ''): Promise<FileEvidence[]> {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Runtime directories must be real');
  const files: FileEvidence[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), entry = await lstat(path);
    assert(!entry.isSymbolicLink(), 'Bundled runtime must not contain links');
    if (entry.isDirectory()) files.push(...await inventory(path, `${prefix}${name}/`));
    else {
      assert(entry.isFile(), 'Bundled runtime contains a special file');
      files.push({ path: prefix + name, bytes: entry.size, sha256: await digest(path), executable: (entry.mode & 0o111) !== 0 });
    }
  }
  return files;
}

async function verifyExecutable(path: string) {
  const bytes = await readFile(path);
  assertMacosArm64Executable(bytes);
  assert((await regular(path)).mode & 0o111, 'Bundled native executable lacks execute permission');
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path]);
  return sha(bytes);
}

function applicationAction(pid: number, action: 'activate' | 'quit') {
  assert(Number.isSafeInteger(pid) && pid > 1);
  // NSRunningApplication targets the exact process we launched, without an application-name lookup.
  const source = `ObjC.import('AppKit'); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!app) throw new Error('Owned application is unavailable'); if (!app.${action === 'quit' ? 'terminate' : 'activateWithOptions(2)'}) throw new Error('Application request was rejected');`;
  run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], 15_000);
}

type RuntimeInfo = { desktopPID: number; backendPID: number; url: string; version: string };
type ReadinessEvidence = { polls: number; runtimeFile: boolean; phase: 'runtime' | 'engine' | 'frontend' | 'identity'; healthStatus?: number; engineReady?: boolean; fetchFailure?: 'timeout' | 'network' };
type LaunchedApp = { child: ChildProcess; info?: RuntimeInfo; owned: Map<string, MacosProcess>; launchError?: Error; readiness?: ReadinessEvidence };

async function observeOwned(app: LaunchedApp) {
  const rows = await readMacosProcesses();
  const desktop = rows.find(row => row.pid === app.child.pid);
  if (!app.owned.size) {
    assert(desktop && desktop.parentPid === process.pid && desktop.created !== null && desktop.uid === process.getuid?.(), 'Native application ownership cannot be established');
    app.owned.set(`${desktop.pid}:${desktop.created}`, desktop);
  }
  const live = new Map<number, MacosProcess>();
  for (const observed of rows) {
    for (const owned of app.owned.values()) if (sameProcess(observed, owned)) live.set(observed.pid, observed);
  }
  for (let previous = -1; previous !== live.size;) {
    previous = live.size;
    for (const row of rows) {
      const parent = live.get(row.parentPid);
      if (!parent || live.has(row.pid)) continue;
      assert(row.created !== null && parent.created !== null && BigInt(row.created) >= BigInt(parent.created) && row.uid === parent.uid, 'Descendant process identity is ambiguous');
      live.set(row.pid, row);
      app.owned.set(`${row.pid}:${row.created}`, row);
    }
  }
  return [...live.values()].filter(row => !row.zombie);
}

async function ready(app: LaunchedApp, data: string, version: string) {
  const deadline = Date.now() + 60_000;
  const evidence: ReadinessEvidence = app.readiness = { polls: 0, runtimeFile: false, phase: 'runtime' };
  while (Date.now() < deadline) {
    evidence.polls++;
    assert(!app.launchError, 'Native application could not launch');
    assert(alive(app.child), 'Native application exited before becoming ready');
    if (existsSync(join(data, 'desktop-runtime.json'))) {
      evidence.runtimeFile = true;
      let info: RuntimeInfo | undefined;
      try { info = JSON.parse(await readFile(join(data, 'desktop-runtime.json'), 'utf8')); } catch { /* The app may still be writing its bounded diagnostic. */ }
      if (info) {
        assert.equal(info.desktopPID, app.child.pid);
        assert.equal(info.version, version);
        assert(Number.isSafeInteger(info.backendPID) && info.backendPID > 1);
        const url = new URL(info.url);
        assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 49152 && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'Native runtime URL is not owned loopback');
        evidence.phase = 'engine';
        const observed = await observeOwned(app);
        assert(observed.some(row => row.pid === info.backendPID && row.parentPid === app.child.pid), 'Backend does not belong to the launched app');
        app.info = info;
        try {
          const response = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) });
          const health = await response.json() as { ok?: boolean; engineReady?: boolean };
          evidence.healthStatus = response.status;
          evidence.engineReady = health.engineReady === true;
          delete evidence.fetchFailure;
          if (response.ok && health.ok && health.engineReady) {
            evidence.phase = 'frontend';
            const home = await fetch(info.url, { signal: AbortSignal.timeout(5000) });
            assert.equal(home.status, 200);
            assert((await home.text()).includes('<html'), 'The installed application did not serve its frontend');
            evidence.phase = 'identity';
            const identityPath = join(data, 'node-identity.json');
            const identityBytes = await readFile(identityPath, 'utf8'), identity = JSON.parse(identityBytes);
            assert.equal(identity.protection, 'macos-keychain');
            assert.equal('protectedPrivateKey' in identity, false);
            assert.equal((await regular(identityPath)).mode & 0o777, 0o600);
            assert.equal((await lstat(data)).mode & 0o777, 0o700);
            return { identityBytes, nodeID: identity.nodeID, brainID: identity.brainID };
          }
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
          evidence.fetchFailure = error instanceof DOMException ? 'timeout' : 'network';
        }
      }
    }
    await delay(300);
  }
  throw new Error('Installed macOS application did not become ready within 60 seconds');
}

/** Bounded failure-only API inspection. Credentials and response bodies never enter the report. */
async function failureSnapshot(app: LaunchedApp, data: string) {
  const result: Record<string, unknown> = { applicationAlive: alive(app.child), readiness: app.readiness ?? null,
    coreLog: await readMacosStartupEvidence(data) };
  let observed: MacosProcess[];
  try { observed = await observeOwned(app); result.ownedProcesses = observed.length; }
  catch { result.processInventoryUnavailable = true; return result; }
  if (!app.info || !alive(app.child) || !observed.some(row => row.pid === app.info!.backendPID && row.parentPid === app.child.pid)) return result;
  const signal = AbortSignal.timeout(4000);
  try {
    // app.info.url was already checked as this exact application's owned loopback listener.
    const tokenPath = join(data, 'desktop-auth-token.txt');
    const tokenInfo = await regular(tokenPath);
    assert(tokenInfo.uid === process.getuid?.() && (tokenInfo.mode & 0o077) === 0 && tokenInfo.size > 0 && tokenInfo.size <= 4096);
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const auth = await fetch(`${app.info.url}/api/auth/desktop`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Rivloom-Request': '1', 'X-Rivloom-Desktop-Token': token }, body: '{}' });
    result.authenticationStatus = auth.status;
    const cookie = auth.headers.get('set-cookie')?.split(';')[0];
    await auth.body?.cancel();
    if (!auth.ok || !cookie) return result;
    const response = await fetch(`${app.info.url}/api/bootstrap`, { signal, headers: { Cookie: cookie, 'X-Rivloom-Request': '1' } });
    result.bootstrapStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); return result; }
    const state = await response.json() as { engine?: { ready?: boolean; error?: unknown; models?: unknown[]; startupDiagnostic?: unknown }; network?: { status?: unknown; local?: unknown } };
    result.engine = { ready: state.engine?.ready === true, models: Array.isArray(state.engine?.models) ? state.engine.models.length : null,
      failure: state.engine?.error === 'OpenCode 服务已退出，请重启应用。' ? 'host-exited'
        : state.engine?.error === 'OpenCode 启动失败。检查系统架构和已锁定的引擎安装；重启应用后再试。' ? 'initialization-failed'
          : state.engine?.error ? 'reported' : 'none',
      startupDiagnostic: parseEngineStartupDiagnostic(state.engine?.startupDiagnostic) ?? null };
    result.network = { localIdentity: !!state.network?.local,
      status: ['starting', 'online', 'degraded', 'disabled'].includes(String(state.network?.status)) ? state.network?.status : 'invalid' };
  } catch { result.apiSnapshotUnavailable = true; }
  return result;
}

async function stop(app: LaunchedApp, data: string) {
  await observeOwned(app);
  if (alive(app.child)) applicationAction(app.child.pid!, 'quit');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const active = await observeOwned(app);
    if (!alive(app.child) && active.length === 0) {
      assert.equal(app.child.exitCode, 0, 'Native application did not exit cleanly');
      assert(!existsSync(join(data, 'desktop-runtime.json')), 'Native shutdown left its runtime diagnostic behind');
      return { recordedProcesses: app.owned.size, exitCode: app.child.exitCode, proof: 'normal-application-quit-and-creation-time-process-inventory' };
    }
    await delay(200);
  }
  throw new Error('Normal application quit did not stop every observed owned process');
}

export async function smokeMacosPackage(dmgArgument?: string) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Package verification requires native macOS ARM64');
  requireIsolatedMacosKeychain();
  const source = { commit: run('git', ['rev-parse', 'HEAD']), tree: run('git', ['rev-parse', 'HEAD^{tree}']) };
  assert(/^[a-f0-9]{40}$/.test(source.commit) && /^[a-f0-9]{40}$/.test(source.tree), 'Package source revision is unavailable');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Package verification requires unchanged tracked source inputs');
  const bundleRoot = join(checkout, 'src-tauri/target/release/bundle/dmg');
  const candidates = (await readdir(bundleRoot)).filter(name => name.endsWith('.dmg'));
  if (!dmgArgument) assert.equal(candidates.length, 1, 'Expected exactly one current macOS DMG');
  const dmg = resolve(dmgArgument ?? join(bundleRoot, candidates[0]));
  within(bundleRoot, dmg);
  assert.equal(await realpath(dmg), dmg, 'DMG path must not traverse links');
  const artifactInfo = await regular(dmg);
  const artifact = { fileName: basename(dmg), bytes: artifactInfo.size, sha256: await digest(dmg) };
  await mkdir(output, { recursive: true });
  const working = await mkdtemp(join(output, 'package-'));
  const mount = join(working, 'mount'), installed = join(working, `${productName}.app`), data = join(working, 'data');
  await mkdir(mount); await mkdir(data, { mode: 0o700 });
  const report: Record<string, unknown> = {
    schemaVersion: 1, status: 'failed', artifact, source, checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node, image: process.env.ImageOS, imageVersion: process.env.ImageVersion },
    checks: {}, nativeInterface: { status: 'not-interactively-verified', scope: 'Native app launch and normal quit are exercised. Tray menus, close/reopen, dialogs, clipboard, notifications, file pickers and physical LAN still require interactive acceptance.' },
    distribution: { signing: 'ad-hoc', notarized: false, scope: 'CI-copied application from a read-only DMG; browser quarantine and Gatekeeper approval are not tested.' },
  };
  let mounted = false, app: LaunchedApp | undefined, failure: unknown, cleanupFailure: unknown;
  const serviceLog: string[] = [];
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], 60_000);
    mounted = true;
    const sourceApp = join(mount, `${productName}.app`);
    assert((await lstat(sourceApp)).isDirectory() && !(await lstat(sourceApp)).isSymbolicLink(), 'DMG application is missing or linked');
    run('/usr/bin/ditto', [sourceApp, installed], 60_000);
    run('/usr/bin/hdiutil', ['detach', mount], 30_000); mounted = false;
    const infoPath = join(installed, 'Contents/Info.plist');
    const plist = (key: string) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', infoPath]);
    const version = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version;
    assert.equal(plist('CFBundleIdentifier'), identifier);
    assert.equal(plist('CFBundleShortVersionString'), version);
    assert.equal(plist('CFBundleExecutable'), 'Rivloom');
    assert.equal(plist('LSMinimumSystemVersion'), '14.0');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', installed]);
    const executable = join(installed, 'Contents/MacOS/Rivloom');
    const desktopSHA256 = await verifyExecutable(executable);
    const runtime = join(installed, 'Contents/Resources/runtime');
    const files = await inventory(runtime);
    assert.deepEqual(files, await inventory(join(checkout, 'src-tauri/resources/runtime')), 'Installed runtime differs from the prepared and signed files');
    const manifestBytes = await readFile(join(runtime, 'runtime-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.target, { platform: 'darwin', arch: 'arm64' });
    assert.equal(manifest.product.identifier, identifier); assert.equal(manifest.product.version, version);
    assert.equal(manifest.inputs.packageLockSha256, await digest(join(checkout, 'package-lock.json')));
    assert.equal(manifest.inputs.cargoLockSha256, await digest(join(checkout, 'src-tauri/Cargo.lock')));
    assert.equal(manifest.node.version, desktopNodeVersion);
    assert.equal(manifest.node.archiveSHA256, desktopPlatforms['darwin-arm64'].sha256);
    assert.equal(manifest.node.archiveURL, desktopPlatforms['darwin-arm64'].url);
    assert.equal(await verifyExecutable(join(runtime, 'node')), manifest.node.sha256);
    assert.equal(run(join(runtime, 'node'), ['--version']), `v${desktopNodeVersion}`);
    assert.deepEqual(manifest.nativeHelpers.map((item: { path: string }) => item.path).sort(), ['native/rivloom-keychain', 'native/rivloom-process']);
    for (const helper of manifest.nativeHelpers) assert.equal(await verifyExecutable(join(runtime, helper.path)), helper.sha256);
    assert.deepEqual(await readFile(join(runtime, engineSourceFile('darwin-arm64'))), await readFile(join(checkout, engineSourceFile('darwin-arm64'))));
    const engine = verifyPreparedEngine(runtime, 'darwin-arm64');
    assert.equal(await verifyExecutable(join(engine.directory, 'opencode')), engine.binarySHA256);
    assert.equal(run(join(engine.directory, 'opencode'), ['--version']), engine.source.version);
    assert.deepEqual(manifest.opencode, { version: engine.source.version, sha256: engine.binarySHA256, source: `${engine.source.repository}#${engine.source.commit}` });
    for (const document of [...manifest.documents, ...manifest.notices]) {
      assert(files.some(item => item.path === document.path && item.sha256 === document.sha256), 'Packaged notice or document differs from its manifest');
    }
    report.package = { version, identifier, desktopSHA256, runtimeManifestSHA256: sha(manifestBytes), runtimeFiles: files.length,
      runtimeInventorySHA256: sha(JSON.stringify(files)), node: manifest.node, opencode: manifest.opencode, nativeHelpers: manifest.nativeHelpers };
    report.checks = { readOnlyDmgCopy: true, bundleIdentity: true, nativeArm64: true, codesignIntegrity: true,
      exactPreparedRuntime: true, nodeVersion: true, engineSourceReceipt: true, nativeHelperHashes: true, notices: true };
    await writeFile(join(output, 'package-files.json'), JSON.stringify(files, null, 2) + '\n');
    const environment: NodeJS.ProcessEnv = { ...process.env, RIVLOOM_DATA_DIR: data, RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']) delete environment[key];
    const start = () => {
      const child = spawn(executable, [], { cwd: working, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      const launched: LaunchedApp = { child, owned: new Map() };
      child.once('error', error => { launched.launchError = error; });
      const append = (bytes: Buffer) => { serviceLog.push(bytes.toString()); while (serviceLog.join('').length > 32_768) serviceLog.shift(); };
      child.stdout!.on('data', append); child.stderr!.on('data', append);
      return launched;
    };
    app = start();
    const first = await ready(app, data, version);
    try {
      applicationAction(app.child.pid!, 'activate');
      await delay(500);
      run('/usr/sbin/screencapture', ['-x', join(output, 'package-desktop.png')], 10_000);
      report.screenshot = { file: 'package-desktop.png', scope: 'Whole runner desktop after requesting app activation; supplemental evidence only.' };
    } catch { report.screenshot = { status: 'unavailable', scope: 'Runner screen capture/activation is not an acceptance check.' }; }
    const firstStop = await stop(app, data); app = undefined;
    app = start();
    const second = await ready(app, data, version);
    assert.equal(second.identityBytes, first.identityBytes, 'Installed application changed its persisted identity on restart');
    assert.equal(second.nodeID, first.nodeID); assert.equal(second.brainID, first.brainID);
    const secondStop = await stop(app, data); app = undefined;
    report.checks = { readOnlyDmgCopy: true, bundleIdentity: true, nativeArm64: true, codesignIntegrity: true,
      exactPreparedRuntime: true, nodeVersion: true, engineSourceReceipt: true, nativeHelperHashes: true, notices: true,
      nativeStartup: true, engineReady: true, frontendServed: true, keychainIdentity: true, privateFileModes: true,
      restartIdentity: true, normalApplicationQuit: true, ownedProcessesExited: true, runtimeDiagnosticRemoved: true };
    report.shutdown = [firstStop, secondStop];
    report.status = 'passed';
  } catch (error) {
    failure = error; report.error = error instanceof Error ? error.message : String(error);
    if (app) report.failureEvidence = await failureSnapshot(app, data);
  }
  finally {
    if (app) {
      try { await stop(app, data); app = undefined; }
      catch (error) { cleanupFailure = error; report.cleanupError = error instanceof Error ? error.message : String(error); }
    }
    if (mounted) {
      try { run('/usr/bin/hdiutil', ['detach', mount], 30_000); mounted = false; }
      catch (error) { cleanupFailure = error; report.cleanupError = 'Could not detach the verification-only DMG mount'; }
    }
    await writeFile(join(output, 'package-service.log'), serviceLog.join(''));
    if (!failure && !cleanupFailure && !app && !mounted) {
      within(output, working);
      assert.equal(await realpath(working), working, 'Disposable verification directory has changed');
      // rm does not follow links inside this task-created directory. No user installation is touched.
      await rm(working, { recursive: true });
      report.cleanup = { status: 'completed', removed: [relative(checkout, working)], retained: ['DMG artifact', 'package-smoke.json', 'package-files.json', 'package-service.log'], keychain: 'CI cleanup restores and deletes the isolated test keychain after all checks.' };
    } else report.cleanup = { status: 'retained-for-diagnosis', directory: relative(checkout, working) };
    if (cleanupFailure) report.status = 'failed';
    await writeFile(join(output, 'package-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  console.log('Native macOS ARM64 DMG copy, runtime verification, startup, restart identity and normal quit passed. Interactive UI acceptance remains separate.');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length <= 3, 'Usage: node scripts/macos-package-smoke.ts [checkout-dmg-path]');
  await smokeMacosPackage(process.argv[2]);
}
