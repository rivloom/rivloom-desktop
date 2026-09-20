import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineBinaryName, engineDigest, engineRecipeDigest, engineRegularFile, engineRelativePath, engineSourceFile, engineTarget, readEngineSource, verifyEngineArtifact, verifyPreparedEngine, type EngineSource } from '../server/engine-artifact.ts';

export function parseEngineArguments(args: string[]) {
  assert(args.length === 0 || (args.length === 2 && ['--artifact', '--source'].includes(args[0]) && args[1] && !args[1].startsWith('--')), 'Usage: node scripts/engine-prepare.ts [--artifact VERIFIED_DIRECTORY | --source LOCAL_RUNTIME_REPOSITORY]');
  return args.length ? { mode: args[0] === '--artifact' ? 'artifact' : 'source', path: resolve(args[1]) } : { mode: 'source', path: null };
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2 }).trim();
}
export function sourceSnapshot(root: string, source: EngineSource) {
  assert.equal(git(root, 'rev-parse', 'HEAD'), source.commit, 'Runtime checkout is not the pinned commit');
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), source.tree);
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Runtime source must be clean');
  git(root, 'merge-base', '--is-ancestor', source.upstream.commit, 'HEAD');
  const inputs = Object.fromEntries(Object.keys(source.inputs).map(path => [path, engineDigest(readFileSync(engineRegularFile(root, path)))]));
  assert.deepEqual(inputs, source.inputs, 'Runtime build inputs differ from the reviewed source');
  const files = git(root, 'ls-files', '--stage', '-z').split('\0').filter(Boolean).sort().map(entry => {
    const match = entry.match(/^(100644|100755|120000) [a-f0-9]{40} 0\t([\s\S]+)$/);
    assert(match, 'Unmerged or unsupported Git source input');
    const path = engineRelativePath(match[2]), file = join(root, path);
    // Hash the link itself, never its target. Windows may materialize Git links as text files.
    const bytes = match[1] === '120000' && lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(engineRegularFile(root, path));
    return [path, match[1], engineDigest(bytes)];
  });
  return { commit: source.commit, tree: source.tree, clean: true, inputs, files: files.length, sourceSHA256: engineDigest(JSON.stringify(files)) };
}
async function realDirectory(root: string, relative: string) {
  let cursor = root;
  assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Workspace must be a real directory');
  for (const part of relative.split('/')) {
    assert(part && part !== '.' && part !== '..' && !/[\\:]/.test(part));
    cursor = join(cursor, part);
    await mkdir(cursor, { recursive: true });
    assert(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink(), 'Engine build directories must not be links');
  }
  return cursor;
}
export function verifyEngineRecipe(root: string, source: EngineSource) {
  if (!source.recipe) return;
  const files = Object.fromEntries(Object.keys(source.recipe.files).map(file => [file, engineDigest(readFileSync(engineRegularFile(root, `${source.recipe!.directory}/${file}`)))]));
  assert.deepEqual(files, source.recipe.files, 'Linux build recipe differs from the pinned snapshot');
}
async function build(root: string, checkout: string, source: EngineSource, artifact: string) {
  const linux = source.target === 'linux-x64';
  verifyEngineRecipe(root, source);
  await new Promise<void>((accept, reject) => {
    const command = linux ? process.execPath : 'pwsh.exe';
    const args = linux ? [join(root, source.recipe!.directory, 'build.mjs'), '--source', checkout, '--output', artifact]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(checkout, 'rivloom/build.ps1'), '-RequireClean'];
    const child = spawn(command, args, {
      cwd: checkout, windowsHide: true, stdio: 'inherit', env: { ...process.env, CI: 'true' },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Pinned runtime build failed (${code}); no fallback engine will be used.`)));
  });
  verifyEngineRecipe(root, source);
}
export async function prepareEngine(root: string, options = parseEngineArguments([])) {
  const target = engineTarget(), source = readEngineSource(root, target);
  assert.equal(process.versions.node, source.toolchain.node);
  const destination = join(root, source.artifactPath);
  if (existsSync(destination)) {
    const result = verifyPreparedEngine(root);
    if (options.mode === 'artifact' && options.path) {
      verifyEngineArtifact(options.path, source, true);
      verifyEngineArtifact(result.directory, source, true);
    }
    console.log(`Verified cached Rivloom engine ${source.version}: ${result.binarySHA256}`);
    return result;
  }
  const parent = await realDirectory(root, source.artifactPath.split('/').slice(0, -1).join('/'));
  const staging = await mkdtemp(join(parent, '.preparing-'));
  let artifact = options.path;
  let proof: ReturnType<typeof sourceSnapshot> | undefined;
  if (options.mode === 'source') {
    const base = await realDirectory(root, '.data/engine-builds');
    const run = await mkdtemp(join(base, 'build-'));
    const checkout = join(run, 'source');
    if (target === 'windows-x64') assert(checkout.length <= 120, 'The runtime checkout path is too long for Windows native dependencies. Move the desktop checkout to a shorter path.');
    console.log(`Building locked Rivloom runtime ${source.commit} in ${checkout}`);
    // No branch/latest lookup. A local repository is only an object source; dirty working files are not copied.
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--no-checkout', '--no-hardlinks', '--', options.path || source.repository, checkout], { windowsHide: true, stdio: 'inherit' });
    git(checkout, 'config', 'core.autocrlf', 'false');
    git(checkout, 'checkout', '--detach', source.commit);
    proof = sourceSnapshot(checkout, source);
    artifact = target === 'linux-x64' ? join(run, 'artifact') : join(checkout, 'rivloom/dist/windows-x64');
    await build(root, checkout, source, artifact);
    assert.deepEqual(sourceSnapshot(checkout, source), proof, 'Runtime source changed while building');
  }
  assert(artifact);
  const result = verifyEngineArtifact(artifact, source, options.mode === 'artifact');
  for (const name of [engineBinaryName(source), 'runtime-manifest.json', 'smoke-report.json', 'SHA256SUMS', 'LICENSE', 'README.md', ...(target === 'linux-x64' ? ['source-files.json'] : [])])
    await copyFile(engineRegularFile(artifact, name), join(staging, name));
  if (target === 'linux-x64') await chmod(join(staging, 'opencode'), 0o755);
  let sourceProofSHA256: string | undefined;
  if (proof) {
    const bytes = JSON.stringify(proof, null, 2) + '\n';
    writeFileSync(join(staging, 'source-proof.json'), bytes, { flag: 'wx' });
    sourceProofSHA256 = engineDigest(bytes);
  }
  writeFileSync(join(staging, 'engine-build.json'), JSON.stringify({
    schemaVersion: 1, kind: 'rivloom-engine-build', mode: options.mode === 'artifact' ? 'pinned-artifact' : 'source-build',
    preparedAt: new Date().toISOString(), sourceLockSHA256: engineDigest(readFileSync(engineRegularFile(root, engineSourceFile(target)))),
    commit: source.commit, tree: source.tree, binarySHA256: result.binarySHA256,
    manifestSHA256: result.manifestSHA256, smokeSHA256: result.smokeSHA256, ...(sourceProofSHA256 ? { sourceProofSHA256 } : {}),
    ...(source.recipe ? { recipeSHA256: engineRecipeDigest(source) } : {}),
  }, null, 2) + '\n', { flag: 'wx' });
  verifyEngineArtifact(staging, source, options.mode === 'artifact');
  assert(!existsSync(destination), 'Another engine preparation finished concurrently; preserve both outputs and retry');
  await rename(staging, destination);
  const prepared = verifyPreparedEngine(root);
  console.log(`Prepared Rivloom engine ${source.version}: ${prepared.binarySHA256}`);
  return prepared;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareEngine(resolve(import.meta.dirname, '..'), parseEngineArguments(process.argv.slice(2)));
