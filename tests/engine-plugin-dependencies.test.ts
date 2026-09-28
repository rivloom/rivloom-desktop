import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = fileURLToPath(new URL('../test-results/', import.meta.url));
const manifestName = '.rivloom-plugin-dependencies-files.json';
const markerName = '.rivloom-plugin-dependencies';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function removeFixture(root: string) {
  const absolute = resolve(root);
  assert(absolute.startsWith(resolve(base) + sep) && absolute !== resolve(base));
  assert.equal(realpathSync(absolute), absolute);
  const check = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert(!lstatSync(path).isSymbolicLink(), 'Fixture cleanup must not follow links');
      if (entry.isDirectory()) check(path);
    }
  };
  check(absolute);
  rmSync(absolute, { recursive: true });
}
async function fixture(t: TestContext) {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'engine-plugin-dependencies-'));
  t.after(() => removeFixture(root));
  const runtime = join(root, 'runtime'), modules = join(runtime, 'node_modules');
  const source = readFileSync(new URL('../server/engine-plugin-dependencies.ts', import.meta.url), 'utf8');
  const dependency = "from './knowledge-store.ts'";
  assert.equal(source.split(dependency).length, 2);
  // Exercise the real implementation against a tiny bundled-source fixture.
  // Its path safety helper still comes from the actual repository module.
  const moduleFile = join(runtime, 'server', 'engine-plugin-dependencies.ts');
  write(moduleFile, source.replace(dependency, `from ${JSON.stringify(new URL('../server/knowledge-store.ts', import.meta.url).href)}`));
  const expected = new Map<string, Buffer>();
  const bundled = (path: string, value: string) => {
    write(join(modules, path), value);
    expected.set(`node_modules/${path}`, Buffer.from(value));
  };
  bundled('@opencode-ai/plugin/package.json', JSON.stringify({ name: '@opencode-ai/plugin', version: '1.18.31', dependencies: { 'fixture-dep': '1.0.0', shared: '1.0.0' } }));
  bundled('@opencode-ai/plugin/dist/index.js', 'export const plugin = true;');
  bundled('@opencode-ai/plugin/dist/tool.js', 'export const tool = true;');
  bundled('@opencode-ai/plugin/dist/工具.txt', 'bundled text');
  bundled('@opencode-ai/plugin/dist/empty.txt', '');
  bundled('fixture-dep/package.json', JSON.stringify({ name: 'fixture-dep', version: '1.0.0', dependencies: { shared: '2.0.0' } }));
  bundled('fixture-dep/index.js', 'export const value = 1;');
  bundled('fixture-dep/node_modules/shared/package.json', JSON.stringify({ name: 'shared', version: '2.0.0' }));
  bundled('fixture-dep/node_modules/shared/index.js', 'export const value = 2;');
  bundled('shared/package.json', JSON.stringify({ name: 'shared', version: '1.0.0' }));
  bundled('shared/index.js', 'export const value = 1;');
  write(join(modules, '@opencode-ai/plugin/node_modules/undeclared/keep.js'), 'not part of bundled dependency graph');
  const implementation = await import(pathToFileURL(moduleFile).href);
  const engine = join(root, 'engine'), config = join(engine, 'config', 'opencode');
  const readManifest = () => JSON.parse(readFileSync(join(config, manifestName), 'utf8'));
  const assertNoTemporaryFiles = () => assert(!readdirSync(config).some(name => name.startsWith(`${manifestName}.`)));
  return { root, modules, engine, config, expected, readManifest, assertNoTemporaryFiles,
    prepare: (destination = engine) => implementation.prepareEnginePluginDependencies(destination) };
}

test('dependency evidence covers the bundled graph and never incorporates user additions', async t => {
  const f = await fixture(t);
  write(join(f.config, 'package.json'), JSON.stringify({ dependencies: { 'custom-local-plugin': 'file:./custom' }, private: true }));
  write(join(f.config, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { 'custom-local-plugin': 'file:./custom' } }, 'node_modules/custom-local-plugin': { version: '1.0.0' } } }));
  write(join(f.config, 'node_modules/custom-local-plugin/index.js'), 'keep custom plugin');
  f.prepare();
  const manifest = f.readManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.fingerprint, readFileSync(join(f.config, markerName), 'utf8'));
  assert.deepEqual(manifest.files, [...f.expected].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1));
  for (const [path, bytes] of f.expected) assert.deepEqual(readFileSync(join(f.config, path)), bytes);
  assert.equal(readFileSync(join(f.config, 'node_modules/custom-local-plugin/index.js'), 'utf8'), 'keep custom plugin');
  assert.equal(existsSync(join(f.config, 'node_modules/@opencode-ai/plugin/node_modules/undeclared')), false);
  assert.equal(JSON.parse(readFileSync(join(f.config, 'package.json'), 'utf8')).dependencies['custom-local-plugin'], 'file:./custom');
  assert.equal(JSON.parse(readFileSync(join(f.config, 'package-lock.json'), 'utf8')).packages['node_modules/custom-local-plugin'].version, '1.0.0');
  f.assertNoTemporaryFiles();
});

