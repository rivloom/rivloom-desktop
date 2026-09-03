// Real NSIS install/upgrade/restart/uninstall checks, guarded by the PowerShell metadata wrapper.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { ServiceClient, modelFixture, until } from './m34-fixtures.ts';
import type { Task } from '../shared/types.ts';

assert.equal(
  process.env.RIVLOOM_INSTALLER_TEST_GUARDED,
  '1',
  'Use scripts/desktop-install-smoke.ps1 to preserve installation metadata',
);
const root = resolve(process.env.RIVLOOM_INSTALLER_TEST_ROOT || '.');
const testBase = resolve('.data', 'installer-smoke');
const rootRelative = relative(testBase, root);
assert(
  !isAbsolute(rootRelative) && /^[a-f0-9]{32}$/.test(rootRelative),
  'Invalid isolated installer root',
);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const installer = resolve(
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  `Rivloom_${version}_x64-setup.exe`,
);
const baseline = resolve(
  process.env.RIVLOOM_INSTALLER_BASELINE ||
    'src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe',
);
assert(
  existsSync(installer) && existsSync(baseline),
  'Both current and baseline installers are required',
);
assert.notEqual(installer, baseline, 'Upgrade baseline must be a different installer');
const installDirectory = join(root, 'app');
const dataDirectory = join(root, 'upgrade-data');
const freshData = join(root, 'fresh-data');
const projectDirectory = join(root, 'ordinary-project');
const appExecutable = join(installDirectory, 'Rivloom.exe');
const uninstaller = join(installDirectory, 'uninstall.exe');
const proofFile = resolve('.data', 'verification', 'desktop-install.json');
const fixture = await modelFixture();
const assertions: string[] = [];
let desktop: ChildProcess | null = null;
let ownedPIDs: number[] = [];
const proof: Record<string, unknown> = {
  date: new Date().toISOString(),
  status: 'running',
  installer,
  installerBytes: statSync(installer).size,
  version,
  baseline: basename(baseline),
  root,
  assertions,
  limits: [
    'Development-machine smoke test; not a clean Windows VM or physical multi-device acceptance.',
    'Unsigned internal package; no real model requests or user credentials.',
    'Registry restoration is checked separately by the mandatory PowerShell wrapper.',
  ],
};
function pass(message: string) {
  assertions.push(message);
  console.log('PASS', message);
}
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processes() {
  const result = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("Rivloom.exe","node.exe","opencode.exe") } | Select-Object ProcessId,Name,ExecutablePath)',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(result.trim()) as {
    ProcessId: number;
    Name: string;
    ExecutablePath: string | null;
  }[];
}
function requireNoDesktop() {
  assert(
    !processes().some((item) => item.Name.toLowerCase() === 'rivloom.exe'),
    'Close every Rivloom desktop before running an installer',
  );
}
function install(path: string) {
  requireNoDesktop();
  // /D must be last. /UPDATE avoids calling an old registered uninstaller; /NS skips shortcuts.
  execFileSync(path, ['/S', '/NS', '/UPDATE', '/D=' + installDirectory], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 120_000,
  });
  assert(
    existsSync(appExecutable) && existsSync(uninstaller),
    'NSIS did not install its application and uninstaller',
  );
}
async function stopDesktop() {
  if (desktop?.pid && isAlive(desktop.pid)) {
    desktop.kill();
    await until(async () => !isAlive(desktop!.pid!), Boolean, 'desktop exit', 15_000);
  }
  await until(
    async () => ownedPIDs.every((pid) => !isAlive(pid)),
    Boolean,
    'owned process tree cleanup',
    15_000,
  );
  desktop = null;
  ownedPIDs = [];
}
async function start(data: string, expectedVersion: string) {
  requireNoDesktop();
  const client = new ServiceClient(data);
  desktop = spawn(appExecutable, [], {
    windowsHide: true,
    env: { ...process.env, RIVLOOM_DATA_DIR: data },
    stdio: 'ignore',
  });
  const runtime = await until(
    async () => {
      assert.equal(desktop!.exitCode, null, 'Installed desktop exited during startup');
      return JSON.parse(readFileSync(join(data, 'desktop-runtime.json'), 'utf8'));
    },
    (item) => item.desktopPID === desktop!.pid,
    'installed desktop runtime',
    60_000,
  );
  assert.equal(runtime.version, expectedVersion);
  client.base = runtime.url;
  await until(
    () => client.call<{ engineReady: boolean }>('/health'),
    (health) => health.engineReady,
    'bundled official engine',
    75_000,
  );
  await client.authenticate();
  const state = await client.bootstrap();
  assert.equal(state.engine.version, '1.18.25');
  assert.deepEqual(
    state.engine.models.map((model) => model.id),
    ['fixture/m34'],
  );
  const installedProcesses = processes().filter((item) =>
    item.ExecutablePath?.toLowerCase().startsWith(installDirectory.toLowerCase() + '\\'),
  );
  assert(
    installedProcesses.some((item) => item.ExecutablePath?.endsWith('opencode.exe')),
    'Official engine was not launched from the installed runtime',
  );
  ownedPIDs = installedProcesses.map((item) => item.ProcessId);
  assert(ownedPIDs.includes(runtime.backendPID));
  return client;
}
async function uninstall() {
  await stopDesktop();
  requireNoDesktop();
  // This is the exact uninstaller created by this test, never an original registry target.
  assert(relative(root, uninstaller) === join('app', 'uninstall.exe'));
  execFileSync(uninstaller, ['/S', '/UPDATE', '_?=' + installDirectory], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 120_000,
  });
  await until(
    async () =>
      !existsSync(appExecutable) && !existsSync(join(installDirectory, 'runtime', 'node.exe')),
    Boolean,
    'isolated uninstall',
  );
  assert(
    !existsSync(join(installDirectory, 'runtime', 'node.exe')),
    'Uninstall left the bundled executable',
  );
}
async function checkInstalledM34(client: ServiceClient) {
  assert.equal(
    JSON.parse(readFileSync(join(installDirectory, 'runtime', 'package.json'), 'utf8')).version,
    version,
  );
  for (const name of [
    'brain-topology.ts',
    'brain-tasks.ts',
    'worker-admission.ts',
    'worker-resources.ts',
  ])
    assert(
      existsSync(join(installDirectory, 'runtime', 'server', name)),
      `Missing M3.4 module: ${name}`,
    );
  const index = await fetch(client.base).then((response) => response.text());
  const asset = index.match(/src="([^"]+\.js)"/)?.[1];
  assert(asset, 'Installed UI asset missing');
  const ui = await fetch(new URL(asset, client.base)).then((response) => response.text());
  assert(
    ui.includes('Task 与 Execution 已分离') && ui.includes('自动选择 Brain 与 Worker'),
    'Installed UI is not the new M3.4 build',
  );
  const network = await client.network();
  assert(
    network.brains?.length && Array.isArray(network.brainTasks),
    'Installed API is not the M3.4 topology API',
  );
}

