// Local acceptance only. downloads: published manifest -> full downloads/runtime.
// website <evidence path>: match real deployed commands without repeating downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { release as kernel } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { source as expected } from './expected-release.mjs';
import { verifyPackage } from './verify-package.mjs';
// expected-release validates both immutable parsing files before they execute.
const { parseLinuxDownloadRecord, linuxChecksums } = await import('./public-source/linux-download-record.ts');

assert.equal(process.platform, 'linux', 'Run this acceptance in WSL/Linux.');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.19.0'); assert(Number.isSafeInteger(process.getuid()) && process.getuid() > 0, 'Use the actual non-root hosted consumer UID');
process.umask(0o077);
const evidenceRoot = fileURLToPath(new URL('./', import.meta.url));
const rootInfo = await lstat(evidenceRoot); assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink()); assert.equal(await realpath(evidenceRoot), resolve(evidenceRoot));
const phase = process.argv[2];
assert(['downloads', 'website'].includes(phase), 'Use downloads [wget-after-curl-low-speed prior-evidence-directory] or website <evidence-directory>.');
const wgetReplacement = phase === 'downloads' && process.argv[3] === 'wget-after-curl-low-speed';
const windowsReplacement = phase === 'downloads' && process.argv[3] === 'windows-public-get';
const windowsDirectory = windowsReplacement ? process.argv[4] : null;
if (windowsReplacement) assert.match(windowsDirectory || '', /^public-wsl-[A-Za-z0-9]+$/);
const priorCurlDirectory = wgetReplacement ? process.argv[4] : null;
if (wgetReplacement) assert.match(priorCurlDirectory || '', /^public-wsl-[A-Za-z0-9]+$/);
const evidence = phase === 'website' ? resolve(process.argv[3] || '') : windowsReplacement ? join(evidenceRoot, windowsDirectory) : await mkdtemp(join(evidenceRoot, 'public-wsl-'));
assert(evidence.startsWith(resolve(evidenceRoot) + '/public-wsl-') && !evidence.slice(resolve(evidenceRoot).length + 1).includes('/'));
const previous = phase === 'website' ? JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8')) : null;
if (previous) assert(previous.checks?.['retained-archive'] && previous.checks?.['restart-sigterm'], 'Complete download/runtime validation before website matching.');
const downloadTools = previous?.downloadTools || (windowsReplacement ? ['windows-fetch'] : wgetReplacement ? ['wget'] : ['curl', 'wget']);
assert(['curl,wget', 'wget', 'windows-fetch'].includes(downloadTools.join(',')));
const sandbox = previous?.sandbox || await mkdtemp('/var/tmp/rivloom-public-x64-');
assert.match(sandbox, /^\/var\/tmp\/rivloom-public-x64-[A-Za-z0-9]+$/);
assert.equal(await realpath('/var/tmp'), '/var/tmp'); assert.equal(await realpath(sandbox), sandbox);
const sandboxInfo = await lstat(sandbox); assert(sandboxInfo.isDirectory() && !sandboxInfo.isSymbolicLink());
assert.equal(sandboxInfo.uid, process.getuid()); assert.equal(sandboxInfo.mode & 0o077, 0);
const home = join(sandbox, 'home'), data = join(home, '.local/share/rivloom');
if (!previous) await mkdir(home);
const environment = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', CI: 'true', RIVLOOM_MDNS_NETWORK: 'disabled', RIVLOOM_DISCOVERY_FALLBACK: 'disabled' };
// Preserve configured network transport only for public download tools. The app
// itself retains the clean HOME/environment above with no credentials or proxies.
const downloadEnvironment = { ...environment, ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:https?_proxy|all_proxy|no_proxy)$/i.test(name))) };
// Verification imports, as well as launched app processes, receive only this
// task-owned HOME and no user credentials. Download tools retain transport above.
process.env = { ...environment };
const report = previous || { schemaVersion: 1, status: 'running', downloadMethod: windowsReplacement ? 'windows-public-full-get-wsl-native' : wgetReplacement ? 'wget-single-full-after-curl-low-speed' : 'curl-and-wget-independent-full', downloadTools,
  startedAt: new Date().toISOString(), evidence, sandbox, environment: { platform: process.platform, arch: process.arch, harnessNode: process.version, uid: process.getuid(), kernel: kernel(), environment: 'independent GitHub-hosted Ubuntu native consumer' }, checks: {},
  scope: wgetReplacement ? 'One fresh public wget full GET and isolated WSL lifecycle after an interrupted low-speed curl attempt; curl download did not pass. No model tasks, real projects, systemd install or physical LAN acceptance.' : 'Real public curl/wget downloads and isolated GitHub-hosted Ubuntu x64 package startup/restart/SIGTERM; no model configuration/tasks, real projects, systemd installation or physical LAN acceptance.' };
