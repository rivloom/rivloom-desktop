import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safeKnowledgeDirectory } from './knowledge-store.ts';

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
  if (existsSync(marker) && readFileSync(marker, 'utf8') === fingerprint && existsSync(join(config, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.js'))) return;
  for (const [path] of packages) {
    const source = join(modules, path); const target = join(config, 'node_modules', path);
    mkdirSync(target, { recursive: true }); safeKnowledgeDirectory(target);
    cpSync(source, target, { recursive: true, dereference: true,
      filter: (file) => !relative(source, file).split(/[\\/]/).includes('node_modules') });
  }
  const read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const manifestPath = join(config, 'package.json'); const manifest = read(manifestPath);
  const pluginVersion = packages.get(join('@opencode-ai', 'plugin')).version;
  manifest.dependencies = { ...manifest.dependencies, '@opencode-ai/plugin': pluginVersion };
  const lockPath = join(config, 'package-lock.json'); const lock = read(lockPath);
  lock.lockfileVersion = 3; lock.requires = true; lock.packages ||= {};
  lock.packages[''] = { ...lock.packages[''], dependencies: { ...lock.packages['']?.dependencies, '@opencode-ai/plugin': pluginVersion } };
  for (const [path, pkg] of packages) lock.packages[`node_modules/${path.split('\\').join('/')}`] = {
    version: pkg.version, ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  writeFileSync(marker, fingerprint);
}