try {
  for (const data of [freshData, dataDirectory]) fixture.configure(data);
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(join(projectDirectory, 'KEEP.txt'), 'installer upgrade test marker\n', {
    flag: 'wx',
  });

  install(installer);
  const fresh = await start(freshData, version);
  await checkInstalledM34(fresh);
  pass(`Fresh ${version} NSIS install starts its bundled official engine and serves M3.4 UI/API`);
  await uninstall();
  assert(existsSync(join(freshData, 'rivloom.sqlite')));
  pass(
    'Fresh uninstall removes installed binaries, cleans owned processes and preserves separate data',
  );

  install(baseline);
  const old = await start(dataDirectory, '0.1.0');
  const before = await old.bootstrap();
  const project = await old.call(
    '/projects',
    { name: 'M3.4 upgrade ordinary folder', directory: projectDirectory, trusted: true },
    201,
  );
  const userID = before.user.id;
  const task = await old.call<Task>(
    '/tasks',
    {
      projectID: project.id,
      title: 'Preserve across installer upgrade',
      description: 'Do not run this task.',
      criteria: 'Keep the original task, folder and identity after upgrade.',
      assigneeID: userID,
      approverID: userID,
      reviewerID: userID,
      model: 'fixture/m34',
      approvalMode: 'ask',
    },
    201,
  );
  await old.call(`/tasks/${task.id}/claim`, {});
  await old.call('/network/execution-policy', {
    enabled: true,
    projectID: project.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  });
  const oldNetwork = await old.network();
  const nodeID = oldNetwork.local!.id;
  const brainID = oldNetwork.local!.brains[0].id;
  pass(
    'Real 0.1.0 baseline creates an ordinary Project, unexecuted Task and local execution policy',
  );
  await stopDesktop();

  install(installer);
  const upgraded = await start(dataDirectory, version);
  await checkInstalledM34(upgraded);
  const after = await upgraded.bootstrap();
  const afterNetwork = await upgraded.network();
  assert.equal(after.user.id, userID);
  assert.equal(afterNetwork.local!.id, nodeID);
  assert(
    afterNetwork.brains.some(
      (brain) => brain.id === brainID && brain.hosted && brain.state === 'established',
    ),
  );
  assert.deepEqual(
    after.projects.find((item) => item.id === project.id),
    project,
  );
  const preserved = after.tasks.find((item) => item.id === task.id)!;
  assert(preserved && preserved.state === 'ready' && preserved.sessionID === null);
  assert.equal(preserved.title, task.title);
  assert.equal(after.executionPolicy.projectID, project.id);
  assert.equal(after.executionPolicy.model, 'fixture/m34');
  assert.equal(after.executionPolicy.enabled, true);
  assert.equal(after.executionPolicy.approvalMode, 'ask');
  assert.equal(
    readFileSync(join(projectDirectory, 'KEEP.txt'), 'utf8'),
    'installer upgrade test marker\n',
  );
  assert(!existsSync(join(projectDirectory, '.git')));
  pass(
    `0.1.0 → ${version} overwrite upgrade preserves Node/Brain/user IDs, Project, Task and execution policy`,
  );
  proof.nodeID = nodeID;
  proof.brainID = brainID;
  proof.taskID = task.id;
  await stopDesktop();

  const restarted = await start(dataDirectory, version);
  assert.equal((await restarted.network()).local!.id, nodeID);
  assert(
    (await restarted.bootstrap()).tasks.some(
      (item) => item.id === task.id && item.state === 'ready',
    ),
  );
  pass('Upgraded installed desktop restarts with the same identity and unexecuted Task');
  await uninstall();
  assert(existsSync(join(dataDirectory, 'rivloom.sqlite')));
  assert(existsSync(join(dataDirectory, 'node-identity.json')));
  assert(existsSync(join(dataDirectory, 'brain-topology.json')));
  assert.equal(
    readFileSync(join(projectDirectory, 'KEEP.txt'), 'utf8'),
    'installer upgrade test marker\n',
  );
  pass(
    'Upgraded uninstall removes installed binaries while retaining task data, identity and ordinary Project',
  );
  assert.equal(fixture.requests, 0);
  pass(
    'No model calls, imported credentials, Git initialization, Project snapshots or content hashes',
  );
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.error = String(error);
  throw error;
} finally {
  await stopDesktop();
  await fixture.close();
  mkdirSync(resolve('.data', 'verification'), { recursive: true });
  writeFileSync(proofFile, JSON.stringify(proof, null, 2));
  console.log('Installer report:', proofFile);
}
