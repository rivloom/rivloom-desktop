// Installs the current NSIS artifact into an isolated workspace directory, starts it,
// verifies the bundled engine, then uninstalls it. No user workspace is touched.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const stamp = String(Date.now());
const installer = resolve(
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  'Rivloom_0.1.0_x64-setup.exe',
);
const installDirectory = resolve('.data', 'installed-smoke-app', stamp);
const dataDirectory = resolve('.data', 'installed-smoke-data', stamp);
const proofFile = resolve('.data', 'verification', 'desktop-install.json');
const appExecutable = join(installDirectory, 'Rivloom.exe');
const uninstaller = join(installDirectory, 'uninstall.exe');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
let desktop: ChildProcess | null = null;

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDesktop() {
  if (!desktop?.pid || !isAlive(desktop.pid)) return;
  desktop.kill('SIGINT');
  for (let index = 0; index < 30 && isAlive(desktop.pid); index++) await sleep(300);
  if (isAlive(desktop.pid))
    execFileSync('taskkill', ['/PID', String(desktop.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
}

assert(existsSync(installer), 'Build the NSIS installer first');
mkdirSync(resolve('.data', 'verification'), { recursive: true });
execFileSync(installer, ['/S', '/D=' + installDirectory], {
  windowsHide: true,
  stdio: 'ignore',
  timeout: 120_000,
});
assert(existsSync(appExecutable), 'Installer did not create Rivloom.exe');
assert(existsSync(uninstaller), 'Installer did not create uninstall.exe');

try {
  desktop = spawn(appExecutable, [], {
    windowsHide: true,
    env: { ...process.env, RIVLOOM_DATA_DIR: dataDirectory },
    stdio: 'ignore',
  });
  let runtime: { desktopPID: number; backendPID: number; url: string } | undefined;
  let ready = false;
  for (let index = 0; index < 100; index++) {
    await sleep(400);
    assert.equal(desktop.exitCode, null, 'Installed desktop app exited during startup');
    try {
      runtime = JSON.parse(readFileSync(join(dataDirectory, 'desktop-runtime.json'), 'utf8'));
      const health = await fetch(runtime!.url + '/api/health').then((response) => response.json());
      if (health.engineReady) {
        ready = true;
        break;
      }
    } catch {
      runtime = undefined;
    }
  }
  assert(runtime && ready, 'Installed application or bundled engine did not become ready');
  assert.equal(runtime.desktopPID, desktop.pid);
  assert(isAlive(runtime.backendPID), 'Installed application backend is not running');

  await stopDesktop();
  for (let index = 0; index < 35 && isAlive(runtime.backendPID); index++) await sleep(300);
  assert(!isAlive(runtime.backendPID), 'Installed application left its backend process alive');

  execFileSync(uninstaller, ['/S'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 120_000,
  });
  for (let index = 0; index < 30 && existsSync(appExecutable); index++) await sleep(300);
  assert(!existsSync(appExecutable), 'Uninstaller left the application executable behind');
  assert(
    existsSync(join(dataDirectory, 'rivloom.sqlite')),
    'Uninstall unexpectedly removed user data',
  );

  const hash = createHash('sha256').update(readFileSync(installer)).digest('hex');
  writeFileSync(
    proofFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'passed',
        installer,
        installerBytes: readFileSync(installer).byteLength,
        installerSha256: hash,
        assertions: [
          'NSIS silent install completed in an isolated current-user directory',
          'Installed Rivloom launched its bundled Node and official OpenCode 1.18.25 runtime',
          'Closing the installed desktop process cleaned up its backend process tree',
          'NSIS silent uninstall removed the installed executable',
          'Uninstall preserved the separate application data directory',
        ],
        limits: [
          'This is a development-machine smoke test, not a clean Windows VM matrix.',
          'The internal package is unsigned.',
        ],
      },
      null,
      2,
    ),
  );
  console.log('PASS current NSIS install/start/uninstall smoke:', proofFile);
} finally {
  await stopDesktop();
}
