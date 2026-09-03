// Uses the unchanged official binary and isolated fixture data; never imports user model accounts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { listenHttp, probeHttpPort } from '../server/http-ports.ts';
import { modelFixture } from '../scripts/m34-fixtures.ts';

const base = resolve('.data', 'port-tests');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'engine-'));
process.env.RIVLOOM_DATA_DIR = root;
const fixture = await modelFixture();
fixture.configure(root);
const { startEngine, engineBinary, engineEnv } = await import('../server/engine.ts');
after(async () => {
  assert.equal(fixture.requests, 0);
  await fixture.close();
});

test(
  'official OpenCode generic ServeError is paired with a real OS bind-conflict check',
  { timeout: 20000 },
  async () => {
    const blocker = createServer();
    const port = await listenHttp(blocker, '127.0.0.1');
    const child = spawn(
      process.execPath,
      [
        resolve('server/engine-host.mjs'),
        engineBinary(),
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: root,
        env: engineEnv('local-port-regression-only'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output = (output + chunk).slice(-6000);
    });
    child.stderr!.on('data', (chunk) => {
      output = (output + chunk).slice(-6000);
    });
    const exited = new Promise<number | null>((ok, fail) => {
      child.once('exit', ok);
      child.once('error', fail);
    });
    const timeout = setTimeout(() => {
      if (child.connected) child.disconnect();
    }, 10000);
    try {
      const code = await exited;
      assert.notEqual(code, 0);
      assert(output.includes('ServeError'), output);
      await assert.rejects(probeHttpPort(port), { code: 'EADDRINUSE' });
    } finally {
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      await new Promise<void>((ok) => blocker.close(() => ok()));
    }
  },
);

test(
  'Rivloom wrapper rejects bad/busy ports and starts official engine on a high authenticated port',
  { timeout: 30000 },
  async () => {
    await assert.rejects(startEngine(root, 1719), /浏览器禁止/);
    const blocker = createServer();
    const port = await listenHttp(blocker, '127.0.0.1');
    try {
      await assert.rejects(startEngine(root, port), { code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((ok) => blocker.close(() => ok()));
    }
    const engine = await startEngine(root);
    const exited = new Promise<void>((ok) => engine.child.once('exit', () => ok()));
    try {
      const selected = Number(new URL(engine.url).port);
      assert(selected >= 49152 && selected <= 65535);
      assert.equal((await engine.client.global.health()).data?.version, '1.18.25');
      assert.equal((await fetch(`${engine.url}/global/health`)).status, 401);
    } finally {
      engine.close();
      await exited;
    }
  },
);
