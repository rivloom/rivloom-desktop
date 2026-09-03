import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  AUTO_HTTP_PORT_MIN,
  AUTO_HTTP_PORT_MAX,
  HTTP_PORT_ATTEMPTS,
  listenHttp,
  withHttpPort,
} from '../server/http-ports.ts';

const bindError = (code: string) => Object.assign(new Error(code), { code });
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));

test('automatic HTTP ports use only the high private range, including both boundaries', async () => {
  assert.equal(AUTO_HTTP_PORT_MIN, 49152);
  assert.equal(AUTO_HTTP_PORT_MAX, 65535);
  for (const port of [49152, 65535])
    assert.equal(
      await withHttpPort(
        async (value) => value,
        0,
        () => port,
      ),
      port,
    );
  for (let index = 0; index < 100; index++) {
    const port = await withHttpPort(async (value) => value);
    assert(port >= 49152 && port <= 65535);
  }
});

test('automatic selection rejects low or invalid candidates before binding', async () => {
  for (const port of [0, 1719, 4310, 49151, 65536, NaN, 50000.5]) {
    let called = false;
    await assert.rejects(
      withHttpPort(
        async () => {
          called = true;
        },
        0,
        () => port,
      ),
    );
    assert.equal(called, false);
  }
});

test('invalid and Fetch-blocked explicit ports are rejected without opening anything', async () => {
  for (const port of [-1, 65536, NaN, Infinity, 0.5, 1719, 1720, 1723, 2049, 5060, 6000, 10080]) {
    let called = false;
    await assert.rejects(
      withHttpPort(async () => {
        called = true;
      }, port),
    );
    assert.equal(called, false);
  }
});

test('safe explicit development ports are honored without random selection', async () => {
  assert.equal(
    await withHttpPort(
      async (port) => port,
      4310,
      () => {
        throw new Error('must not randomize');
      },
    ),
    4310,
  );
});

test('automatic bind retries address-in-use and access-denied only', async () => {
  let attempts = 0;
  const port = await withHttpPort(
    async (candidate) => {
      attempts++;
      if (attempts === 1) throw bindError('EADDRINUSE');
      if (attempts === 2) throw bindError('EACCES');
      return candidate;
    },
    0,
    () => 51000 + attempts,
  );
  assert.equal(attempts, 3);
  assert.equal(port, 51002);
});

test('automatic retries have a finite limit and retain the last bind cause', async () => {
  let attempts = 0;
  const failure = bindError('EACCES');
  await assert.rejects(
    withHttpPort(
      async () => {
        attempts++;
        throw failure;
      },
      0,
      () => 51000,
    ),
    (error: Error) => error.cause === failure,
  );
  assert.equal(attempts, HTTP_PORT_ATTEMPTS);
  assert.equal(HTTP_PORT_ATTEMPTS, 64);
});

test('fixed-port conflicts fail once without silently switching ports', async () => {
  let attempts = 0;
  const failure = bindError('EADDRINUSE');
  await assert.rejects(
    withHttpPort(async () => {
      attempts++;
      throw failure;
    }, 51000),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test('unexpected startup errors are not retried or hidden', async () => {
  let attempts = 0;
  const failure = bindError('EADDRNOTAVAIL');
  await assert.rejects(
    withHttpPort(async () => {
      attempts++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test('real HTTP listener is Fetch-accessible on a high port and releases temporary listeners', async () => {
  const server = createServer((_request, response) => response.end('high-port-ok'));
  const originalListening = server.listeners('listening');
  try {
    const port = await listenHttp(server, '127.0.0.1');
    assert(port >= 49152 && port <= 65535);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'high-port-ok');
    assert.equal(server.listenerCount('error'), 0);
    assert.deepEqual(server.listeners('listening'), originalListening);
  } finally {
    if (server.listening) await close(server);
  }
});

test('real occupied high port is retried on the same server and explicit conflict is not', async () => {
  const blocker = createServer();
  const probe = createServer();
  const server = createServer();
  const fixed = createServer();
  const originalListening = fixed.listeners('listening');
  try {
    const busyPort = await listenHttp(blocker, '127.0.0.1');
    const freePort = await listenHttp(probe, '127.0.0.1');
    await close(probe);
    let selection = 0;
    assert.equal(
      await listenHttp(server, '127.0.0.1', 0, () => (selection++ === 0 ? busyPort : freePort)),
      freePort,
    );
    assert.equal(selection, 2);
    await assert.rejects(listenHttp(fixed, '127.0.0.1', busyPort), { code: 'EADDRINUSE' });
    assert.equal(server.listenerCount('error'), 0);
    assert.equal(fixed.listenerCount('error'), 0);
    assert.deepEqual(fixed.listeners('listening'), originalListening);
    assert.equal(fixed.listening, false);
  } finally {
    for (const current of [blocker, probe, server, fixed])
      if (current.listening) await close(current);
  }
});