if (wgetReplacement) {
  const prior = JSON.parse(await readFile(join(evidenceRoot, priorCurlDirectory, 'report.json'), 'utf8'));
  const interruption = JSON.parse(await readFile(join(evidenceRoot, priorCurlDirectory, 'curl-low-speed-interruption.json'), 'utf8'));
  assert.equal(prior.status, 'failed'); assert.equal(prior.stage, 'curl-download-running'); assert.equal(prior.release.commit, expected.commit);
  assert.equal(interruption.sourceCommit, expected.commit); assert.equal(interruption.curlPassed, false); assert.equal(interruption.partialReusable, false);
  report.curlCoverage = { status: 'not-completed-low-speed-interrupted', passed: false, partialReused: false,
    observedSeconds: interruption.observedElapsedSeconds, observedBytes: interruption.observedBytes,
    interruptedPartialBytes: interruption.partialBytesBeforeSignal, previousReport: `${priorCurlDirectory}/report.json`,
    interruptionEvidence: `${priorCurlDirectory}/curl-low-speed-interruption.json` };
}
let windowsDownload;
if (windowsReplacement) {
  windowsDownload = JSON.parse(await readFile(join(evidence, 'windows-download.json'), 'utf8'));
  assert.equal(windowsDownload.status, 'public-get-complete-awaiting-wsl-native'); assert.equal(windowsDownload.sourceCommit, expected.commit);
  assert.equal(windowsDownload.sourceTree, expected.tree); assert.equal(windowsDownload.downloader.platform, 'win32');
  assert.equal(windowsDownload.downloader.anonymousPublicGet, true); assert.equal(windowsDownload.downloader.requests, 1);
  assert.equal(windowsDownload.downloader.retries, 0); assert.equal(windowsDownload.downloader.rangeRequested, false); assert.equal(windowsDownload.downloader.partialResumed, false);
  report.windowsDownloadEvidence = `${windowsDirectory}/windows-download.json`;
  report.scope = 'One independent Windows anonymous complete public GET followed by full package/source/hash and all WSL native lifecycle checks. WSL curl/wget downloads were interrupted for low speed; live CLI command syntax is verified separately. No real model tasks, projects, systemd install or user installation.';
  for (const [tool, selected] of [['curl', process.argv[5]], ['wget', process.argv[6]]]) {
    assert.match(selected || '', /^public-wsl-[A-Za-z0-9]+$/);
    const failed = JSON.parse(await readFile(join(evidenceRoot, selected, 'report.json'), 'utf8'));
    const interrupted = JSON.parse(await readFile(join(evidenceRoot, selected, `${tool}-low-speed-interruption.json`), 'utf8'));
    assert.equal(failed.status, 'failed'); assert.equal(failed.stage, `${tool}-download-running`); assert.equal(failed.release.commit, expected.commit);
    assert.equal(interrupted.sourceCommit, expected.commit); assert.equal(interrupted.partialReusable, false);
    report[`${tool}Coverage`] = { status: 'not-completed-low-speed-interrupted', passed: false, partialReused: false,
      observedSeconds: interrupted.observedElapsedSeconds, observedBytes: interrupted.observedBytes, interruptedPartialBytes: interrupted.partialBytesBeforeSignal,
      previousReport: `${selected}/report.json`, interruptionEvidence: `${selected}/${tool}-low-speed-interruption.json` };
  }
}
const save = (name, value) => writeFile(join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const checkpoint = async (stage, evidence) => { report.stage = stage; if (evidence !== undefined) report.checks[stage] = evidence; await save('report.json', report); console.log(`Public WSL acceptance: ${stage}`); };
async function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const { timeout = 360_000, progressFile, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: sandbox, env: environment, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let stdout = '', stderr = '';
    const started = Date.now();
    const timer = setTimeout(() => { if (spawnOptions.detached && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } else child.kill('SIGKILL'); }, timeout);
    const progress = progressFile ? setInterval(async () => { const bytes = await stat(progressFile).then(value => value.size).catch(() => 0); console.log(`Public WSL download progress: ${bytes} bytes after ${Math.floor((Date.now() - started) / 1000)}s`); }, 15_000) : null;
    const clear = () => { clearTimeout(timer); if (progress) clearInterval(progress); };
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_384); });
    child.once('error', error => { clear(); reject(error); });
    child.once('close', (code, signal) => { clear(); code === 0 ? done({ stdout, stderr, code }) : reject(new Error(`${command} failed (${code}/${signal}): ${stderr}`)); });
  });
}
async function sha(path) { const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex'); }
const textHash = value => createHash('sha256').update(value).digest('hex');
async function get(url) { const response = await fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60_000) }); assert.equal(response.status, 200, url); return response; }
const decode = value => value.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const websiteCommand = (item, tool) => `${tool === 'curl' ? `curl --fail --location --proto '=https' --tlsv1.2 --output '${item.fileName}' '${item.url}'` : `wget --https-only --output-document='${item.fileName}' '${item.url}'`} &&\nprintf '%s  %s\\n' '${item.sha256}' '${item.fileName}' | sha256sum --check --strict - &&\ntar -xzf '${item.fileName}'`;
let child, output = '';
async function stop() {
  assert(child && child.exitCode === null && child.signalCode === null, 'Service exited before SIGTERM.');
  const ended = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  assert(child.kill('SIGTERM'));
  const result = await Promise.race([ended, delay(30_000, null, { ref: false })]);
  assert(result, 'Service did not exit on SIGTERM.'); assert.equal(result.code, 0);
  await assert.rejects(readFile(join(data, 'headless-control.json')), { code: 'ENOENT' });
  return result;
}
try {
  assert.match(String(expected.runs.linux), /^[1-9]\d+$/);
  assert.match(String(expected.linuxArtifactID), /^[1-9]\d+$/);
  const record = parseLinuxDownloadRecord(await (await get('https://downloads.rivloom.com/releases/linux/latest.json')).json());
  assert.equal(record.source.commit, expected.commit); assert.equal(record.build.runID, String(expected.runs.linux)); assert.equal(record.version, expected.version);
  assert.deepEqual(Object.keys(record.platforms), ['linux-x64']);
  assert.equal(record.build.artifactIDs['linux-x64'], String(expected.linuxArtifactID));
  if (previous) {
    assert(['curl-and-wget-independent-full', 'wget-single-full-after-curl-low-speed', 'windows-public-full-get-wsl-native'].includes(previous.downloadMethod));
    assert.equal(previous.release.commit, expected.commit); assert.equal(previous.release.version, expected.version);
    assert.equal(previous.release.runID, String(expected.runs.linux)); assert.deepEqual(previous.release.artifact, record.platforms['linux-x64']);
    assert.equal(previous.checks['runtime-integrity']?.sourceCommit, expected.commit);
    assert.equal(previous.checks['restart-sigterm']?.identityPreserved, true);
    assert.equal(previous.checks['retained-archive']?.bytes, record.platforms['linux-x64'].bytes);
    assert.equal(previous.checks['retained-archive']?.sha256, record.platforms['linux-x64'].sha256);
    for (const tool of downloadTools) {
      const check = previous.checks[`${tool}-download`];
      assert.equal(check?.singleCommandCompleteDownload, true);
      assert.equal(check.bytes, record.platforms['linux-x64'].bytes); assert.equal(check.sha256, record.platforms['linux-x64'].sha256);
      assert.equal(check.checksum, 'passed'); assert.equal(check.extraction, 'passed');
      if (tool !== 'windows-fetch') assert.equal(check.commandSha256, textHash(websiteCommand(record.platforms['linux-x64'], tool)));
    }
  }
  await save('linux-download.json', record);
  const item = record.platforms['linux-x64'], sums = await (await get(record.checksum.url)).text();
  assert.equal(sums, linuxChecksums(record)); assert.equal(Buffer.byteLength(sums), record.checksum.bytes); assert.equal(textHash(sums), record.checksum.sha256);
  await save('SHA256SUMS.txt', sums);
  report.transport = { configuredProxyEnvironmentRetained: Object.keys(downloadEnvironment).some(name => /^(?:https?_proxy|all_proxy)$/i.test(name)), applicationProxyEnvironmentRetained: false };
  report.release = { commit: record.source.commit, runID: record.build.runID, version: record.version, tag: record.release.tag, artifact: item };
  await checkpoint('record');

  const selected = Object.fromEntries(['curl', 'wget'].map(tool => [tool, websiteCommand(item, tool)]));
  for (const tool of ['curl', 'wget']) await save(`manifest-${tool}.sh`, selected[tool] + '\n');
  if (phase === 'website') {
  const pages = [];
  for (const locale of ['zh', 'en']) {
  const pageURL = `https://rivloom.com${locale === 'en' ? '/en' : ''}/download/`, html = await (await get(pageURL)).text();
  assert(html.includes('data-linux-status="published"') && html.includes('data-linux-platform="linux-x64"'));
  assert(!html.includes('_linux_arm64.tar.gz'));
  const commands = [...html.matchAll(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g)].map(match => decode(match[1]));
  for (const tool of ['curl', 'wget']) { const expectedCommand = websiteCommand(item, tool); assert(commands.includes(expectedCommand), `Live ${locale} site does not yet contain the expected ${tool} command.`); selected[tool] = expectedCommand; const name = `website-${locale}-${tool}.sh`; await save(name, expectedCommand + '\n'); await run('/bin/sh', ['-n', join(evidence, name)]); }
  await save(`download-page-${locale}.html`, html);
  pages.push({ locale, pageURL, htmlSha256: textHash(html), exactCommandsMatched: ['curl', 'wget'], shellSyntax: 'passed' });
  }
  report.checks['manifest-commands'].websiteCommandMatch = 'passed against live Chinese and English production pages';
  await checkpoint('website-commands', { pages, redownloadPerformed: false });
  } else {
  await checkpoint('manifest-commands', { source: 'strict published Linux download record', websiteCommandMatch: 'pending website deployment; not yet verified' });
  const extractionTools = join(sandbox, 'extraction-tools'); await mkdir(extractionTools, { mode: 0o700 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const extractor = fileURLToPath(new URL('./safe-extract.mjs', import.meta.url));
  const fixedNode = '/var/tmp/rivloom-linux-20260918/tools/node-v24.19.0-linux-x64/bin/node';
  await writeFile(join(extractionTools, 'tar'), `#!/bin/sh\nexec ${quote(fixedNode)} ${quote(extractor)} ${quote(sandbox)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  downloadEnvironment.PATH = extractionTools + ':/usr/bin:/bin';

  // These recipes are generated from the strict published manifest, never executed
  // from unverified website text. Each downloads all bytes, verifies SHA, then extracts.
  // Both clients reuse this new sandbox's same archive/extraction, preserving old evidence.
  for (const tool of downloadTools) {
    await checkpoint(`${tool}-download-running`);
    if (tool === 'windows-fetch') {
      assert.deepEqual(windowsDownload.artifact, item); assert.equal(windowsDownload.bytes, item.bytes); assert.equal(windowsDownload.sha256, item.sha256);
      const retained = join(evidence, item.fileName); assert.equal((await lstat(retained)).size, item.bytes); assert.equal(await sha(retained), item.sha256);
      await copyFile(retained, join(sandbox, item.fileName), constants.COPYFILE_EXCL);
      assert.equal((await lstat(join(sandbox, item.fileName))).size, item.bytes); assert.equal(await sha(join(sandbox, item.fileName)), item.sha256);
      await run(fixedNode, [extractor, sandbox, '-xzf', item.fileName], { timeout: 360_000 });
      const boundary = JSON.parse(await readFile(join(sandbox, 'tar-extraction-boundary.json'), 'utf8'));
      assert.equal(boundary.sandbox, sandbox); assert.equal(boundary.pathsConfined, true); assert.equal(boundary.links, 0); assert.equal(boundary.specialFiles, 0);
      await checkpoint(`${tool}-extraction-boundary`, boundary);
      await checkpoint(`${tool}-download`, { bytes: item.bytes, sha256: item.sha256, checksum: 'passed', extraction: 'passed', singleCommandCompleteDownload: true,
        downloaderPlatform: 'win32', nativeVerificationPlatform: 'linux', transferEvidence: report.windowsDownloadEvidence, partialResumed: false, WSLFullCopyHashMatch: true });
      continue;
    }
    if (wgetReplacement) await assert.rejects(lstat(join(sandbox, item.fileName)), { code: 'ENOENT' });
    const actualCommand = tool === 'wget' ? selected[tool].replace('wget --https-only', 'wget --tries=1 --timeout=90 --https-only') : selected[tool];
    if (tool === 'wget') await save('actual-wget.sh', actualCommand + '\n');
    const result = await run('/bin/sh', ['-c', actualCommand], { timeout: 1_800_000, detached: true, progressFile: join(sandbox, item.fileName), env: downloadEnvironment });
    await save(`${tool}.log`, result.stdout + '\n' + result.stderr);
    const downloaded = join(sandbox, item.fileName);
    assert.equal((await stat(downloaded)).size, item.bytes); assert.equal(await sha(downloaded), item.sha256);
    assert(result.stdout.includes(`${item.fileName}: OK`), `${tool} recipe did not report checksum verification.`);
    const extraction = JSON.parse(await readFile(join(sandbox, 'tar-extraction-boundary.json'), 'utf8'));
    assert.equal(extraction.sandbox, sandbox); assert.equal(extraction.pathsConfined, true); assert.equal(extraction.links, 0); assert.equal(extraction.specialFiles, 0);
    await checkpoint(`${tool}-extraction-boundary`, extraction);
    await checkpoint(`${tool}-download`, { bytes: item.bytes, sha256: item.sha256, checksum: 'passed', extraction: 'passed', singleCommandCompleteDownload: true,
      commandSha256: textHash(selected[tool]), actualCommandSha256: textHash(actualCommand), ...(tool === 'wget' ? { automaticRetries: 0, partialResumed: false, tries: 1 } : {}) });
  }

  const packageRoot = join(sandbox, 'rivloom'), launcher = join(packageRoot, 'bin/rivloom');
  const runtime = JSON.parse(await readFile(join(packageRoot, 'runtime-manifest.json'), 'utf8'));
  assert.equal(runtime.sourceCommit, expected.commit); assert.equal(runtime.sourceDirty, false); assert.equal(runtime.version, record.version);
  assert.deepEqual(runtime.target, { platform: 'linux', arch: 'x64' });
  const found = [];
  async function walk(directory, prefix = '') { for (const entry of await readdir(directory, { withFileTypes: true })) { assert(!entry.isSymbolicLink()); const relative = prefix + entry.name; if (entry.isDirectory()) await walk(join(directory, entry.name), relative + '/'); else { assert(entry.isFile()); found.push(relative); } } }
  await walk(packageRoot);
  assert.deepEqual(found.filter(path => path !== 'runtime-manifest.json').sort(), runtime.files.map(file => file.path).sort());
  for (const file of runtime.files) { assert(!file.path.startsWith('/') && !file.path.split('/').includes('..')); const path = join(packageRoot, file.path); assert.equal((await stat(path)).size, file.bytes); assert.equal(await sha(path), file.sha256); }
  // tar respects our private umask, so 0755 archive entries may become 0700.
  assert.equal((await stat(launcher)).mode & 0o700, 0o700);
  assert.equal((await stat(launcher)).mode & 0o022, 0);
  const packageChecks = await verifyPackage({ packageRoot, runtime, run, sha, save });
  for (const [name, value] of Object.entries(packageChecks)) await checkpoint(name, value);
  const version = (await run(launcher, ['--version'])).stdout.trim(); assert.equal(version, record.version);
  await checkpoint('runtime-integrity', { files: runtime.files.length, sourceCommit: runtime.sourceCommit, sourceDirty: runtime.sourceDirty, cliVersion: version });

  // No --data-dir override: prove the normal default is scoped by our clean HOME.
  const initialized = JSON.parse((await run(launcher, ['init', '--name', 'Public-linux-x64-acceptance', '--json'])).stdout);
  await save('init.json', initialized); assert.equal((await stat(data)).mode & 0o777, 0o700);
  const start = () => { child = spawn(launcher, ['serve'], { cwd: sandbox, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); const append = bytes => { output += bytes.toString(); }; child.stdout.on('data', append); child.stderr.on('data', append); };
  async function ready() {
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.equal(child.exitCode, null, 'Service exited during startup.');
      try {
        const control = JSON.parse(await readFile(join(data, 'headless-control.json'), 'utf8'));
        assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(control.url));
        const health = await (await fetch(`${control.url}/api/health`, { signal: AbortSignal.timeout(1500) })).json();
        if (health.ok && health.engineReady) return JSON.parse((await run(launcher, ['status', '--json'], { timeout: 30_000 })).stdout);
      } catch { /* bounded readiness polling */ }
      await delay(500);
    }
    throw new Error('Public package failed to become ready.');
  }
  start();
  const first = await ready(); await save('status-first.json', first);
  assert.equal(resolve(first.dataDir), data); assert.equal(first.engine.ready, true); assert.equal(first.executionPolicy.enabled, false); assert(first.node.id);
  assert.equal(first.engine.version, packageChecks['engine-provenance'].version);
  assert.equal((await stat(join(data, 'headless-control.json'))).mode & 0o777, 0o600);
  await checkpoint('startup', { nodeID: first.node.id, engineReady: true, engineVersion: first.engine.version, defaultExecutionDisabled: true, dataDirectory: data, dataMode: '0700', controlMode: '0600', discovery: 'disabled to isolate installed nodes' });
  const firstExit = await stop();
  start(); const second = await ready(); await save('status-restart.json', second);
  assert.equal(second.node.id, first.node.id); assert.equal(second.executionPolicy.enabled, false);
  assert.equal(second.engine.version, packageChecks['engine-provenance'].version);
  const secondExit = await stop();
  await checkpoint('restart-sigterm', { identityPreserved: true, firstExit, secondExit, controlFileRemoved: true });
  // Check the real new-version dependency evidence at the same stopped-runtime
  // boundary used by desktop backup. Only this fresh acceptance HOME is read.
  const config = join(data, 'engine/config/opencode');
  const inventoryPath = join(config, '.rivloom-plugin-dependencies-files.json');
  const inventoryInfo = await lstat(inventoryPath);
  assert(inventoryInfo.isFile() && !inventoryInfo.isSymbolicLink() && inventoryInfo.size <= 32 * 1024 ** 2);
  const inventoryBytes = await readFile(inventoryPath), inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schemaVersion, 1); assert.match(inventory.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(inventory).sort(), ['files', 'fingerprint', 'schemaVersion']);
  assert(Array.isArray(inventory.files) && inventory.files.length > 0 && inventory.files.length <= 200_000);
  const markerPath = join(config, '.rivloom-plugin-dependencies'), markerInfo = await lstat(markerPath);
  assert(markerInfo.isFile() && !markerInfo.isSymbolicLink());
  assert.equal(await readFile(markerPath, 'utf8'), inventory.fingerprint);
  const actual = [], expectedPaths = new Set();
  async function dependencyWalk(directory, prefix) {
    const info = await lstat(directory); assert(info.isDirectory() && !info.isSymbolicLink());
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = prefix + entry.name, info = await lstat(path);
      assert(!info.isSymbolicLink());
      if (info.isDirectory()) await dependencyWalk(path, name + '/');
      else { assert(info.isFile()); actual.push(name); }
    }
  }
  await dependencyWalk(join(config, 'node_modules'), 'node_modules/');
  let dependencyBytes = 0;
  for (const file of inventory.files) {
    assert(file.path.startsWith('node_modules/') && !/[\\:\u0000-\u001f\u007f]/.test(file.path));
    assert(file.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert(!expectedPaths.has(file.path.toLowerCase())); expectedPaths.add(file.path.toLowerCase());
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0); assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const path = join(config, file.path), info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink()); assert.equal(info.size, file.bytes); assert.equal(await sha(path), file.sha256);
    dependencyBytes += file.bytes;
  }
  assert.deepEqual(actual.sort(), inventory.files.map(file => file.path).sort());
  assert(expectedPaths.has('node_modules/@opencode-ai/plugin/dist/index.js'));
  assert(expectedPaths.has('node_modules/@opencode-ai/plugin/package.json'));
  const declared = JSON.parse(await readFile(join(config, 'package.json'), 'utf8'));
  const installedPlugin = JSON.parse(await readFile(join(config, 'node_modules/@opencode-ai/plugin/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(declared.dependencies), ['@opencode-ai/plugin']);
  assert.equal(declared.dependencies['@opencode-ai/plugin'], installedPlugin.version);
  assert.equal(installedPlugin.version, packageChecks['engine-provenance'].packageVersion);
  for (const key of ['devDependencies', 'optionalDependencies', 'peerDependencies']) if (declared[key] !== undefined) assert.deepEqual(Object.keys(declared[key]), []);
  await save('engine-dependency-inventory.json', inventoryBytes.toString('utf8'));
  await checkpoint('dependency-inventory', { status: 'passed', schemaVersion: inventory.schemaVersion, fingerprint: inventory.fingerprint,
    files: inventory.files.length, bytes: dependencyBytes, manifestBytes: inventoryBytes.length, manifestSha256: textHash(inventoryBytes),
    pluginVersion: installedPlugin.version, completeFileSet: true, pathBytesHashMatch: true, exactPluginDeclaration: true,
    afterRuntimeStopped: true, evidence: 'engine-dependency-inventory.json', scope: 'fresh synthetic HOME only; read-only verification' });
  const retainedArchive = join(evidence, item.fileName);
  try { await copyFile(join(sandbox, item.fileName), retainedArchive, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assert.equal((await stat(retainedArchive)).size, item.bytes); assert.equal(await sha(retainedArchive), item.sha256);
  await checkpoint('retained-archive', { path: retainedArchive, bytes: item.bytes, sha256: item.sha256 });
  }
  delete report.error;
  report.status = phase === 'website' ? 'passed' : 'download-runtime-passed-awaiting-website'; report.finishedAt = new Date().toISOString();
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); report.finishedAt = new Date().toISOString(); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { await stop(); } catch { child.kill('SIGKILL'); report.cleanup = 'SIGKILL fallback; inspect service log'; }
  }
  if (phase !== 'website') await save('service.log', output); await save('report.json', report);
  console.log(JSON.stringify({ status: report.status, stage: report.stage, report: join(evidence, 'report.json'), sandbox, error: report.error }));
}
