import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';
import {
  createConversationDraft,
  prepareConversationRequest,
  updateConversationDraft,
} from '../src/conversation-drafts.ts';

test('creation timeout aborts waiting and preserves the original request for retry', async (t) => {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1)
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        ),
      );
    return new Response(JSON.stringify({ createdTaskID: 'exact-task' }), { status: 200 });
  });
  const draft = prepareConversationRequest(
    updateConversationDraft(createConversationDraft(), {
      text: '检查原任务',
      routing: { kind: 'node', nodeID: 'original-node', name: '同名工作站' },
    }),
    { description: '检查原任务' },
  );
  const body = { description: draft.text, requestID: draft.requestID };
  await assert.rejects(
    api('/network/nodes/original-node/tasks', body, { timeoutMilliseconds: 5 }),
    /请求超时.*结果尚未确认/,
  );
  const retry = prepareConversationRequest(draft, { description: '检查原任务' });
  assert.equal(retry.requestID, draft.requestID);
  const result = await api<{ createdTaskID: string }>(
    '/network/nodes/original-node/tasks',
    { description: retry.text, requestID: retry.requestID },
    { timeoutMilliseconds: 1000 },
  );
  assert.equal(result.createdTaskID, 'exact-task');
  assert.equal(bodies[0], bodies[1]);
});

test('known conflicts retain their status so an unknown queue operation is not mistaken for rejection', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ error: '队列已变化' }), { status: 409 }),
  );
  await assert.rejects(
    api('/node-queue/task/control', {}),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('connection closed after commit');
  });
  await assert.rejects(
    api('/node-queue/task/control', {}),
    (error: unknown) => !(error instanceof ApiError),
  );
});
