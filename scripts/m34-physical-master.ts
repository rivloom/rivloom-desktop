// Explicit, isolated physical-test helper. Never controls an installed desktop.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { NodeNetwork } from '../shared/types.ts';
import { ServiceClient, modelFixture, until } from './m34-fixtures.ts';
import { RaceController } from './m34-race.ts';

const workerID = 't9MUCFG44Q3nM4txwjG3UPI7mbwePMsM';
const runtime = dirname(process.execPath);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
assert.equal(process.platform, 'win32');
assert.equal(read(join(runtime, 'package.json')).name, 'rivloom-desktop-runtime');
assert.equal(read(join(runtime, 'package.json')).version, '0.1.3', 'Install Rivloom 0.1.3 first');
assert.equal(
  process.argv.length,
  2,
  'This helper does not accept arbitrary data-directory arguments',
);
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.data', 'independent-master');
mkdirSync(base, { recursive: true });
const noLink = (path: string) =>
  assert.equal(
    realpathSync(path).toLowerCase(),
    path.toLowerCase(),
    'Do not use linked test paths',
  );
noLink(base);
const manifestPath = join(base, 'active.json');
if (existsSync(manifestPath)) noLink(manifestPath);
type Manifest = {
  version: 1;
  runID: string;
  nodeID: string | null;
  brainID: string | null;
  formed: boolean;
};
const manifest: Manifest = existsSync(manifestPath)
  ? read(manifestPath)
  : { version: 1, runID: randomUUID(), nodeID: null, brainID: null, formed: false };
assert.equal(manifest.version, 1);
assert.match(
  manifest.runID,
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
);
const root = join(base, manifest.runID);
if (manifest.formed) {
  assert(existsSync(root), 'Original test data is missing; do not create a replacement');
  assert.match(manifest.nodeID!, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    read(join(root, 'node-identity.json')).nodeID,
    manifest.nodeID,
    'Test identity changed',
  );
} else mkdirSync(root, { recursive: true });
noLink(root);
assert(
  !existsSync(join(root, 'app.lock')),
  'This helper is already running; use its existing window',
);
const configPath = join(root, 'engine', 'config', 'opencode', 'opencode.json');
if (existsSync(configPath)) {
  noLink(configPath);
  const config = read(configPath);
  assert.deepEqual(config.enabled_providers, ['fixture']);
  assert.deepEqual(Object.keys(config.provider), ['fixture']);
  assert.equal(config.provider.fixture.options.apiKey, 'local-test-only');
}
const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
saveManifest();
const client = new ServiceClient(root);
const fixture = await modelFixture();
let input: ReturnType<typeof createInterface> | null = null;
let online = false;
let race: RaceController | null = null;
const closeRace = () => race?.close();
const taskTitle = `M3.4 physical Brain B ${manifest.runID.slice(0, 8)}`;

