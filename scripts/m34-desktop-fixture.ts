// Isolated Release UI fixture. Type "release" to answer the local model; "stop" cleans up.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { loadNodeIdentity } from '../server/node-identity.ts';
import { ServiceClient, modelFixture, pairServices, until } from './m34-fixtures.ts';

const root = resolve('.data', 'm34-desktop', String(Date.now()));
const [desktop, other, worker] = ['desktop', 'other-master', 'worker'].map(
  (name) => new ServiceClient(join(root, name)),
);
const fixture = await modelFixture();
let native: ReturnType<typeof spawn> | null = null;
try {
  for (const client of [desktop, other, worker]) fixture.configure(client.root);
  loadNodeIdentity(desktop.root);
  loadNodeIdentity(other.root);
  native = spawn(resolve('src-tauri/target/release/Rivloom.exe'), [], {
    windowsHide: true,
    env: { ...process.env, RIVLOOM_DATA_DIR: desktop.root },
    stdio: 'ignore',
  });
  const runtime = await until(
    async () => JSON.parse(readFileSync(join(desktop.root, 'desktop-runtime.json'), 'utf8')),
    (value) => value.desktopPID === native!.pid,
    'Release runtime',
  );
  desktop.base = runtime.url;
  await desktop.authenticate();
  await until(
    () => desktop.bootstrap(),
    (state) => state.engine.ready,
    'packaged official engine',
  );
  await Promise.all([other.start(), worker.start()]);
  const directory = join(worker.root, 'authorized-folder');
  mkdirSync(directory);
  const project = await worker.call(
    '/projects',
    { name: 'M3.4 Release 普通文件夹', directory, trusted: true },
    201,
  );
  await worker.call('/network/execution-policy', {
    enabled: true,
    projectID: project.id,
    model: 'fixture/m34',
    approvalMode: 'ask',
    confirmed: true,
  });
  await pairServices(desktop, worker);
  await pairServices(other, worker);
  await pairServices(desktop, other);
  const workerID = (await worker.network()).local!.id;
  await until(
    () => desktop.network(),
    (network) =>
      network.brains.length === 2 &&
      network.brains.every((brain) =>
        brain.workers.some((item) => item.nodeID === workerID && item.accepting),
      ),
    'Release shared topology',
  );
  for (let sample = 0; sample < 90; sample += 1) {
    await wait(1000);
    const network = await desktop.network();
    assert.equal(network.nearby.filter((node) => node.online && node.channelReady).length, 2);
    assert.equal(network.brains.length, 2);
    assert(
      network.brains.every(
        (brain) =>
          brain.online &&
          brain.workers.some(
            (item) => item.nodeID === workerID && item.accepting && item.load.availableSlots === 1,
          ),
      ),
    );
  }
  console.log('PASS Release full-mesh topology stable over 90 seconds');
  console.log(
    'READY',
    JSON.stringify({
      root,
      desktop: desktop.root,
      url: desktop.base,
      nativePID: native.pid,
      workerID,
    }),
  );
  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    if (line.trim() === 'release') {
      fixture.release();
      console.log('MODEL RELEASED');
    }
    if (line.trim() === 'status') {
      const network = await desktop.network();
      const state = {
        at: new Date().toISOString(),
        root,
        kind: 'Release WebView2 fixture state; UI actions verified separately by Windows automation',
        brainTasks: network.brainTasks,
        workerTasks: (await worker.bootstrap()).tasks.map((task) => ({
          id: task.id,
          sessionID: task.sessionID,
          state: task.state,
        })),
        modelRequests: fixture.requests,
      };
      mkdirSync(resolve('.data', 'verification'), { recursive: true });
      writeFileSync(
        resolve('.data', 'verification', 'm34-desktop.json'),
        JSON.stringify(state, null, 2),
      );
      console.log('STATUS', JSON.stringify(state));
    }
    if (line.trim() === 'stop') {
      input.close();
      break;
    }
  }
} finally {
  fixture.release();
  native?.kill(); // Only the process created by this fixture; backend exits via its owned stdin.
  await Promise.all([other.stop(), worker.stop()]);
  await fixture.close();
}
