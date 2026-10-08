// Local evidence only. Every GitHub operation is GET through gh; never publishes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

export const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const preparedInputs = JSON.parse(await readFile(join(evidenceRoot, 'verification-inputs.json'), 'utf8'));
const boundSource = JSON.parse(await readFile(join(evidenceRoot, 'release-source.json'), 'utf8'));
assert(typeof boundSource.checkout === 'string' && boundSource.checkout);
export const checkout = resolve(boundSource.checkout);
if (process.env.RIVLOOM_RELEASE_CHECKOUT) assert.equal(resolve(process.env.RIVLOOM_RELEASE_CHECKOUT), checkout);
export const repository = 'rivloom/rivloom-desktop';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const maxArchive = 256 * 1024 ** 2;
const metadataNames = ['candidate-build.json', 'runtime-manifest.json', 'runtime-before.json', 'runtime-after.json', 'ci-gate.json', 'desktop-install.json', 'webview2.json'];
const id = (value) => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));

export async function regular(path, directory = false) {
  const info = await lstat(path);
  assert(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()), 'Evidence input must be regular, not a link');
  return info;
}
export function git(...args) {
  return execFileSync('git', ['-c', `safe.directory=${checkout}`, ...args], { cwd: checkout, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function sourceContext() {
  await regular(evidenceRoot, true); await regular(checkout, true);
  const bytes = await readFile(join(evidenceRoot, 'release-source.json'));
  const source = JSON.parse(bytes.toString('utf8'));
  assert.match(source.commit, /^(?!0{40}$)[a-f0-9]{40}$/);
  assert.equal(source.version, preparedInputs.version);
  assert.equal(source.runtimeCore, preparedInputs.runtimeCore);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), source.tree);
  assert.deepEqual(JSON.parse(await readFile(join(checkout, 'shared/engine-source.json'), 'utf8')), preparedInputs.reviewedEngineSource);
  assert.equal(git('rev-parse', 'HEAD'), source.commit, 'Release checkout HEAD differs from release-source.json');
  assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '', 'Release checkout must be clean before verifying cloud evidence');
  return { source, sourceSHA256: digest(bytes) };
}
export async function sourceUnchanged(context) {
  assert.equal(digest(await readFile(join(evidenceRoot, 'release-source.json'))), context.sourceSHA256, 'Release source record changed during verification');
  assert.equal(git('rev-parse', 'HEAD'), context.source.commit, 'Release checkout HEAD changed during verification');
  assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '', 'Release checkout changed during verification');
}
function ghGet(path, limit = 4 * 1024 ** 2, binary = false) {
  assert(path.startsWith(`repos/${repository}/`) && !/[\r\n]/.test(path));
  let bytes;
  try {
    bytes = execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET', ...(binary ? ['--allow-escape-sequences'] : []), path], {
      windowsHide: true, timeout: binary ? 240_000 : 60_000, maxBuffer: limit + 1, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const raw = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
    const diagnostic = { at: new Date().toISOString(), stage: binary ? 'archive-get' : 'metadata-get',
      errorClass: typeof error?.name === 'string' ? error.name : 'unknown',
      code: ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'ECONNRESET', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code) ? error.code : null,
      exitCode: Number.isSafeInteger(error?.status) ? error.status : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(error?.signal) ? error.signal : null,
      timedOut: error?.code === 'ETIMEDOUT' || error?.killed === true,
      httpStatus: /HTTP (\d{3})/.exec(raw)?.[1] || null,
      category: /unexpected EOF|\bEOF\b/.test(raw) ? 'eof' : /TLS|SSL/.test(raw) ? 'tls' : /connection reset/i.test(raw) ? 'connection-reset' : /timed? ?out|timeout/i.test(raw) ? 'timeout' : 'unclassified',
      partialStdoutBytes: Buffer.isBuffer(error?.stdout) ? error.stdout.length : null,
      rawOutputSaved: false, credentialOrSignedURLSaved: false };
    writeFileSync(join(evidenceRoot, `transport-failure-${Date.now()}-${randomUUID()}.json`), JSON.stringify(diagnostic, null, 2) + '\n', { flag: 'wx' });
    throw new Error('Read-only GitHub GET failed; inspect the safe transport category record; no raw output or signed URL is logged');
  }
  assert(bytes.length <= limit, 'GitHub response exceeds its bound');
  return binary ? bytes : JSON.parse(bytes.toString('utf8'));
}
export function candidateFiles(version) {
  return [...metadataNames, `Rivloom_${version}_x64-setup.exe`].sort();
}

