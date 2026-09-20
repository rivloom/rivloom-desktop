// Run only on a native Linux runner, against the extracted deliverable, without model credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, linuxArch, linuxEngineEvidence, verifyElf, LINUX_NODE_VERSION } from './linux-build.ts';
import { engineSourceFile, verifyPreparedEngine } from '../server/engine-artifact.ts';

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before orderly shutdown');
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const result = await Promise.race([ended, delay(25_000, null, { ref: false })]);
  if (!result) { child.kill('SIGKILL'); throw new Error('Server did not stop on SIGTERM'); }
  assert.equal(result.code, 0, 'Server shutdown failed');
}
async function run(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`CLI exited ${code}: ${error.slice(-2000)}`)); });
  });
}
export async function smokeLinux(root: string) {
  assert.equal(process.platform, 'linux');
  const arch = linuxArch(process.arch);
  const output = join(root, 'test-results/linux', arch);
  const build = JSON.parse(await readFile(join(output, 'build.json'), 'utf8'));
  assert.deepEqual(build.target, { platform: 'linux', arch });
  assert.equal(build.nodeVersion, LINUX_NODE_VERSION);
  const archive = join(output, build.artifact.fileName);
  const bytes = await readFile(archive);
  assert.equal(hash(bytes), build.artifact.sha256);
  assert.equal(bytes.length, build.artifact.bytes);
  const sandbox = await mkdtemp(join(output, 'smoke-'));
  execFileSync('tar', ['-xzf', archive, '-C', sandbox]);
  const home = join(sandbox, 'home'), data = join(sandbox, 'data'), extracted = join(sandbox, 'rivloom');
  await mkdir(home);
  const runtime = JSON.parse(await readFile(join(extracted, 'runtime-manifest.json'), 'utf8'));
  assert.equal(hash(await readFile(join(extracted, 'runtime-manifest.json'))), build.runtimeManifestSha256);
  assert.equal(runtime.schemaVersion, 1); assert.equal(runtime.kind, 'rivloom-headless-runtime');
  assert.equal(runtime.version, build.version); assert.equal(runtime.sourceCommit, build.sourceCommit);
  assert.equal(runtime.sourceDirty, build.sourceDirty); assert.deepEqual(runtime.target, build.target);
  const found: string[] = [];
  async function walk(directory: string, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Extracted package contains a link');
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative + '/');
      else { assert(entry.isFile()); found.push(relative); }
    }
  }
  await walk(extracted);
  assert.deepEqual(found.filter((path) => path !== 'runtime-manifest.json').sort(), runtime.files.map((file: any) => file.path).sort());
  for (const file of runtime.files) {
    assert(!file.path.split('/').includes('..') && !file.path.startsWith('/'));
    const bytes = await readFile(join(extracted, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
  }
  const app = join(extracted, 'app');
  assert.deepEqual(await readFile(join(app, engineSourceFile('linux-x64'))), await readFile(join(root, engineSourceFile('linux-x64'))), 'Packaged Linux engine source lock differs');
  const engine = verifyPreparedEngine(app, 'linux-x64');
  const engineSource = await linuxEngineEvidence(app, engine);
  assert.deepEqual(runtime.engineSource, engineSource);
  assert.deepEqual(build.engineSource, engineSource);
  const opencode = { version: engine.source.version, sha256: engine.binarySHA256, source: `${engine.source.repository}#${engine.source.commit}` };
  assert.deepEqual(runtime.opencode, opencode); assert.deepEqual(build.opencode, opencode);
  assert.equal(build.engineVersion, engine.source.version);
  const enginePath = join(engine.directory, 'opencode');
  verifyElf(await readFile(enginePath), arch);
  verifyElf(await readFile(join(extracted, 'runtime/node')), arch);
  assert.equal(hash(await readFile(join(extracted, 'runtime/node'))), runtime.node.sha256);
  for (const name of ['@opencode-ai/sdk', '@opencode-ai/plugin']) assert.equal(JSON.parse(await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8')).version, engine.source.packageVersion);
  assert(!runtime.packages.some((item: { path: string }) => item.path.split('/').some(part => part.startsWith('opencode-'))), 'Published engine binaries must not be bundled');
  const launcher = join(extracted, 'bin/rivloom');
  const environment = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', CI: 'true', RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
  assert.equal((await run(join(extracted, 'runtime/node'), ['--version'], environment)).trim(), `v${LINUX_NODE_VERSION}`);
  assert.equal((await run(enginePath, ['--version'], environment)).trim(), engine.source.version);
  await run(launcher, ['--version'], environment);
  await run(launcher, ['--data-dir', data, 'init', '--name', `CI-linux-${arch}`, '--json'], environment);
  let serviceOutput = '';
  const start = () => {
    const child = spawn(launcher, ['--data-dir', data, 'serve'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => { serviceOutput = (serviceOutput + chunk.toString()).slice(-16_384); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    return child;
  };
  async function ready(child: ChildProcess) {
    for (let count = 0; count < 60; count++) {
      assert.equal(child.exitCode, null, 'Headless service exited during startup');
      try {
        const control = JSON.parse(await readFile(join(data, 'headless-control.json'), 'utf8'));
        const response = await fetch(`${control.url}/api/health`, { signal: AbortSignal.timeout(1500) });
        const health = await response.json() as { ok: boolean; engineReady: boolean };
        if (response.ok && health.ok && health.engineReady) return JSON.parse(await run(launcher, ['--data-dir', data, 'status', '--json'], environment));
      } catch { /* Readiness polling; final timeout fails the build. */ }
      await delay(500);
    }
    throw new Error(`Headless service did not become ready: ${serviceOutput}`);
  }
  let child = start();
  let first: any, second: any;
  try {
    first = await ready(child);
    const path = join(data, 'headless-control.json');
    assert.equal((await stat(path)).mode & 0o077, 0, 'Control token must be private');
    const control = JSON.parse(await readFile(path, 'utf8'));
    const request = (path: string, headers: Record<string, string> = {}, post = false) => fetch(`${control.url}${path}`, { method: post ? 'POST' : 'GET', headers: { 'x-rivloom-request': '1', 'content-type': 'application/json', ...headers }, ...(post ? { body: '{}' } : {}), signal: AbortSignal.timeout(5000) });
    const missing = await request('/api/auth/headless', {}, true); assert.equal(missing.status, 403); await missing.arrayBuffer();
    const origin = await request('/api/auth/headless', { 'x-rivloom-headless-token': control.token, origin: 'https://untrusted.example' }, true); assert.equal(origin.status, 403); await origin.arrayBuffer();
    // Fetch normalizes Host from its URL. Use the raw HTTP client so the server
    // really receives the hostile Host header this assertion is meant to test.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const raw = httpRequest(`${control.url}/api/health`, { headers: { host: 'untrusted.example' }, timeout: 5000 }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode || 0)); });
      raw.on('error', reject); raw.on('timeout', () => raw.destroy(new Error('Host rejection check timed out'))); raw.end();
    });
    assert.equal(hostStatus, 403);
    const login = await request('/api/auth/headless', { 'x-rivloom-headless-token': control.token }, true); assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('rivloom_session=')); assert(cookie); await login.arrayBuffer();
    const noGui = await request('/', { cookie }); assert.equal(noGui.status, 404); await noGui.arrayBuffer();
    assert.equal(first.executionPolicy.enabled, false, 'A new headless node must not automatically enable execution');
    await stop(child);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    child = start(); second = await ready(child); await stop(child);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await writeFile(join(sandbox, 'service.log'), serviceOutput); }
  assert.equal(second.node.id, first.node.id, 'Restart changed node identity');
  assert.equal((await stat(data)).mode & 0o077, 0, 'Private data directory permissions are too broad');
  const report = { schemaVersion: 1, status: 'passed', sourceCommit: build.sourceCommit, sourceDirty: build.sourceDirty, runID: build.runID, arch, artifact: build.artifact, runtimeManifestSha256: build.runtimeManifestSha256, engineVersion: engine.source.version, opencode, engineSource, checks: { extractedFiles: runtime.files.length, node: true, opencode: true, engineSource: true, engineRecipe: true, engineElf: true, engineLicense: true, startup: true, restartIdentity: true, sigterm: true, privateData: true, authentication: true, noTokenRejected: true, originRejected: true, hostRejected: true, noGui: true, defaultExecutionDisabled: true, controlCleanup: true }, environment: { platform: process.platform, arch: process.arch, node: process.versions.node, image: process.env.ImageOS || 'local', imageVersion: process.env.ImageVersion || 'local' }, scope: 'Extracted headless package, source-built engine ELF/hash/receipt/recipe/license verification, isolated startup/restart/shutdown, authentication and persistent identity; no model calls, systemd enablement, physical LAN or cross-version task acceptance.' };
  await writeFile(join(output, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Linux ${arch} extracted-package smoke passed.`);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await smokeLinux(resolve(import.meta.dirname, '..'));