test('a legacy seed gains source evidence without overwriting customized or missing target files', async t => {
  const f = await fixture(t); f.prepare();
  const original = f.readManifest();
  unlinkSync(join(f.config, manifestName));
  write(join(f.config, 'node_modules/@opencode-ai/plugin/dist/tool.js'), 'user-modified implementation');
  unlinkSync(join(f.config, 'node_modules/shared/index.js'));
  write(join(f.config, 'node_modules/manual-only/private.js'), 'user-only file');
  const packageBefore = readFileSync(join(f.config, 'package.json'));
  const lockBefore = readFileSync(join(f.config, 'package-lock.json'));
  f.prepare();
  assert.deepEqual(f.readManifest(), original, 'The source hash cannot be replaced with customized target bytes');
  assert.equal(readFileSync(join(f.config, 'node_modules/@opencode-ai/plugin/dist/tool.js'), 'utf8'), 'user-modified implementation');
  assert.equal(existsSync(join(f.config, 'node_modules/shared/index.js')), false);
  assert.equal(readFileSync(join(f.config, 'node_modules/manual-only/private.js'), 'utf8'), 'user-only file');
  assert.deepEqual(readFileSync(join(f.config, 'package.json')), packageBefore);
  assert.deepEqual(readFileSync(join(f.config, 'package-lock.json')), lockBefore);
  f.assertNoTemporaryFiles();
});

test('invalid evidence is replaced atomically from source while valid evidence is reused', async t => {
  const f = await fixture(t); f.prepare();
  const original = f.readManifest(), manifestPath = join(f.config, manifestName);
  const changedFile = join(f.config, 'node_modules/@opencode-ai/plugin/dist/tool.js');
  write(changedFile, 'keep modified target');
  const variants = ['{', { ...original, fingerprint: '0'.repeat(64) }, { ...original, schemaVersion: 2 },
    { ...original, files: [] }, { ...original, unexpected: true },
    { ...original, files: [...original.files, original.files[0]] },
    { ...original, files: [{ ...original.files[0], path: 'node_modules/../outside' }] },
    { ...original, files: [{ ...original.files[0], path: 'node_modules\\outside' }] },
    { ...original, files: [{ ...original.files[0], bytes: -1 }] },
    { ...original, files: [{ ...original.files[0], sha256: 'bad' }] }];
  for (const invalid of variants) {
    writeFileSync(manifestPath, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    f.prepare();
    assert.deepEqual(f.readManifest(), original);
    assert.equal(readFileSync(changedFile, 'utf8'), 'keep modified target');
    f.assertNoTemporaryFiles();
  }
  const unchangedTime = new Date('2000-01-01T00:00:00Z');
  utimesSync(manifestPath, unchangedTime, unchangedTime);
  const before = statSync(manifestPath).mtimeMs;
  f.prepare();
  assert.equal(statSync(manifestPath).mtimeMs, before, 'A valid fingerprint-bound manifest should not be rewritten');
});

test('a backup without generated dependencies and markers rebuilds the same source files offline', async t => {
  const f = await fixture(t); f.prepare();
  const restored = join(f.root, 'restored-account'), config = join(restored, 'config', 'opencode');
  for (const file of ['package.json', 'package-lock.json']) write(join(config, file), readFileSync(join(f.config, file), 'utf8'));
  f.prepare(restored);
  for (const [path, bytes] of f.expected) assert.deepEqual(readFileSync(join(config, path)), bytes);
  assert.deepEqual(JSON.parse(readFileSync(join(config, manifestName), 'utf8')), f.readManifest());
  assert.equal(readFileSync(join(config, markerName), 'utf8'), f.readManifest().fingerprint);
});

test('unwritable optional evidence does not disable new or seeded engines or overwrite user dependencies', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.config, manifestName), { recursive: true });
  assert.doesNotThrow(() => f.prepare());
  assert.equal(readFileSync(join(f.config, markerName), 'utf8').length, 64);
  const custom = join(f.config, 'node_modules/@opencode-ai/plugin/dist/tool.js');
  write(custom, 'keep modified target');
  assert.doesNotThrow(() => f.prepare());
  assert.equal(readFileSync(custom, 'utf8'), 'keep modified target');
  assert(lstatSync(join(f.config, manifestName)).isDirectory(), 'Invalid evidence remains unavailable for backup optimization');
  f.assertNoTemporaryFiles();
});

test('required dependency preparation failures still propagate before an evidence file is committed', async t => {
  const f = await fixture(t);
  write(join(f.config, 'node_modules/fixture-dep'), 'blocking file');
  assert.throws(() => f.prepare());
  assert.equal(existsSync(join(f.config, manifestName)), false);
  assert.equal(existsSync(join(f.config, markerName)), false);
});
