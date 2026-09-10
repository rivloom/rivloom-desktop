import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, isAbsolute } from 'node:path';
import { probeResourceCapabilities, ResourceCapabilityCache } from '../server/resource-capabilities.ts';
import { jsonBytes } from '../shared/collaboration.ts';
import { validSoftwareEvidence, resourceFreshMilliseconds, type SoftwareEvidence } from '../shared/resources.ts';

test('minute catalog scans keep software evidence fresh through the next peer sync even when probes take time', async () => {
  let at = 0, calls = 0;
  const cache = new ResourceCapabilityCache(() => at);
  const probe = async (): Promise<SoftwareEvidence[]> => {
    calls++;
    const checkedAt = new Date(at).toISOString(); at += 400;
    return [{ id: 'python', name: 'Python', kind: 'software', status: 'available', version: '3', checkedAt }];
  };
  const initial = await cache.get('same-project-and-models', probe);
  at = 15_000; assert.equal(await cache.get('same-project-and-models', probe), initial, 'file changes reuse a recent probe');
  at = 60_000; const refreshed = await cache.get('same-project-and-models', probe);
  assert.equal(calls, 2, 'the next periodic scan must run a new probe');
  // Physical regression: the old 60s cache was still valid until 60.4s, so this
  // scan reused time zero; a dispatch at 121.3s then falsely lost Python.
  at = 121_309; assert(at - Date.parse(refreshed[0].checkedAt) < resourceFreshMilliseconds);
  const next = await cache.get('same-project-and-models', probe); assert.equal(calls, 3);
  at = 140_000; assert(at - Date.parse(next[0].checkedAt) < resourceFreshMilliseconds);
});

test('a configuration change probes immediately and an older pending probe cannot overwrite the new cache', async () => {
  let at = 0; const cache = new ResourceCapabilityCache(() => at);
  const evidence = (id: string): SoftwareEvidence[] => [{ id, name: id, kind: 'software', status: 'available', version: '1', checkedAt: new Date(at).toISOString() }];
  let release!: (value: SoftwareEvidence[]) => void;
  const older = cache.get('old-project', () => new Promise<SoftwareEvidence[]>(resolve => { release = resolve; }));
  at = 100; const current = evidence('python'); assert.equal(await cache.get('new-project', async () => current), current);
  release(evidence('git')); await older;
  assert.equal(await cache.get('new-project', async () => { throw new Error('fresh cache was overwritten'); }), current);
});

test('software discovery invokes only fixed version probes outside the workspace and distinguishes failures from absence', async () => {
  const workspace = join(process.cwd(), '.data/verification/capability-scope');
  let calls = 0;
  const evidence = await probeResourceCapabilities(workspace, process.cwd(), [], async (file, args) => {
    assert(isAbsolute(file)); assert(!file.startsWith(workspace));
    assert(args.length === 1 && ['--version', '-version'].includes(args[0])); calls++; throw new Error('probe timed out');
  });
  assert(calls > 0); assert(evidence.every(validSoftwareEvidence));
  assert(evidence.every((value) => ['unavailable', 'unknown'].includes(value.status)));
  assert(evidence.some((value) => value.status === 'unknown'));
  const models = Array.from({ length: 100 }, (_, i) => ({ id: `provider/${i}-${'model'.repeat(40)}`, name: '模型'.repeat(60) }));
  const bounded = await probeResourceCapabilities(workspace, process.cwd(), models, async () => 'v1.2.3');
  assert(jsonBytes(bounded) <= 10_000); assert(bounded.length <= 40); assert(bounded.every(validSoftwareEvidence));
  assert(bounded.some((value) => value.kind === 'model' && value.status === 'available'));
});
