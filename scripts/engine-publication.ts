import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { engineDigest, engineProducerSchema, engineRegularFile, verifyEngineProducer, type EngineSource } from '../server/engine-artifact.ts';

export type EngineSourceProof = { commit: string; tree: string; clean: boolean; inputs: Record<string, string>; files: number; sourceSHA256: string };
export type ProducerFailure = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stderrOverflow: boolean };
type Identity = { dev: string; ino: string; mode: string };
type Workspace = { checkout: string; dist: string; target: string; source: EngineSource; before: EngineSourceProof;
  directories: { path: string; identity: Identity }[] };
const names = ['LICENSE', 'README.md', 'SHA256SUMS', 'opencode.exe', 'runtime-manifest.json', 'source-files.json'];
const sums = ['LICENSE', 'README.md', 'opencode.exe', 'runtime-manifest.json', 'source-files.json'];
const identity = (file: string): Identity => { const s = lstatSync(file, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode) }; };
const missing = (file: string) => assert(!lstatSync(file, { throwIfNoEntry: false }), 'Publication target or workspace already exists');
function directory(file: string) {
  const absolute = resolve(file); let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part); const stat = lstatSync(cursor);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Publication directory has a link or invalid ancestor');
  }
  assert.equal(realpathSync(absolute).toLowerCase(), absolute.toLowerCase(), 'Publication directory resolves elsewhere');
}
function sourceMatches(source: EngineSource, proof: EngineSourceProof) {
  assert.equal(proof.commit, source.commit); assert.equal(proof.tree, source.tree); assert.equal(proof.clean, true);
  assert.deepEqual(proof.inputs, source.inputs); assert.deepEqual({ files: proof.files, sha256: proof.sourceSHA256 }, source.sourceInventory);
}
export function capturePublicationWorkspace(root: string, checkout: string, source: EngineSource, before: EngineSourceProof): Workspace {
  assert.equal(source.target, 'windows-x64'); assert.equal(engineProducerSchema(source), 2); assert(source.verification && source.sourceInventory);
  const run = dirname(resolve(checkout)), builds = join(resolve(root), '.data', 'engine-builds');
  assert.equal(dirname(run), builds); assert.match(basename(run), /^build-[A-Za-z0-9]{6}$/); assert.equal(basename(checkout), 'source');
  sourceMatches(source, before);
  const paths = [builds, run, resolve(checkout), join(resolve(checkout), 'rivloom')]; paths.forEach(directory);
  const dist = join(resolve(checkout), 'rivloom', 'dist'); missing(dist);
  return { checkout: resolve(checkout), dist, target: join(dist, 'windows-x64'), source: structuredClone(source), before: structuredClone(before),
    directories: paths.map(path => ({ path, identity: identity(path) })) };
}

