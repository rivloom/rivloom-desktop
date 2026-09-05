import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ciRoot = resolve(import.meta.dirname, '..');

export async function isolatedWorkspace(label: string, root = ciRoot) {
  if (!/^[a-z][a-z0-9-]*$/.test(label)) throw new Error('Invalid CI workspace label');
  const base = join(root, 'test-results', 'ci-workspaces');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, `${label}-`));
  // Some existing regression fixtures expect this report parent to exist.
  // Create it only inside this new workspace, never in an existing data root.
  await mkdir(join(directory, '.data', 'verification'), { recursive: true });
  for (const source of ['server', 'shared', 'scripts', 'package.json']) {
    await cp(join(root, source), join(directory, source), { recursive: true });
  }
  if (existsSync(join(root, 'dist')))
    await cp(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  // Dependencies resolve through the containing repository's node_modules. No junction,
  // credentials, existing .data, runtime output, or original verification reports are copied.
  return directory;
}

export function testEnvironment(directory: string): NodeJS.ProcessEnv {
  const systemNames = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    // Keep Windows PowerShell module discovery available to Add-Type in CI children.
    'PSMODULEPATH',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SYSTEMDRIVE',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'NUMBER_OF_PROCESSORS',
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => systemNames.has(name.toUpperCase())),
  );
  return { ...environment, CI: 'true', RIVLOOM_DATA_DIR: join(directory, '.data', 'default') };
}

export async function saveReport(name: string, report: object) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid CI report name');
  const directory = join(ciRoot, 'test-results', 'ci');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`CI summary: ${path}`);
}

export function environmentRecord() {
  return {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    commit: process.env.GITHUB_SHA || null,
    runnerImage: process.env.ImageOS || null,
    runnerImageVersion: process.env.ImageVersion || null,
    cloudRun: process.env.GITHUB_ACTIONS === 'true',
  };
}
