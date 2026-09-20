import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('OAuth staging uses a separate pinned engine and cleans it without changing main credentials', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rivloom-oauth-engine-'));
  process.env.RIVLOOM_DATA_DIR = root;
  const mainAuth = join(root, 'engine', 'data', 'opencode'); mkdirSync(mainAuth, { recursive: true });
  const sentinel = JSON.stringify({ synthetic: { type: 'api', key: 'existing-synthetic-key' } });
  writeFileSync(join(mainAuth, 'auth.json'), sentinel);
  const { isolatedOAuthDriver } = await import('../server/provider-oauth.ts');
  const driver = await isolatedOAuthDriver();
  try {
    const staging = readdirSync(join(root, 'oauth-staging')); assert.equal(staging.length, 1);
    const config = readFileSync(join(root, 'oauth-staging', staging[0], 'engine', 'rivloom-providers.json'), 'utf8');
    assert(!config.includes('existing-synthetic-key'));
    assert.equal(readFileSync(join(mainAuth, 'auth.json'), 'utf8'), sentinel);
  } finally { await driver.close(); }
  assert.deepEqual(readdirSync(join(root, 'oauth-staging')), []);
  assert.equal(readFileSync(join(mainAuth, 'auth.json'), 'utf8'), sentinel);
});
