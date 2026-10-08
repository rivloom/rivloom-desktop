import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyFullSource } from './verify-full-source.mjs';

const root = new URL('./', import.meta.url);
const json = async name => JSON.parse((await readFile(new URL(name, root), 'utf8')).replace(/^\uFEFF/, ''));
export const source = await json('release-source.json');
assert.equal(source.version, '0.1.30');
assert.match(source.commit, /^[a-f0-9]{40}$/);
assert.match(String(source.runs?.linux), /^[1-9]\d+$/);
assert.match(String(source.linuxArtifactID), /^[1-9]\d+$/);
assert.equal(source.gates, 'passed', 'Wait for immutable same-source CI gates before acceptance.');
export const preparation = await json('preparation.json');
assert.equal(preparation.commit, source.commit);
assert.equal(preparation.status, 'bound-to-passed-immutable-source');
for (const name of ['download-record.ts', 'linux-download-record.ts', 'engine-artifact.ts', 'engine-source-linux.json', 'source-package-lock.json', 'linux-build.ts', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) {
  assert.equal(preparation.files.filter(file => file.destination === `public-source/${name}`).length, 1, `Missing immutable acceptance input: ${name}`);
}
for (const file of preparation.files.filter(file => file.destination.startsWith('public-source/'))) {
  const path = new URL(file.destination, root), info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink());
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), file.sha256, `Verification source changed: ${file.destination}`);
}
assert(preparation.fullSource, 'A ten-file helper snapshot is insufficient: bind every tracked final-commit source file.');
assert.equal(preparation.fullSource.packageLockSHA256, preparation.files.find(file => file.destination === 'public-source/source-package-lock.json').sha256);
await verifyFullSource(source, preparation.fullSource);
