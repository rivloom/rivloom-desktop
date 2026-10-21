import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { applyMacosSourceOverlay, portableInventoryDigest, transformSource } from '../scripts/runtime-macos/source-overlay.mjs';
import { sourceInventory } from '../scripts/runtime-macos/artifact.mjs';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rivloom-source-overlay-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(!lstatSync(directory).isSymbolicLink()); rmSync(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'core'), recipe = join(directory, 'recipe'), stage = join(directory, 'artifact');
  mkdirSync(join(root, 'packages/core/src'), { recursive: true }); mkdirSync(recipe); mkdirSync(stage);
  const file = join(root, 'packages/core/src/cross-spawn-spawner.ts');
  const original = 'export const spawn = "original";\n', changed = 'export const spawn = "guarded";\n', guard = 'export const guard = true;\n';
  writeFileSync(file, original);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'core.autocrlf', 'false'); git('add', '--', 'packages/core/src/cross-spawn-spawner.ts');
  git('-c', 'user.name=Overlay Fixture', '-c', 'user.email=overlay@example.invalid', 'commit', '-m', 'Synthetic overlay fixture');
  const base = sourceInventory(root, true);
  const patch = { schemaVersion: 1, target: 'darwin-arm64', baseCommit: base.commit,
    files: [{ path: 'packages/core/src/cross-spawn-spawner.ts', beforeSHA256: hash(original), afterSHA256: hash(changed), edits: [{ before: '"original"', after: '"guarded"' }] }],
    additions: [{ path: 'packages/core/src/rivloom-macos-guard.ts', source: 'spawn-guard.ts', sha256: hash(guard) }] };
  writeFileSync(join(recipe, 'core-spawn.patch.json'), json(patch)); writeFileSync(join(recipe, 'spawn-guard.ts'), guard);
  return { root, recipe, stage, base, file, original, changed, patch };
}

test('Exact Mac overlay packages actual compiler inputs and restores the complete clean snapshot', t => {
  const value = fixture(t), overlay = applyMacosSourceOverlay(value.root, value.recipe, value.base);
  assert.equal(readFileSync(value.file, 'utf8'), value.changed);
  assert.equal(overlay.compiled.dirty, true); assert.equal(overlay.compiled.files.length, value.base.files.length + 1);
  overlay.verify(); overlay.package(value.stage);
  const receipt = JSON.parse(readFileSync(join(value.stage, 'macos-source-overlay.json'), 'utf8'));
  assert.equal(receipt.baseInventorySHA256, portableInventoryDigest(value.base.files));
  assert.equal(receipt.compiledInventorySHA256, portableInventoryDigest(overlay.compiled.files));
  assert.equal(readFileSync(join(value.stage, 'macos-cross-spawn-spawner.ts'), 'utf8'), value.changed);
  overlay.restore();
  assert.equal(readFileSync(value.file, 'utf8'), value.original);
  assert.equal(existsSync(join(value.root, 'packages/core/src/rivloom-macos-guard.ts')), false);
  assert.deepEqual(sourceInventory(value.root, true), value.base);
});

test('Mac overlay refuses mismatched hashes and ambiguous edits before changing source', t => {
  const value = fixture(t);
  const original = Buffer.from(value.original);
  assert.throws(() => transformSource(original, { ...value.patch.files[0], beforeSHA256: hash('wrong') }), /base bytes/);
  assert.throws(() => transformSource(original, { ...value.patch.files[0], afterSHA256: hash('wrong') }), /result differs/);
  assert.throws(() => transformSource(original, { ...value.patch.files[0], edits: [{ before: 'missing', after: 'new' }] }), /exactly once/);
  writeFileSync(join(value.recipe, 'spawn-guard.ts'), 'unreviewed module');
  assert.throws(() => applyMacosSourceOverlay(value.root, value.recipe, value.base), /module differs/);
  assert.deepEqual(sourceInventory(value.root, true), value.base);
});

test('Mac overlay detects unrelated compilation changes and preserves changed overlay files for diagnosis', t => {
  const value = fixture(t), overlay = applyMacosSourceOverlay(value.root, value.recipe, value.base);
  writeFileSync(value.file, 'unexpected concurrent change');
  assert.throws(() => overlay.verify(), /outside the exact/);
  assert.throws(() => overlay.restore(), /Preserving unexpectedly modified/);
  assert.equal(readFileSync(value.file, 'utf8'), 'unexpected concurrent change');
});
