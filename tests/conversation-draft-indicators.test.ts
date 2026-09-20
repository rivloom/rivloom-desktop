import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasConversationDraft, conversationDraftKeys } from '../src/conversation-draft-indicators.ts';
import { createWorkflowDraft, clearSubmittedDraft, updateConversationDraft } from '../src/conversation-drafts.ts';

test('draft indicators include text and pending or failed attachments, without treating empty routing as content', () => {
  const empty = createWorkflowDraft();
  assert.equal(hasConversationDraft(undefined), false);
  assert.equal(hasConversationDraft(null), false);
  assert.equal(hasConversationDraft(empty), false);
  assert.equal(hasConversationDraft({ ...empty, text: '\n \t' }), false);
  assert.equal(hasConversationDraft({ ...empty, text: '检查输入' }), true);
  for (const state of ['preparing', 'uploading', 'complete', 'failed'] as const) {
    // All attachment states preserve user work; readiness is checked separately before sending.
    const draft = { ...empty, files: [{ id: 'attachment', file: new File(['x'], 'work.txt'), receivedBytes: 0, error: null, state }] };
    assert.equal(hasConversationDraft(draft), true);
  }
});

test('draft navigation follows visible conversation order and excludes hidden, retired and duplicate keys', () => {
  const content = updateConversationDraft(createWorkflowDraft(), { text: 'Saved' });
  const drafts = { new: content, 'workflow:a': content, 'workflow:b': content, 'workflow:retired': content, 'workflow:empty': createWorkflowDraft() };
  assert.deepEqual(conversationDraftKeys(drafts, ['workflow:b', 'workflow:a', 'workflow:a', 'workflow:empty']), ['new', 'workflow:b', 'workflow:a']);
  assert.deepEqual(conversationDraftKeys(drafts, []), ['new']);
  const sent = clearSubmittedDraft(drafts, 'workflow:a', content.requestID, createWorkflowDraft);
  assert.deepEqual(conversationDraftKeys(sent, ['workflow:a', 'workflow:b']), ['new', 'workflow:b']);
  assert.equal(hasConversationDraft(drafts['workflow:a']), true);
});
