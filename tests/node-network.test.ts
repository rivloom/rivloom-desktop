import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { loadNodeIdentity } from '../server/node-identity.ts';
import {
  discoveryProbeAddresses,
  NodeNetwork,
  privateNetworkAddress,
} from '../server/node-network.ts';

test('node network only accepts local and private source addresses', () => {
  assert(privateNetworkAddress('127.0.0.1'));
  assert(privateNetworkAddress('::1'));
  assert(privateNetworkAddress('::ffff:192.168.1.7'));
  assert(privateNetworkAddress('10.1.2.3'));
  assert(privateNetworkAddress('172.31.2.3'));
  assert(!privateNetworkAddress('172.32.2.3'));
  assert(!privateNetworkAddress('8.8.8.8'));
  assert(!privateNetworkAddress('example.com'));
  assert.deepEqual(
    discoveryProbeAddresses({
      referer: { address: '192.168.1.7' },
      addresses: ['192.168.1.99'],
    }),
    ['192.168.1.7'],
  );
  assert.deepEqual(
    discoveryProbeAddresses({
      referer: { address: '8.8.8.8' },
      addresses: ['192.168.1.99'],
    }),
    [],
  );
});

test(
  'node identity is stable and the private key is protected with Windows DPAPI',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'rivloom-identity-test-'));
    try {
      const first = loadNodeIdentity(root);
      const second = loadNodeIdentity(root);
      const stored = readFileSync(join(root, 'node-identity.json'), 'utf8');
      assert.equal(first.nodeID, second.nodeID);
      assert.equal(first.brainID, second.brainID);
      assert.equal(first.sign('same-value'), second.sign('same-value'));
      assert(stored.includes('windows-dpapi-current-user'));
      assert(!stored.includes('PRIVATE KEY'));
      assert(!stored.includes('same-value'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'two isolated Rivloom instances discover and cryptographically verify each other',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async () => {
    const roots = [
      mkdtempSync(join(tmpdir(), 'rivloom-network-a-')),
      mkdtempSync(join(tmpdir(), 'rivloom-network-b-')),
    ];
    const networks = roots.map((root) => new NodeNetwork(root, true));
    try {
      await Promise.all(networks.map((network) => network.start()));
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        networks.some((network) => network.snapshot().nearby.length !== 1)
      )
        await wait(250);
      const snapshots = networks.map((network) => network.snapshot());
      assert(snapshots.every((snapshot) => snapshot.status === 'online'));
      assert(snapshots.every((snapshot) => snapshot.local?.verified));
      assert(snapshots.every((snapshot) => snapshot.nearby.length === 1));
      assert(snapshots.every((snapshot) => snapshot.nearby[0].verified));
      assert(snapshots.every((snapshot) => !snapshot.nearby[0].trusted));
      assert.equal(snapshots[0].nearby[0].id, snapshots[1].local?.id);
      assert.equal(snapshots[1].nearby[0].id, snapshots[0].local?.id);

      const port = snapshots[0].local!.port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/hello?nonce=bad`)).status, 400);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).status, 404);
    } finally {
      await Promise.all(networks.map((network) => network.stop()));
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
);
