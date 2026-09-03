// Attach only to the already verified physical Master A. Never launch/stop a desktop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ServiceClient } from './m34-fixtures.ts';
import { RaceController } from './m34-race.ts';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 2, 'No arbitrary target arguments');
assert.equal(read(join(dirname(process.execPath), 'package.json')).name, 'rivloom-desktop-runtime');
assert.equal(read(join(dirname(process.execPath), 'package.json')).version, '0.1.3');
const client = new ServiceClient(
  join(process.env.LOCALAPPDATA!, 'com.rivloom.desktop', 'workspace'),
);
const desktop = read(join(client.root, 'desktop-runtime.json'));
assert.equal(desktop.version, '0.1.3');
const url = new URL(desktop.url);
assert.equal(url.protocol, 'http:');
assert.equal(url.hostname, '127.0.0.1');
assert(Number(url.port) >= 49152 && Number(url.port) <= 65535);
client.base = desktop.url;
await client.authenticate();
const network = await client.network();
const nodeID = 'tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7';
const brainID = '0ed79cba-4ed8-4373-ad3f-1dfc4a695800';
assert.equal(network.local?.id, nodeID);
assert.equal(network.brains.find((b) => b.hosted)?.id, brainID);
const race = new RaceController({
  client,
  role: 'A',
  nodeID,
  brainID,
  workerID: 't9MUCFG44Q3nM4txwjG3UPI7mbwePMsM',
  ledgerDirectory: resolve('.data', 'verification', 'physical-races-master-a'),
});
const input = createInterface({ input: process.stdin, terminal: false });
console.log(`RACE_LOCAL_READY Node=${nodeID} Brain=${brainID}; no task submitted`);
console.log('prepare <UUID> | race-status | race-cancel <UUID> | race-accept <UUID> | stop');
try {
  for await (const line of input) {
    if (line.trim() === 'stop') break;
    try {
      assert(await race.command(line), 'Unknown race command');
    } catch (error) {
      console.error('COMMAND FAILED:', String(error));
    }
  }
} finally {
  input.close();
  await race.close();
  console.log('RACE_LOCAL_STOPPED; existing desktop and test history retained');
}
