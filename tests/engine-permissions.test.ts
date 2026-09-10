import test from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionRequest } from '@opencode-ai/sdk/v2';
import { EnginePermissionEvents } from '../server/engine-permissions.ts';

const request = (id: string, sessionID = 'current'): PermissionRequest => ({ id, sessionID, permission: 'webfetch',
  patterns: ['https://example.invalid'], metadata: { url: 'https://example.invalid', format: 'text' }, always: ['*'] });
const broken = async (): Promise<PermissionRequest[]> => { throw new Error('Optional metadata could not be encoded'); };
test('a live official permission event survives a list encoding failure, scoped to its session and directory', async () => {
  const events = new EnginePermissionEvents(); events.open('project'); events.asked('project', request('real-id'));
  const pending = await events.read('project', 'current', broken);
  assert.deepEqual(pending, [request('real-id')]); pending[0].metadata.changed = true;
  assert.deepEqual(await events.read('project', 'current', broken), [request('real-id')]);
  await assert.rejects(events.read('other', 'current', broken));
  await assert.rejects(events.read('project', 'other-session', broken));
  events.replied('project', 'real-id'); await assert.rejects(events.read('project', 'current', broken));
});
test('disconnect, stream replacement and an unreadable empty list never invent or retain an approval', async () => {
  const events = new EnginePermissionEvents(); const old = events.open('project'); events.asked('project', request('before-disconnect'));
  events.close('project'); await assert.rejects(events.read('project', 'current', broken));
  events.open('project'); await assert.rejects(events.read('project', 'current', broken));
  events.asked('project', request('late-old-event'), old); await assert.rejects(events.read('project', 'current', broken));
  events.close('project', old);
  events.asked('project', request('resolved')); assert.deepEqual(await events.read('project', 'current', async () => []), []);
  await assert.rejects(events.read('project', 'current', broken));
});
test('a delayed list cannot overwrite a newer permission event or use a replacement stream as its fallback', async () => {
  const events = new EnginePermissionEvents(); events.open('project');
  let finish!: (requests: PermissionRequest[]) => void;
  const reading = events.read('project', 'current', () => new Promise((resolve) => { finish = resolve; }));
  events.asked('project', request('new')); finish([]); await reading;
  assert.deepEqual(await events.read('project', 'current', broken), [request('new')]);
  let fail!: (error: Error) => void;
  const oldStream = events.read('project', 'current', () => new Promise((_resolve, reject) => { fail = reject; }));
  events.open('project'); events.asked('project', request('replacement'));
  fail(new Error('Disconnected')); await assert.rejects(oldStream, /Disconnected/);
});
