// Uses the pinned platform engine and isolated fixture data; never imports user model accounts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const { startEngine, engineBinary, engineDatabasePath, engineEnv, ENGINE_VERSION } = await import('../server/engine.ts');
after(async () => {
  assert.equal(fixture.requests, 0);
  await fixture.close();
});

function databaseFixture(label: string, names: string[]) {
  const engineRoot = mkdtempSync(join(root, `${label}-`));
  const directory = join(engineRoot, 'data', 'opencode');
  mkdirSync(directory, { recursive: true });
  // Deliberately invalid SQLite bytes: these fixtures are only passed to the path
  // selector and environment builder, never opened by the actual engine.
  const files = names.flatMap((name) => ['', '-wal', '-shm'].map((suffix) => {
    const path = join(directory, name + suffix);
    const bytes = Buffer.from(`preserve ${label}/${name}${suffix}\0`, 'utf8');
    writeFileSync(path, bytes);
    return { path, bytes };
  }));
  return {
    root: engineRoot,
    directory,
    assertUnchanged() {
      for (const { path, bytes } of files) assert.deepEqual(readFileSync(path), bytes, path);
    },
  };
}

test('new and official-release engine roots select the legacy database without changing DB or WAL bytes', () => {
  const empty = databaseFixture('empty', []);
  assert.equal(engineDatabasePath(empty.root), join(empty.directory, 'opencode.db'));
  assert.equal(existsSync(join(empty.directory, 'opencode.db')), false);
  const legacy = databaseFixture('legacy', ['opencode.db']);
  assert.equal(engineDatabasePath(legacy.root), join(legacy.directory, 'opencode.db'));
  assert.equal(engineEnv('fixture-only', legacy.root).OPENCODE_DB, join(legacy.directory, 'opencode.db'));
  assert.equal(existsSync(join(legacy.directory, 'opencode-rivloom.db')), false);
  legacy.assertUnchanged();
});

test('a local fork-only database stays in place with its original WAL and SHM files', () => {
  const preview = databaseFixture('preview', ['opencode-rivloom.db']);
  assert.equal(engineDatabasePath(preview.root), join(preview.directory, 'opencode-rivloom.db'));
  assert.equal(engineEnv('fixture-only', preview.root).OPENCODE_DB, join(preview.directory, 'opencode-rivloom.db'));
  assert.equal(existsSync(join(preview.directory, 'opencode.db')), false);
  preview.assertUnchanged();
});

test('two existing engine databases fail explicitly and preserve both databases and their sidecars', () => {
  const conflict = databaseFixture('conflict', ['opencode.db', 'opencode-rivloom.db']);
  assert.throws(() => engineDatabasePath(conflict.root), /两份引擎会话数据库/);
  assert.throws(() => engineEnv('fixture-only', conflict.root), /两份引擎会话数据库/);
  conflict.assertUnchanged();
});

test('engine environments ignore inherited database overrides and isolate account database roots', () => {
  const accountA = databaseFixture('account-a', ['opencode.db']);
  const accountB = databaseFixture('account-b', ['opencode-rivloom.db']);
  const inherited = process.env.OPENCODE_DB;
  try {
    for (const override of [':memory:', join(root, 'unrelated.db')]) {
      process.env.OPENCODE_DB = override;
      const a = engineEnv('fixture-only', accountA.root).OPENCODE_DB;
      const b = engineEnv('fixture-only', accountB.root).OPENCODE_DB;
      assert.equal(a, join(accountA.directory, 'opencode.db'));
      assert.equal(b, join(accountB.directory, 'opencode-rivloom.db'));
      assert.notEqual(a, b);
      assert.equal(existsSync(join(root, 'unrelated.db')), false);
    }
    accountA.assertUnchanged();
    accountB.assertUnchanged();
  } finally {
    if (inherited === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = inherited;
  }
});

test(
  'pinned OpenCode generic ServeError is paired with a real OS bind-conflict check',
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

test('a fresh session uses the legacy database filename and survives an owned-engine restart', { timeout: 60000 }, async () => {
  const dataRoot = mkdtempSync(join(root, 'session-persistence-'));
  const directory = join(dataRoot, 'project');
  mkdirSync(directory, { recursive: true });
  fixture.configure(dataRoot);
  const engineRoot = join(dataRoot, 'engine');
  const databaseDirectory = join(engineRoot, 'data', 'opencode');
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
  const stop = async () => {
    if (!engine) return;
    const current = engine;
    engine = undefined;
    current.close();
    await current.waitForExit();
    assert.equal(current.child.exitCode, 0);
    await probeHttpPort(Number(new URL(current.url).port));
  };
  try {
    engine = await startEngine(directory, 0, engineRoot);
    const created = (await engine.client.session.create({ directory, title: 'Isolated database restart regression' })).data;
    assert(created?.id);
    assert.equal(existsSync(join(databaseDirectory, 'opencode.db')), true);
    assert.equal(existsSync(join(databaseDirectory, 'opencode-rivloom.db')), false);
    await stop();
    engine = await startEngine(directory, 0, engineRoot);
    const restored = (await engine.client.session.get({ directory, sessionID: created.id })).data;
    assert.equal(restored?.id, created.id);
    assert.equal(restored?.title, created.title);
    assert.equal(existsSync(join(databaseDirectory, 'opencode-rivloom.db')), false);
    assert.equal(fixture.requests, 0);
  } finally {
    await stop();
  }
});

test(
  'Rivloom wrapper rejects bad/busy ports and starts the pinned engine on a high authenticated port',
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
      assert.equal((await engine.client.global.health()).data?.version, ENGINE_VERSION);
      assert.equal((await fetch(`${engine.url}/global/health`)).status, 401);
    } finally {
      engine.close();
      await exited;
    }
  },
);