async function isolatedPort() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const socket = createSocket('udp4');
    const port = randomInt(49152, 65536);
    try {
      await new Promise<void>((ok, fail) => {
        socket.once('error', fail);
        socket.bind(port, '0.0.0.0', () => ok());
      });
      return port;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code || ''))
        throw error;
    } finally {
      socket.close();
    }
  }
  throw new Error('No isolated discovery port available');
}
function owned(network: NodeNetwork) {
  return network.brainTasks.filter((task) => task.masterNodeID === manifest.nodeID);
}
async function startJoined() {
  assert(!online, 'Already online');
  await client.start({ runtimeDirectory: runtime, discovery: { port: 43531, mdns: true } });
  online = true;
  const network = await client.network();
  assert.equal(network.local?.id, manifest.nodeID);
  assert(
    network.brains.some(
      (brain) => brain.hosted && brain.id === manifest.brainID && brain.state === 'established',
    ),
  );
  const state = await client.bootstrap();
  assert.equal(state.executionPolicy.enabled, false, 'This Master helper must not execute locally');
  assert.equal(state.tasks.length, 0);
  assert.equal(fixture.requests, 0);
  race ||= new RaceController({
    client,
    role: 'B',
    nodeID: manifest.nodeID!,
    brainID: manifest.brainID!,
    workerID,
    ledgerDirectory: join(root, 'physical-races'),
  });
  assert(
    owned(network).every(
      (task) => task.brainID === manifest.brainID && (task.title === taskTitle || race!.owns(task)),
    ),
  );
  const ports = [
    Number(new URL(client.base).port),
    network.local!.port,
    Number(client.output.match(/RIVLOOM_ENGINE_READY http:\/\/127\.0\.0\.1:(\d+)/)?.[1]),
  ];
  assert(ports.every((port) => Number.isInteger(port) && port >= 49152 && port <= 65535));
}
async function status() {
  const network = online ? await client.network() : null;
  const value = {
    at: new Date().toISOString(),
    version: '0.1.3',
    raceHelperVersion: 2,
    online,
    root,
    helperPID: process.pid,
    servicePID: client.child?.pid,
    nodeID: manifest.nodeID,
    brainID: manifest.brainID,
    apiURL: online ? client.base : null,
    peerPort: network?.local?.port,
    raceWorkerGate: network?.brains
      .find((b) => b.hosted)
      ?.workers.filter((w) => w.nodeID === workerID)
      .map((w) => ({ accepting: w.accepting, ...w.load })),
    worker: network?.nearby
      .filter((peer) => peer.id === workerID)
      .map((peer) => ({
        id: peer.id,
        online: peer.online,
        trusted: peer.trusted,
        channelReady: peer.channelReady,
      })),
    tasks: network
      ? owned(network).map((task) => ({
          id: task.id,
          brainID: task.brainID,
          status: task.status,
          workerNodeID: task.selectedWorkerID,
          executionID: task.executionID,
          executionSequence: task.executionSequence,
        }))
      : [],
    localModelRequests: fixture.requests,
  };
  writeFileSync(join(base, 'status.json'), JSON.stringify(value, null, 2));
  console.log('STATUS', JSON.stringify(value));
}
try {
  fixture.configure(root);
  if (!manifest.formed) {
    console.log('FORMING: independent test network; please wait. No identity is pre-created.');
    await client.start({
      runtimeDirectory: runtime,
      discovery: { port: await isolatedPort(), mdns: false },
    });
    const first = await client.network();
    const provisional = first.brains.find((brain) => brain.hosted);
    assert.equal(provisional?.state, 'provisional', 'Fresh helper should start provisional');
    const settled = await until(
      () => client.network(),
      (network) => network.brains.some((brain) => brain.hosted && brain.state === 'established'),
      'automatic independent Brain formation',
    );
    assert.equal(
      settled.nearby.length,
      0,
      'Independent formation must not reuse existing neighbors',
    );
    manifest.nodeID = settled.local!.id;
    manifest.brainID = settled.brains.find((brain) => brain.hosted)!.id;
    manifest.formed = true;
    saveManifest();
    await client.stop();
  }
  await startJoined();
  console.log(`READY Node=${manifest.nodeID} Brain=${manifest.brainID}`);
  console.log('Commands: status | pair | submit | accept | offline | online | stop');
  console.log(
    'Race helper v2: prepare <UUID> | race-status | race-cancel <UUID> | race-accept <UUID>',
  );
  console.log(
    'prepare records intent only; wait for the coordinator to enable the test Worker. No UTC deadline.',
  );
  console.log(
    'Do not pair or submit until the test coordinator asks. Keep the original Rivloom window open.',
  );
  await status();
  // Do not consume piped commands during asynchronous startup before the iterator exists.
  input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    const command = line.trim();
    if (command === 'stop') break;
    try {
      if (command === 'status') {
        await status();
        continue;
      }
      if (command === 'offline') {
        assert(online);
        race!.assertIdle();
        await client.stop();
        online = false;
        await status();
        continue;
      }
      if (command === 'online') {
        await startJoined();
        await status();
        continue;
      }
      assert(online, 'Use online first');
      if (await race!.command(command)) continue;
      if (command === 'pair') {
        const network = await client.network();
        const worker = network.nearby.find((peer) => peer.id === workerID && peer.online);
        assert(worker, 'Original Worker is not discovered yet');
        assert(!worker.trusted, 'Already trusted; do not re-pair');
        assert.equal(network.pairings.length, 0, 'A pairing is already pending');
        const response = await client.call<NodeNetwork>(
          '/network/pairings',
          { nodeID: workerID },
          201,
        );
        const pairing = response.pairings.find((item) => item.nodeID === workerID)!;
        assert(pairing);
        console.log(`PAIRING Worker=${workerID} Code=${pairing.code}`);
        await client.call(`/network/pairings/${pairing.id}/confirm`, {});
        console.log(
          'This helper confirmed. Compare the code with the coordinator before the Worker confirms.',
        );
      } else if (command === 'submit') {
        const network = await client.network();
        assert(
          network.nearby.some((peer) => peer.id === workerID && peer.trusted && peer.channelReady),
          'Pair the original Worker first',
        );
        assert.equal(
          network.nearby.filter((peer) => peer.trusted).length,
          1,
          'Only the Worker should be paired for this test',
        );
        const existing = owned(network).filter((task) => task.title === taskTitle);
        assert(owned(network).every((task) => task.title === taskTitle || race!.owns(task)));
        if (!existing.length)
          await client.call(
            '/network/tasks',
            {
              title: taskTitle,
              description: 'Reply briefly. Do not call tools or modify files.',
              criteria: 'Only a short text result; no tools or file changes.',
              requestedProjectID: null,
              requirements: {},
              confirmed: true,
            },
            201,
          );
        else console.log('Existing test Task retained; not submitting a duplicate.');
      } else if (command === 'accept') {
        const tasks = owned(await client.network()).filter((task) => task.title === taskTitle);
        assert.equal(tasks.length, 1, "Expected this helper's one test Task");
        const task = tasks[0];
        assert.equal(task.title, taskTitle);
        assert.equal(task.status, 'review', 'Only accept the reviewed fixture result');
        await client.call(`/network/tasks/${task.executionID}/control`, {
          expectedExecutionSequence: task.executionSequence,
          action: {
            kind: 'accept',
            note: 'Accept only the isolated physical Brain B deterministic text test.',
          },
          confirmed: true,
        });
      } else throw new Error('Use status, pair, submit, accept, offline, online or stop');
      await status();
    } catch (error) {
      console.error('COMMAND FAILED:', String(error));
    }
  }
} finally {
  input?.close();
  await closeRace();
  await client.stop();
  online = false;
  await fixture.close();
  console.log(
    'CLEANUP',
    JSON.stringify({
      stopped: client.child?.exitCode !== null,
      root,
      nodeID: manifest.nodeID,
      brainID: manifest.brainID,
      localModelRequests: fixture.requests,
    }),
  );
}