// All entries are checked, including the complete installer, before writing any.
// Zip64, encrypted/multivolume archives, duplicate paths and extra files fail closed.
export function unzipCandidate(archive, version) {
  assert(archive.length >= 22 && archive.length <= maxArchive, 'Candidate ZIP size is out of bounds');
  let end = -1;
  for (let cursor = archive.length - 22; cursor >= Math.max(0, archive.length - 65_557); cursor--) {
    if (archive.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + archive.readUInt16LE(cursor + 20) === archive.length) { end = cursor; break; }
  }
  assert(end >= 0, 'ZIP end record missing');
  assert.equal(archive.readUInt16LE(end + 4), 0); assert.equal(archive.readUInt16LE(end + 6), 0);
  const count = archive.readUInt16LE(end + 10), centralSize = archive.readUInt32LE(end + 12), centralOffset = archive.readUInt32LE(end + 16);
  assert.equal(archive.readUInt16LE(end + 8), count); assert.equal(count, 8, 'Candidate artifact must contain exactly eight files');
  assert(centralSize > 0 && centralSize < 65_557 && centralOffset + centralSize === end, 'ZIP central directory bounds failed');
  const allowed = new Set(candidateFiles(version)), files = new Map(), spans = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    assert(cursor + 46 <= end); assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10), crc = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32), attributes = archive.readUInt32LE(cursor + 38), offset = archive.readUInt32LE(cursor + 42);
    assert.equal(archive.readUInt16LE(cursor + 34), 0, 'ZIP entry on another disk');
    assert(cursor + 46 + nameLength + extraLength + commentLength <= end);
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    assert(allowed.has(name) && !files.has(name), 'ZIP has an unexpected or duplicate entry');
    assert(!(flags & 1) && [0, 8].includes(method), 'Encrypted or unsupported ZIP entry');
    const unixKind = (attributes >>> 16) & 0o170000;
    assert([0, 0o100000].includes(unixKind) && !(attributes & 0x10), 'ZIP links or directories are not accepted');
    const limit = name.endsWith('.json') ? 2 * 1024 ** 2 : maxArchive;
    assert(size > 0 && size <= limit && compressed > 0 && compressed <= maxArchive, 'ZIP entry exceeds size bounds');
    assert(offset + 30 <= centralOffset); assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    assert.equal(archive.readUInt16LE(offset + 6), flags); assert.equal(archive.readUInt16LE(offset + 8), method);
    const localName = archive.readUInt16LE(offset + 26), localExtra = archive.readUInt16LE(offset + 28), start = offset + 30 + localName + localExtra;
    assert(start <= centralOffset && start + compressed <= centralOffset, 'ZIP data overlaps the central directory');
    assert(archive.subarray(offset + 30, offset + 30 + localName).equals(nameBytes), 'ZIP local and central names differ');
    if (!(flags & 8)) {
      assert.equal(archive.readUInt32LE(offset + 14), crc); assert.equal(archive.readUInt32LE(offset + 18), compressed); assert.equal(archive.readUInt32LE(offset + 22), size);
    }
    spans.push([offset, start + compressed]);
    const raw = archive.subarray(start, start + compressed), bytes = method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : raw;
    assert.equal(bytes.length, size); assert.equal(crc32(bytes), crc, 'ZIP CRC32 differs');
    if (name.endsWith('.json')) { const value = JSON.parse(bytes.toString('utf8')); assert(value && typeof value === 'object' && !Array.isArray(value)); }
    files.set(name, bytes);
  }
  assert.equal(cursor, end, 'Unexpected ZIP directory trailer');
  spans.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index++) assert(spans[index - 1][1] <= spans[index][0], 'Overlapping ZIP entries');
  assert.deepEqual([...files.keys()].sort(), [...allowed].sort());
  return files;
}