export function publicationFailureMatches(failure: ProducerFailure, paths: { stage: string; target: string; publisherURL: string; compilerURL: string }) {
  if (failure.code !== 1 || failure.signal !== null || failure.stderrOverflow) return false;
  const stderr = failure.stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const blocks = [...stderr.matchAll(/^Error: ([A-Z_]+): ([^\r\n]+)\r?\n((?:[ \t]+at [^\r\n]*\r?\n)+)([\s\S]*?)^\}/gm)];
  if (blocks.length !== 1) return false;
  const [, code, message, stack, body] = blocks[0];
  if (code !== 'EPERM' || message !== `operation not permitted, rename '${paths.stage}' -> '${paths.target}'`) return false;
  const fields = body.trim().split(/\r?\n/).map(line => /^\s*([a-z]+):\s*(.*?)\s*,?$/.exec(line));
  if (fields.some(field => !field) || fields.length !== 5) return false;
  const actual = Object.fromEntries(fields.map(field => [field![1], field![2].replace(/,$/, '')]));
  const expected = { errno: '-4048', code: inspect('EPERM'), syscall: inspect('rename'), path: inspect(paths.stage), dest: inspect(paths.target) };
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) || Object.entries(expected).some(([key, value]) => actual[key] !== value)) return false;
  return stack.split(/\r?\n/).some(line => line.trim() === `at publishDirectory (${paths.publisherURL}:70:3)`) &&
    stack.split(/\r?\n/).some(line => line.trim() === `at ${paths.compilerURL}:97:1`);
}
function partial(workspace: Workspace, location: string) {
  directory(location); assert.deepEqual(readdirSync(location).sort(), names);
  const ledger = names.map(name => {
    const file = engineRegularFile(location, name), before = lstatSync(file, { bigint: true });
    assert.equal(before.nlink, 1n, 'Publication artifacts must not be hard links');
    assert(before.size >= 0n && before.size <= 256n * 1024n ** 2n, 'Publication artifact exceeds its bound');
    const bytes = readFileSync(file), after = lstatSync(file, { bigint: true });
    const stable = (stat: typeof before) => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs];
    assert.deepEqual(stable(after), stable(before), 'Publication artifact changed while reading');
    return { name, identity: identity(file), bytes: bytes.length, modified: String(before.mtimeNs), changed: String(before.ctimeNs), sha256: engineDigest(bytes) };
  });
  verifyEngineProducer(location, workspace.source);
  assert.equal(readFileSync(join(location, 'SHA256SUMS'), 'utf8'), sums.map(name => `${ledger.find(row => row.name === name)!.sha256}  ${name}\n`).join(''), 'Partial producer checksum list differs');
  return { identity: identity(location), files: ledger };
}
export async function recoverPublication(workspace: Workspace, failure: ProducerFailure, snapshot: () => EngineSourceProof,
  clock: { now: () => number; wait: (milliseconds: number) => Promise<void> } = { now: () => performance.now(), wait: milliseconds => delay(milliseconds) }) {
  if (failure.code !== 1 || failure.signal !== null || failure.stderrOverflow) return null;
  if (!lstatSync(workspace.dist, { throwIfNoEntry: false })) return null;
  directory(workspace.dist);
  const entries = readdirSync(workspace.dist);
  const stages = entries.filter(name => /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name));
  if (stages.length !== 1) return null;
  const stage = join(workspace.dist, stages[0]);
  if (!publicationFailureMatches(failure, { stage, target: workspace.target,
    publisherURL: pathToFileURL(join(workspace.checkout, 'rivloom/artifact.mjs')).href,
    compilerURL: pathToFileURL(join(workspace.checkout, 'rivloom/build.mjs')).href })) return null;
  const started = clock.now(), deadline = started + 120_000; let waitedMs = 0;
  const unchanged = () => {
    for (const row of workspace.directories) { directory(row.path); assert.deepEqual(identity(row.path), row.identity, 'Publication workspace identity changed'); }
    assert.deepEqual(snapshot(), workspace.before, 'Runtime source changed before publication recovery');
    for (const name of ['rivloom/artifact.mjs', 'rivloom/build.mjs']) {
      const file = engineRegularFile(workspace.checkout, name); assert.equal(lstatSync(file).nlink, 1, 'Publisher input is a hard link');
      assert.equal(engineDigest(readFileSync(file)), workspace.source.inputs[name], 'Pinned publisher or compiler changed');
    }
  };
  unchanged(); directory(workspace.dist); missing(workspace.target); assert.deepEqual(readdirSync(workspace.dist).sort(), stages);
  const original = partial(workspace, stage);
  const publisher = await import(pathToFileURL(engineRegularFile(workspace.checkout, 'rivloom/artifact.mjs')).href);
  assert.equal(typeof publisher.publishDirectory, 'function');
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert(clock.now() < deadline, 'Publication validation deadline expired');
    unchanged(); missing(workspace.target); assert.deepEqual(readdirSync(workspace.dist).sort(), stages, 'Additional stage or archive appeared');
    assert.deepEqual(partial(workspace, stage), original, 'Publication bytes or identities changed');
    assert(clock.now() < deadline, 'Publication recovery deadline expired');
    try { publisher.publishDirectory(workspace.dist, stage, workspace.target); }
    catch (error) {
      const value = error as NodeJS.ErrnoException & { dest?: string };
      if (value.code !== 'EPERM' || value.syscall !== 'rename' || value.path !== stage || value.dest !== workspace.target) throw error;
      unchanged(); missing(workspace.target); assert.deepEqual(readdirSync(workspace.dist).sort(), stages, 'Publication target or archive appeared');
      assert.deepEqual(partial(workspace, stage), original, 'Publication bytes changed after rename failure');
      if (attempt === 5 || clock.now() >= deadline || waitedMs >= 5000) throw error;
      const waiting = clock.now(), milliseconds = Math.min(100 * 2 ** (attempt - 1), 5000 - waitedMs);
      await clock.wait(milliseconds); waitedMs += Math.max(milliseconds, clock.now() - waiting);
      if (waitedMs >= 5000) throw error;
      continue;
    }
    unchanged(); missing(stage); assert.deepEqual(readdirSync(workspace.dist).sort(), ['windows-x64'], 'Publication produced an unexpected archive or entry');
    assert.deepEqual(partial(workspace, workspace.target), original, 'Published output differs from its validated stage');
    return { state: 'publication-recovered-awaiting-smoke', attempts: attempt, durationMs: clock.now() - started,
      waitedMs, core: workspace.source.commit, stage: basename(stage), manifestSHA256: original.files.find(row => row.name === 'runtime-manifest.json')!.sha256 };
  }
  throw new Error('Publication recovery did not complete');
}
