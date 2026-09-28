import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { safeKnowledgeDirectory } from './knowledge-store.ts';

type DependencyFiles = {
  schemaVersion: 1;
  fingerprint: string;
  files: { path: string; bytes: number; sha256: string }[];
};
const filesManifest = '.rivloom-plugin-dependencies-files.json';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const maxFiles = 200_000;
const maxManifestBytes = 32 * 1024 * 1024;
const portablePath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('node_modules/') &&
  !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

function validFilesManifest(path: string, fingerprint: string) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxManifestBytes) return false;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || value.schemaVersion !== 1 || value.fingerprint !== fingerprint || !digest.test(value.fingerprint) ||
      Object.keys(value).sort().join(',') !== 'files,fingerprint,schemaVersion' ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > maxFiles) return false;
    const paths = new Set<string>();
    for (const file of value.files) {
      if (!file || Object.keys(file).sort().join(',') !== 'bytes,path,sha256' || !portablePath(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !digest.test(file.sha256)) return false;
      const key = file.path.toLowerCase();
      if (paths.has(key)) return false;
      paths.add(key);
    }
    return paths.has('node_modules/@opencode-ai/plugin/dist/index.js');
  } catch { return false; }
}

function sourceFiles(modules: string, packages: Map<string, any>, fingerprint: string): DependencyFiles {
  const files: DependencyFiles['files'] = [];
  for (const [packagePath] of packages) {
    const source = join(modules, packagePath);
    safeKnowledgeDirectory(source);
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        // Match the copy filter: nested dependencies are visited separately only
        // when they belong to the resolved bundled dependency graph.
        if (entry.name === 'node_modules') continue;
        const path = join(directory, entry.name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) throw new Error('knowledge_plugin_dependency_invalid');
        if (metadata.isDirectory()) { visit(path); continue; }
        if (!metadata.isFile()) throw new Error('knowledge_plugin_dependency_invalid');
        const name = ['node_modules', packagePath, relative(source, path)].join('/').replaceAll('\\', '/');
        if (!portablePath(name)) throw new Error('knowledge_plugin_dependency_invalid');
        const bytes = readFileSync(path);
        files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
        if (files.length > maxFiles) throw new Error('knowledge_plugin_dependency_invalid');
      }
    };
    visit(source);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schemaVersion: 1, fingerprint, files };
}

function writeFilesManifest(path: string, value: DependencyFiles) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('knowledge_plugin_dependency_invalid');
  }
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maxManifestBytes) throw new Error('knowledge_plugin_dependency_invalid');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: number | undefined;
  try {
    file = openSync(temporary, 'wx', 0o600);
    writeFileSync(file, bytes);
    fsyncSync(file);
    closeSync(file); file = undefined;
    renameSync(temporary, path);
  } finally {
    if (file !== undefined) closeSync(file);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

// OpenCode 1.18.25 waits for @opencode-ai/plugin installation even for a local plugin.
// Seed its managed global config from our locked desktop dependencies, without npm/network.
export function prepareEnginePluginDependencies(engineRoot: string) {
  const runtime = fileURLToPath(new URL('..', import.meta.url));
  // Isolated service checkouts use their containing repository's dependencies,
  // just as Node resolves imports. Keep every copied package inside that tree.
  let dependencyRoot = runtime;
  while (!existsSync(join(dependencyRoot, 'node_modules', '@opencode-ai', 'plugin', 'package.json'))) {
    const parent = dirname(dependencyRoot);
    if (parent === dependencyRoot) throw new Error('knowledge_plugin_dependency_missing');
    dependencyRoot = parent;
  }
  const modules = join(dependencyRoot, 'node_modules');
  const packages = new Map<string, any>();
  function collect(name: string, from: string) {
    let cursor = from; let source = '';
    while (true) {
      const candidate = join(cursor, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) { source = candidate; break; }
      const parent = dirname(cursor); if (parent === cursor) throw new Error('knowledge_plugin_dependency_missing'); cursor = parent;
    }
    const path = relative(modules, source);
    if (path.startsWith('..') || resolve(modules, path) !== source) throw new Error('knowledge_plugin_dependency_invalid');
    if (packages.has(path)) return;
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')); packages.set(path, pkg);
    for (const dependency of Object.keys(pkg.dependencies || {})) collect(dependency, source);
  }
  collect('@opencode-ai/plugin', runtime);
  const fingerprint = createHash('sha256').update(JSON.stringify([...packages].map(([p, v]) => [p, v.version]))).digest('hex');
  const config = join(engineRoot, 'config', 'opencode'); mkdirSync(config, { recursive: true }); safeKnowledgeDirectory(config);
  const marker = join(config, '.rivloom-plugin-dependencies');
  const manifest = join(config, filesManifest);
  const seeded = existsSync(marker) && readFileSync(marker, 'utf8') === fingerprint && existsSync(join(config, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.js'));
  if (seeded && validFilesManifest(manifest, fingerprint)) return;
  // Evidence comes from the immutable bundled source, never the user's tree.
  // Adding evidence for an older seed must not overwrite customized dependencies.
  const recordFiles = () => {
    try { writeFilesManifest(manifest, sourceFiles(modules, packages, fingerprint)); }
    catch { /* Optional backup evidence: missing or invalid proof keeps the full backup. */ }
  };
  if (seeded) { recordFiles(); return; }
  for (const [path] of packages) {
    const source = join(modules, path); const target = join(config, 'node_modules', path);
    mkdirSync(target, { recursive: true }); safeKnowledgeDirectory(target);
    cpSync(source, target, { recursive: true, dereference: true,
      filter: (file) => !relative(source, file).split(/[\\/]/).includes('node_modules') });
  }
  const read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const manifestPath = join(config, 'package.json'); const packageManifest = read(manifestPath);
  const pluginVersion = packages.get(join('@opencode-ai', 'plugin')).version;
  packageManifest.dependencies = { ...packageManifest.dependencies, '@opencode-ai/plugin': pluginVersion };
  const lockPath = join(config, 'package-lock.json'); const lock = read(lockPath);
  lock.lockfileVersion = 3; lock.requires = true; lock.packages ||= {};
  lock.packages[''] = { ...lock.packages[''], dependencies: { ...lock.packages['']?.dependencies, '@opencode-ai/plugin': pluginVersion } };
  for (const [path, pkg] of packages) lock.packages[`node_modules/${path.split('\\').join('/')}`] = {
    version: pkg.version, ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
  };
  writeFileSync(manifestPath, JSON.stringify(packageManifest, null, 2)); writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  writeFileSync(marker, fingerprint);
  recordFiles();
}
