import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciRoot, environmentRecord, saveReport } from './ci-workspace.ts';
import { releaseVersionSchema } from './release-record.ts';

export function checkVersions(root = ciRoot) {
  const json = (file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const packageManifest = json('package.json');
  const lock = json('package-lock.json');
  const tauri = json('src-tauri/tauri.conf.json');
  const preview = json('src-tauri/tauri.preview.conf.json');
  const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoLock = readFileSync(resolve(root, 'src-tauri/Cargo.lock'), 'utf8');
  const cargoPackage = cargo.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  assert(cargoPackage, 'Missing Cargo [package] table');
  const cargoVersion = cargoPackage.match(/^version\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
  releaseVersionSchema.parse(packageManifest.version);
  const lockedApp = cargoLock
    .split(/^\[\[package\]\]\s*$/m)
    .filter((entry) => /^name = "rivloom-desktop"\s*$/m.test(entry));
  assert.equal(lockedApp.length, 1, 'Cargo.lock must contain exactly one desktop package');
  const cargoLockedVersion = lockedApp[0]!.match(/^version = "([^"\r\n]+)"\s*$/m)?.[1];
  const versions = {
    package: packageManifest.version,
    lock: lock.version,
    lockRoot: lock.packages?.['']?.version,
    cargo: cargoVersion,
    cargoLock: cargoLockedVersion,
    tauri: tauri.version,
    preview: preview.version ?? tauri.version,
  };
  for (const [source, version] of Object.entries(versions)) {
    assert.equal(version, packageManifest.version, `Application version mismatch: ${source}`);
  }
  assert.equal(tauri.identifier, 'com.rivloom.desktop', 'Unexpected formal product identifier');
  assert.equal(tauri.productName, 'Rivloom', 'Unexpected desktop product name');
  assert.equal(
    preview.identifier,
    'com.rivloom.conversationpreview',
    'Unexpected preview product identifier',
  );
  assert.notEqual(tauri.identifier, preview.identifier, 'Preview must keep its separate identity');
  return { versions, identifiers: { desktop: tauri.identifier, preview: preview.identifier } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkVersions();
  await saveReport('versions', { status: 'passed', environment: environmentRecord(), ...result });
  console.log(
    `Application versions agree: ${result.versions.package}; desktop and preview identities remain separate.`,
  );
}
