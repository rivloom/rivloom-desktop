import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotedMessageText, splitQuotedMessage, validMessageQuote } from '../src/message-quote.ts';
import { createConversationDraft, conversationInputUsage, updateConversationDraft, prepareConversationRequest, clearSubmittedDraft } from '../src/conversation-drafts.ts';
import { applyMessageReuse } from '../src/message-reuse.ts';
import { encodeDrafts, decodeDrafts } from '../src/draft-storage.ts';
import { hasConversationDraft } from '../src/conversation-draft-indicators.ts';

test('quote transport roundtrips lines, code, nested quotes and Unicode without changing the body', () => {
  for (const author of ['assistant', 'user'] as const) for (const text of ['Hello', 'First\n\nLast\n', '```js\n🙂\n```', '> nested\n> [User]\n\nreply', '\nLeading\n\n']) {
    const quote = { text, author }, body = 'Follow up\n\n> my own quote';
    assert.deepEqual(splitQuotedMessage(quotedMessageText(body, quote)), { text: body, quote });
  }
  assert.deepEqual(splitQuotedMessage(quotedMessageText('Body', { text: 'A\r\n\rB', author: 'user' })), { text: 'Body', quote: { text: 'A\n\nB', author: 'user' } });
});
test('ordinary Markdown and incomplete envelopes are preserved', () => {
  for (const text of ['> quote\n\nbody', '> [Someone]\n> quote\n\nbody', '> [Rivloom]\nbody', 'prefix\n> [User]\n> quote\n\nbody']) assert.deepEqual(splitQuotedMessage(text), { text });
  assert.equal(quotedMessageText('original'), 'original');
});
test('adding and replacing a quote preserves body, routing, model and files and rejects stale actions', () => {
  const draft = { ...createConversationDraft(), text: 'Keep my own words', model: 'preview/model' };
  const intent = { mode: 'quote' as const, placement: 'append' as const, text: 'First quote', expectedDraft: { text: draft.text, requestID: draft.requestID } };
  const first = applyMessageReuse(draft, intent, true); assert(first.ok);
  const next = applyMessageReuse(first.draft, { ...intent, text: 'Replacement', quoteAuthor: 'user', expectedDraft: first.draft }, true); assert(next.ok);
  assert.equal(next.draft.text, draft.text); assert.equal(next.draft.files, draft.files); assert.equal(next.draft.routing, draft.routing); assert.equal(next.draft.model, draft.model);
  assert.deepEqual(next.draft.quote, { text: 'Replacement', author: 'user' });
  assert.deepEqual(applyMessageReuse(first.draft, intent, true), { ok: false, reason: 'draft-changed' });
  assert.equal(draft.quote, undefined);
});
test('retry identity includes the quote; removal changes identity and old completion cannot clear a newer draft', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Comment', quote: { text: 'Source', author: 'assistant' } });
  const prepared = prepareConversationRequest(draft, { confirmed: true });
  assert.equal(prepareConversationRequest(prepared, { confirmed: true }).requestID, prepared.requestID);
  const removed = updateConversationDraft(prepared, { quote: null });
  assert.notEqual(removed.requestID, prepared.requestID); assert.equal(removed.text, 'Comment'); assert.equal(removed.requestSignature, undefined);
  assert.equal(clearSubmittedDraft({ new: removed }, 'new', prepared.requestID).new, removed);
  const cleared = clearSubmittedDraft({ new: prepared }, 'new', prepared.requestID).new;
  assert.equal(cleared.text, ''); assert.equal(cleared.quote, undefined);
});
test('editing a sent reply restores its quote separately; quoting that reply selects its own words', () => {
  const draft = createConversationDraft(), quote = { text: 'Source', author: 'assistant' as const };
  const intent = { mode: 'reuse' as const, placement: 'append' as const, text: quotedMessageText('My reply', quote), expectedDraft: draft };
  const edit = applyMessageReuse(draft, intent, true); assert(edit.ok);
  assert.equal(edit.draft.text, 'My reply'); assert.deepEqual(edit.draft.quote, quote);
  const quoted = applyMessageReuse(draft, { ...intent, mode: 'quote', quoteAuthor: 'user' }, true); assert(quoted.ok);
  assert.deepEqual(quoted.draft.quote, { text: 'My reply', author: 'user' }); assert.equal(quoted.draft.text, '');
});
test('length limits count the quote envelope and UTF-16, and reject excess before allocation', () => {
  const draft = createConversationDraft(), quote = { text: '🙂', author: 'assistant' as const };
  const overhead = quotedMessageText('', quote).length;
  draft.text = 'x'.repeat(12000 - overhead);
  const exact = { ...draft, quote }; assert.equal(conversationInputUsage(exact, true).length, 12000);
  assert.equal(conversationInputUsage(exact, true).overLimit, false);
  const result = applyMessageReuse(draft, { mode: 'quote', placement: 'append', text: '🙂x', expectedDraft: draft }, true, () => { throw new Error('must not allocate'); });
  assert.deepEqual(result, { ok: false, reason: 'too-long', length: 12001, limit: 12000 });
});
test('quote-only drafts are discoverable and persist; malformed quotes do not erase the body', () => {
  const draft = updateConversationDraft(createConversationDraft(), { quote: { text: 'Saved source', author: 'assistant' } });
  assert.equal(hasConversationDraft(draft), true);
  const saved = encodeDrafts({ savedAt: 23, drafts: { new: draft } });
  assert.deepEqual(decodeDrafts(saved).drafts.new.quote, draft.quote);
  assert.equal(decodeDrafts(saved).drafts.new.requestID, draft.requestID);
  const malformed = JSON.parse(saved); malformed.drafts.new.text = 'Keep body'; malformed.drafts.new.quote.author = 'unknown';
  const recovered = decodeDrafts(JSON.stringify(malformed)).drafts.new;
  assert.equal(recovered.text, 'Keep body'); assert.equal(recovered.quote, undefined); assert.notEqual(recovered.requestID, draft.requestID);
  for (const value of [null, {}, { text: ' ', author: 'user' }, { text: 'x'.repeat(12001), author: 'assistant' }]) assert.equal(validMessageQuote(value), false);
});
