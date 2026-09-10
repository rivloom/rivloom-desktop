import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSignedUpdate, verifyUpdateArtifact, verifyUpdaterSignature, compareUpdateVersion, officialUpdateURL } from './updater-manifest.ts';
const fixture = new URL('../tests/fixtures/updater/', import.meta.url);
const publicKey = readFileSync(new URL('public.pub', fixture), 'utf8');
const bytes = readFileSync(new URL('artifact.txt', fixture));
const manifest = () => JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8'));

test('official Tauri signatures bind the installer, metadata, version and release URL', () => {
  const parsed = parseSignedUpdate(manifest(), publicKey);
  verifyUpdateArtifact(bytes, parsed.metadata, publicKey);
  assert.equal(parsed.metadata.version, '0.1.5');
  assert.equal(officialUpdateURL(parsed.metadata.url, '0.1.5'), true);
  assert.equal(compareUpdateVersion('0.1.10', '0.1.9'), 1);
  assert.equal(compareUpdateVersion('0.1.9', '0.1.10'), -1);
});

test('old valid installer signatures cannot be relabelled or redirected', () => {
  for (const change of [
    (m: any) => { m.version = '999.0.0'; },
    (m: any) => { m.platforms['windows-x86_64'].url = 'https://evil.example/installer.exe'; },
    (m: any) => { m.notes = '<script>evil()</script>'; },
    (m: any) => { const payload = JSON.parse(Buffer.from(m.rivloom.payload, 'base64').toString()); payload.version = '999.0.0'; m.rivloom.payload = Buffer.from(JSON.stringify(payload)).toString('base64'); },
    (m: any) => { m.platforms['windows-aarch64'] = m.platforms['windows-x86_64']; },
    (m: any) => { m.rivloom.signature = m.platforms['windows-x86_64'].signature; },
  ]) { const value = manifest(); change(value); assert.throws(() => parseSignedUpdate(value, publicKey)); }
});

test('damaged files, a foreign key and a changed signed comment are rejected', () => {
  const parsed = parseSignedUpdate(manifest(), publicKey);
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 1;
  assert.throws(() => verifyUpdateArtifact(corrupted, parsed.metadata, publicKey));
  const alteredKey = Buffer.from(publicKey.trim(), 'base64').toString().split('\n');
  const key = Buffer.from(alteredKey[1], 'base64'); key[key.length - 1] ^= 1; alteredKey[1] = key.toString('base64');
  assert.throws(() => parseSignedUpdate(manifest(), Buffer.from(alteredKey.join('\n')).toString('base64')));
  const comment = Buffer.from(parsed.metadata.signature, 'base64').toString().replace('\ntrusted comment: ', '\ntrusted comment: changed ');
  assert.throws(() => verifyUpdaterSignature(bytes, Buffer.from(comment).toString('base64'), publicKey));
});

test('only canonical stable versions and immutable official Windows assets are valid', () => {
  for (const bad of ['1.0.0-beta.1', '01.2.3', '1.0.0+build', '1.0.0\n']) assert.throws(() => compareUpdateVersion(bad, '0.1.4'));
  const good = parseSignedUpdate(manifest(), publicKey).metadata.url;
  for (const bad of [good.replace('https:', 'http:'), `${good}?evil=1`, `${good}#fragment`, good.replace('/releases/', '/previews/'), good.replace('-123/', '-0123/')])
    assert.equal(officialUpdateURL(bad, '0.1.5'), false);
});
