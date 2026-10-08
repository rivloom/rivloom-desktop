// Static independent verification only: no NSIS/Rivloom/runtime execution or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fetchCandidate, checkout, digest, repository, regular, sourceContext, sourceUnchanged } from './fetch-candidate-evidence.mjs';
import { pathToFileURL } from 'node:url';
import { verifyStaticRuntime } from './verify-static-runtime.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
let result;
let phase = 'download';
try {
  const args = process.argv.slice(2), reuse = args.at(-1) === '--reuse-verified-download';
  if (reuse) args.pop();
  assert(args.length === 1 || args.length === 2, 'Usage: node verify-candidate.mjs RUN_ID [ARTIFACT_ID] [--reuse-verified-download]');
  const frozenContext = await sourceContext();
  const preflight = JSON.parse(await readFile(new URL('./windows-candidate-preflight.json', import.meta.url), 'utf8'));
  assert.equal(preflight.status, 'preflight-passed-awaiting-candidate');
  assert.equal(preflight.commit, frozenContext.source.commit);
  assert.equal(preflight.sourceRecordSHA256, frozenContext.sourceSHA256, 'Run source binding preflight after final candidate IDs are populated');
  result = await fetchCandidate(args[0], args[1], reuse);
  const { directory, candidateDirectory, context, retrieval } = result;
  const { prepareRelease } = await import(pathToFileURL(join(checkout, 'scripts/ci-release.ts')));
  const { measureInstalledTree } = await import(pathToFileURL(join(checkout, 'scripts/ci-desktop-install-smoke.ts')));
  const { readEngineSource, verifyPreparedEngine } = await import(pathToFileURL(join(checkout, 'server/engine-artifact.ts')));
  phase = 'release-contract';
  const proof = join(directory, 'proof');
  for (const relative of ['package.json', 'package-lock.json', 'src-tauri/Cargo.lock', 'shared/engine-source.json']) {
    await regular(join(checkout, relative));
    await mkdir(join(proof, relative, '..'), { recursive: true });
    await copyFile(join(checkout, relative), join(proof, relative));
  }
  const plan = await prepareRelease(proof, { repository, commit: context.source.commit, runID: retrieval.runID, artifactID: retrieval.artifactID });
  assert.equal(plan.version, context.source.version);
  const candidate = await json(join(candidateDirectory, 'candidate-build.json'));
  const before = await json(join(candidateDirectory, 'runtime-before.json'));
  phase = 'nsis-list';
  const sevenZip = JSON.parse(await readFile(new URL('./verification-inputs.json', import.meta.url), 'utf8')).extractor.path;
  await regular(sevenZip);
  const extractorSHA256 = digest(await readFile(sevenZip));
  assert.equal(extractorSHA256, JSON.parse(await readFile(new URL('./verification-inputs.json', import.meta.url), 'utf8')).extractor.sha256, 'Extractor differs from reviewed local tool');
  const extraction = join(directory, 'extracted'), scratch = join(directory, 'extractor-temp');
  await mkdir(extraction); await mkdir(scratch);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles|programfiles\(x86\)|programdata)$/i.test(name)));
  for (const key of ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[key] = scratch;
  const installer = plan.assets[0].path;
  const list = execFileSync(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', installer], {
    cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 24 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await writeFile(join(directory, 'nsis-file-list.txt'), list, { flag: 'wx' });
  const entries = list.trim().split(/\r?\n\r?\n/).map((block) => Object.fromEntries(block.split(/\r?\n/).filter(Boolean).map((line) => { const at = line.indexOf(' = '); assert(at > 0, 'Invalid 7-Zip listing'); return [line.slice(0, at), line.slice(at + 3)]; })));
  assert(entries.length > 100 && entries.length < 50_000, 'Unexpected NSIS entry count');
  let listedBytes = 0;
  const measuredPluginEntries = [];
  const paths = new Set();
  for (const entry of entries) {
    const path = entry.Path;
    assert(path && path.length <= 512 && !isAbsolute(path) && !/^[\\/]/.test(path) && !/[:\u0000-\u001f\u007f]/.test(path), 'Unsafe NSIS path');
    assert(path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..'), 'NSIS path escapes extraction');
    assert(!entry['Symbolic Link'] && !entry['Hard Link'] && !entry['Reparse Point'], 'NSIS links are not accepted');
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    assert(!paths.has(normalized), 'Duplicate case-insensitive NSIS path'); paths.add(normalized);
    let size;
    if (/^\d+$/.test(entry.Size)) size = Number(entry.Size);
    else {
      // 7-Zip leaves the last solid NSIS plugin size empty. Measure only this
      // exact standard plugin through bounded stdout before any full extraction.
      assert.equal(entry.Size, ''); assert.equal(normalized, '$pluginsdir/nsexec.dll');
      const plugin = execFileSync(sevenZip, ['x', '-so', '-bd', '-bb0', installer, path], {
        cwd: directory, env, windowsHide: true, timeout: 180_000, maxBuffer: 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert(plugin.length > 0 && plugin.length <= 1024 ** 2 && plugin.readUInt16LE(0) === 0x5a4d, 'Invalid bounded NSIS plugin');
      size = plugin.length; measuredPluginEntries.push({ path, bytes: size, sha256: digest(plugin) });
    }
    assert(Number.isSafeInteger(size) && size >= 0); listedBytes += size;
    assert(listedBytes <= 8 * 1024 ** 3, 'NSIS expanded size exceeds bound');
  }
  assert(paths.has('runtime/runtime-manifest.json') && paths.has('rivloom.exe'), 'NSIS product payload is incomplete');
  phase = 'nsis-extract';
  const extractionLog = execFileSync(sevenZip, ['x', '-y', '-bsp0', '-sccUTF-8', `-o${extraction}`, installer], {
    cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await writeFile(join(directory, 'nsis-extraction.log'), extractionLog, { flag: 'wx' });
  for (const entry of measuredPluginEntries) {
    const path = join(extraction, entry.path); assert.equal((await regular(path)).size, entry.bytes);
    assert.equal(digest(await readFile(path)), entry.sha256, 'Extracted NSIS plugin differs from bounded measurement');
  }
  const runtime = join(extraction, 'runtime');
  await regular(runtime, true); await regular(join(extraction, 'Rivloom.exe'));
  phase = 'runtime-tree';
  const tree = measureInstalledTree(runtime);
  assert.deepEqual(tree, candidate.runtimeTree, 'Extracted complete runtime tree differs from CI pre-build evidence');
  phase = 'engine-provenance';
  const expectedEngine = readEngineSource(checkout, 'windows-x64');
  assert.equal(expectedEngine.commit, context.source.runtimeCore);
  const engine = verifyPreparedEngine(runtime, 'windows-x64');
  assert.deepEqual(engine.source, expectedEngine, 'Packaged engine source lock differs from reviewed checkout');
  assert.equal(engine.binarySHA256, before.binaries.opencode.sha256, 'Actual packaged Runtime binary differs from CI evidence');
  assert.equal(engine.receiptSHA256, before.engineSource.receiptSha256, 'Packaged engine build receipt differs from CI evidence');
  assert.equal(digest(await readFile(join(runtime, 'runtime-manifest.json'))), candidate.runtimeManifestSha256);
  assert.equal(digest(await readFile(join(runtime, 'shared/engine-source.json'))), before.engineSource.lockSha256);
  const staticRuntime = await verifyStaticRuntime(runtime, context, candidate, before, engine);
  const report = {
    staticRuntime,
    schemaVersion: 1, status: 'passed', at: new Date().toISOString(), repository, commit: context.source.commit, version: plan.version,
    runID: retrieval.runID, artifactID: retrieval.artifactID, sourceRecordSHA256: context.sourceSHA256, tag: plan.tag,
    checks: ['Successful current-attempt Windows candidate provenance', 'Complete bounded archive digest and all eight ZIP entry CRC32 values', 'Original strict prepareRelease CI/install/runtime-before-after/NSIS-byte contract', 'Independent static NSIS extraction and complete runtime tree equality', 'Actual packaged fixed Runtime binary, producer manifest, smoke, source proof, lock and build receipt'],
    installer: { name: plan.assets[0].name, bytes: plan.assets[0].size, sha256: plan.assets[0].sha256 },
    archive: retrieval.artifact, runtimeTree: tree,
    engine: { commit: engine.source.commit, tree: engine.source.tree, binarySHA256: engine.binarySHA256, manifestSHA256: engine.manifestSHA256, smokeSHA256: engine.smokeSHA256, receiptSHA256: engine.receiptSHA256 },
    extractor: { name: '7-Zip', sha256: extractorSHA256, listedEntries: entries.length, listedBytes, measuredPluginEntries },
    originalHostedInstallationSmokeVerified: true, installerExecuted: false, runtimeExecuted: false, publicationTriggered: false,
    limitation: 'Original hosted installation/start/restart/uninstall evidence is checked; no new local installation, physical-device test, real-provider inference, signing or publication is claimed.',
  };
  phase = 'source-freeze';
  await sourceUnchanged(context);
  await writeFile(join(directory, 'runtime-tree.json'), JSON.stringify(tree, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'candidate-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', directory, installer: report.installer, runtimeFiles: tree.files }));
} catch (error) {
  // No transport response, command output, environment or exception object is saved.
  if (result) await writeFile(join(result.directory, 'candidate-verification-failed.json'), JSON.stringify({ schemaVersion: 1, status: 'failed', phase, at: new Date().toISOString(), commit: result.context.source.commit, runID: result.retrieval.runID, artifactID: result.retrieval.artifactID, installerExecuted: false, runtimeExecuted: false, publicationTriggered: false }, null, 2) + '\n', { flag: 'wx' });
  console.error('Candidate verification failed. Existing evidence is preserved; no installer or packaged runtime was executed.');
  console.error(error instanceof Error && error.name === 'AssertionError' ? error.message.split('\n')[0] : 'Inspect the preserved stage evidence; raw transport/command errors are intentionally omitted.');
  process.exitCode = 1;
}