export async function fetchCandidate(runID, artifactID, reuseVerifiedDownload = false) {
  assert(id(runID) && (artifactID === undefined || id(artifactID)), 'Usage: node fetch-candidate-evidence.mjs RUN_ID [ARTIFACT_ID]');
  const context = await sourceContext();
  assert.equal(runID, String(context.source.runs.windowsRelease), 'Run must match the explicitly bound official release');
  if (artifactID) assert.equal(artifactID, String(context.source.windowsArtifactID));
  const base = `repos/${repository}`;
  const run = ghGet(`${base}/actions/runs/${runID}`);
  assert.equal(run.id, Number(runID)); assert.equal(run.path, '.github/workflows/windows-candidate.yml');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success', 'Candidate workflow run must have succeeded');
  assert.equal(run.repository?.full_name, repository); assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_repository.id, run.repository.id); assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert(['workflow_run', 'workflow_dispatch', 'push'].includes(run.event));
  // workflow_run.head_sha may identify the default workflow checkout, not the compiled source.
  // The exact artifact name and all original local proofs below bind the actual source commit.
  if (run.event !== 'workflow_run') assert.equal(run.head_sha, context.source.commit);
  const expectedName = `rivloom-candidate-${context.source.commit}-${runID}-${run.run_attempt}`;
  if (!artifactID) {
    const listing = ghGet(`${base}/actions/runs/${runID}/artifacts?per_page=100`);
    assert(Number.isSafeInteger(listing.total_count) && listing.total_count <= 100 && Array.isArray(listing.artifacts));
    const candidates = listing.artifacts.filter((item) => item.name === expectedName && item.expired === false);
    assert.equal(candidates.length, 1, 'Expected exactly one current-attempt candidate artifact');
    artifactID = String(candidates[0].id); assert(id(artifactID));
  }
  assert.equal(artifactID, String(context.source.windowsArtifactID), 'Artifact must match the explicitly bound official release');
  const artifact = ghGet(`${base}/actions/artifacts/${artifactID}`);
  assert.equal(artifact.id, Number(artifactID)); assert.equal(artifact.name, expectedName); assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, run.id); assert.equal(artifact.workflow_run.repository_id, run.repository.id); assert.equal(artifact.workflow_run.head_repository_id, run.repository.id);
  assert(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 1_000_000 && artifact.size_in_bytes <= maxArchive);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  const jobListing = ghGet(`${base}/actions/runs/${runID}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert(Number.isSafeInteger(jobListing.total_count) && jobListing.total_count <= 100 && Array.isArray(jobListing.jobs));
  const jobs = jobListing.jobs.filter((job) => job.name === 'Build and verify Rivloom candidate');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].conclusion, 'success');
  const originalDirectory = join(evidenceRoot, `candidate-${runID}-${artifactID}`);
  let archive;
  if (reuseVerifiedDownload) {
    await regular(originalDirectory, true);
    const previousPath = join(originalDirectory, 'retrieval.json'); await regular(previousPath);
    const previous = JSON.parse(await readFile(previousPath, 'utf8'));
    assert.equal(previous.status, 'retrieved'); assert.equal(previous.commit, context.source.commit);
    assert.equal(previous.runID, runID); assert.equal(previous.artifactID, artifactID);
    assert.equal(previous.artifact.githubDigest, artifact.digest);
    const cached = join(originalDirectory, 'candidate-archive.zip');
    assert.equal((await regular(cached)).size, artifact.size_in_bytes);
    archive = await readFile(cached);
  } else if (process.env.RIVLOOM_RELEASE_ARCHIVE) {
    const downloaded = resolve(process.env.RIVLOOM_RELEASE_ARCHIVE);
    assert.equal(downloaded, join(evidenceRoot, 'windows-candidate-wsl.zip'));
    assert.equal((await regular(downloaded)).size, artifact.size_in_bytes);
    archive = await readFile(downloaded);
  } else archive = ghGet(`${base}/actions/artifacts/${artifactID}/zip`, artifact.size_in_bytes, true);
  assert.equal(archive.length, artifact.size_in_bytes, 'Full artifact byte count differs');
  assert.equal(`sha256:${digest(archive)}`, artifact.digest, 'Artifact SHA-256 differs from GitHub metadata');
  const files = unzipCandidate(archive, context.source.version);
  const candidate = JSON.parse(files.get('candidate-build.json').toString('utf8'));
  assert.equal(candidate.source?.commit, context.source.commit); assert.equal(candidate.source.expectedCommit, context.source.commit);
  await sourceUnchanged(context);
  const directory = reuseVerifiedDownload ? await mkdtemp(originalDirectory + '-recheck-') : originalDirectory;
  if (!reuseVerifiedDownload) await mkdir(directory); // Never overwrite earlier evidence.
  const candidateDirectory = join(directory, 'proof', 'test-results', 'candidate');
  await mkdir(candidateDirectory, { recursive: true });
  await writeFile(join(directory, 'candidate-archive.zip'), archive, { flag: 'wx' });
  for (const [name, bytes] of files) await writeFile(join(candidateDirectory, name), bytes, { flag: 'wx' });
  const retrieval = {
    schemaVersion: 1, status: 'retrieved', at: new Date().toISOString(), repository, commit: context.source.commit, version: context.source.version,
    sourceRecordSHA256: context.sourceSHA256, runID, artifactID, runAttempt: run.run_attempt,
    run: { event: run.event, workflow: run.path, status: run.status, conclusion: run.conclusion, metadataHeadSHA: run.head_sha },
    artifact: { name: artifact.name, bytes: archive.length, sha256: digest(archive), githubDigest: artifact.digest },
    download: reuseVerifiedDownload ? 'Reused the preserved complete GitHub Actions archive; fresh GitHub metadata, full byte count, SHA256 and all eight CRC32 values rechecked; no repeated archive request' : process.env.RIVLOOM_RELEASE_ARCHIVE ? 'Complete GitHub artifact downloaded through authenticated API redirect and WSL curl; fresh metadata, full byte count, SHA256 and eight CRC32 values independently rechecked; no credentials or signed URLs saved' : 'Complete bounded GitHub Actions artifact through read-only gh GET; no credentials or signed redirect URLs saved',
    files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes), crc32Verified: true })),
    installerExecuted: false, runtimeExecuted: false, publicationTriggered: false,
  };
  await writeFile(join(directory, 'retrieval.json'), JSON.stringify(retrieval, null, 2) + '\n', { flag: 'wx' });
  return { directory, candidateDirectory, context, retrieval };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await fetchCandidate(...process.argv.slice(2)); console.log(JSON.stringify({ status: 'retrieved', directory: result.directory, files: result.retrieval.files.length })); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Candidate retrieval failed'); process.exitCode = 1; }
}
