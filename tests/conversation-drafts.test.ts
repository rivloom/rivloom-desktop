import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationDraft,
  conversationCreationNeedsModel,
  updateConversationDraft,
  prepareConversationRequest,
  clearSubmittedDraft,
  createdConversationKey,
} from '../src/conversation-drafts.ts';

test('switching conversations restores text, exact Node ID and creation request', () => {
  const draft = updateConversationDraft(
    createConversationDraft('request-1'),
    {
      text: '@共享工作站 帮我检查',
      routing: { kind: 'node', nodeID: 'node-a', name: '共享工作站' },
    },
    () => 'request-2',
  );
  const drafts = { new: draft, 'local:old': createConversationDraft('request-old') };
  assert.equal(drafts['local:old'].text, '');
  assert.deepEqual(drafts.new, draft);
  assert.equal(drafts.new.routing.kind === 'node' && drafts.new.routing.nodeID, 'node-a');
  assert.equal(drafts.new.requestID, 'request-2');
});

test('same names, renamed Nodes, missing directory and removed mention text do not change routing', () => {
  const bound = updateConversationDraft(createConversationDraft(), {
    text: '@共享工作站 执行',
    routing: { kind: 'node', nodeID: 'node-a', name: '共享工作站' },
  });
  const renamed = updateConversationDraft(bound, {
    routing: { kind: 'node', nodeID: 'node-a', name: '新名称（新备注）' },
  });
  assert.equal(renamed.requestID, bound.requestID);
  assert.equal(renamed.routing.kind === 'node' && renamed.routing.nodeID, 'node-a');
  const edited = updateConversationDraft(renamed, { text: '删除 @ 文本后继续执行' });
  assert.equal(edited.routing.kind === 'node' && edited.routing.nodeID, 'node-a');
  const sameNameOtherNode = updateConversationDraft(bound, {
    routing: { kind: 'node', nodeID: 'node-b', name: '共享工作站' },
  });
  assert.notEqual(sameNameOtherNode.requestID, bound.requestID);
  const cancelled = updateConversationDraft(bound, { routing: { kind: 'local' } });
  assert.deepEqual(cancelled.routing, { kind: 'local' });
  assert.notEqual(cancelled.requestID, bound.requestID);
});

test('lost HTTP responses and refresh failures retry the same logical request', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: '执行这项工作' });
  const first = prepareConversationRequest(draft, { projectID: 'p', criteria: '核对结果' });
  const retry = prepareConversationRequest(first, { criteria: '核对结果', projectID: 'p' });
  assert.equal(retry.requestID, first.requestID);
  assert.equal(retry.requestSignature, first.requestSignature);
  const newSettings = prepareConversationRequest(retry, {
    projectID: 'another',
    criteria: '核对结果',
  });
  assert.notEqual(newSettings.requestID, first.requestID);
  const edited = updateConversationDraft(retry, { text: '另一项工作' });
  assert.notEqual(edited.requestID, first.requestID);
  const whitespace = updateConversationDraft(first, { text: '  执行这项工作  ' });
  assert.equal(whitespace.requestID, first.requestID);
});

test('creation success clears only its own draft and opens only the exact returned ID', () => {
  const submitted = createConversationDraft('request-1');
  const edited = updateConversationDraft(submitted, { text: '另一项工作' });
  const drafts = { new: edited, old: submitted };
  assert.equal(clearSubmittedDraft(drafts, 'new', submitted.requestID), drafts);
  assert.equal(clearSubmittedDraft(drafts, 'old', submitted.requestID).old.text, '');
  assert.equal(
    createdConversationKey({ kind: 'node', nodeID: 'node-a', name: 'A' }, 'exact'),
    'remote:exact',
  );
  assert.equal(createdConversationKey({ kind: 'automatic' }, 'exact'), 'brain:exact');
  assert.equal(createdConversationKey({ kind: 'local' }, 'exact'), 'local:exact');
  assert.throws(() => createdConversationKey({ kind: 'automatic' }, ''), /没有返回/);
});

test('a lost local creation response can be confirmed after model disappearance; edited work needs a model again', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: '原本机工作' });
  assert.equal(conversationCreationNeedsModel(draft), true);
  const sent = prepareConversationRequest(draft, {
    model: 'provider/removed-model',
    projectID: 'original-project',
  });
  assert.equal(conversationCreationNeedsModel(sent), false);
  const retry = prepareConversationRequest(sent, {
    model: 'provider/removed-model',
    projectID: 'original-project',
  });
  assert.equal(retry.requestID, sent.requestID);
  assert.equal(retry.requestSignature, sent.requestSignature);
  assert.equal(
    conversationCreationNeedsModel(updateConversationDraft(sent, { text: '另一项工作' })),
    true,
  );
});
