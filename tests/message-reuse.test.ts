import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationDraft } from '../src/conversation-drafts.ts';
import { applyMessageReuse, reuseMessageText, type MessageReuseIntent } from '../src/message-reuse.ts';

function draft(text = ''): ConversationDraft { return { text, requestID: 'old-request', requestSignature: 'issued-request', routing: { kind: 'workflow', target: { mode: 'locked', nodeID: 'target' } }, files: [] }; }
function intent(value: ConversationDraft, extra: Partial<MessageReuseIntent> = {}): MessageReuseIntent {
  return { text: 'Original requirement', mode: 'reuse', placement: 'append', expectedDraft: { text: value.text, requestID: value.requestID }, ...extra };
}
test('reuse appends without changing the original message, draft, routing or files and creates fresh submission identity', () => {
  const value = draft('Keep my draft'), before = structuredClone(value), request = intent(value), source = structuredClone(request);
  const result = applyMessageReuse(value, request, true, () => 'new-request');
  assert(result.ok); assert.equal(result.draft.text, 'Keep my draft\n\nOriginal requirement');
  assert.equal(result.draft.routing, value.routing); assert.equal(result.draft.files, value.files);
  assert.equal(result.draft.requestID, 'new-request'); assert.equal(result.draft.requestSignature, undefined);
  assert.deepEqual(value, before); assert.deepEqual(request, source);
});
test('replacing a nonempty draft requires explicit confirmation, even for whitespace drafts', () => {
  for (const text of ['Existing work', '  ']) {
    const value = draft(text), request = intent(value, { placement: 'replace' });
    assert.deepEqual(applyMessageReuse(value, request, true), { ok: false, reason: 'confirmation-required' });
    const result = applyMessageReuse(value, { ...request, replaceConfirmed: true }, true, () => 'new');
    assert(result.ok); assert.equal(result.draft.text, request.text);
  }
});
test('stale draft identity or edited text cannot be overwritten by an open reuse dialog', () => {
  const value = draft('Keep'), request = intent(value, { placement: 'replace', replaceConfirmed: true });
  assert.deepEqual(applyMessageReuse({ ...value, text: 'More recent typing' }, request, true), { ok: false, reason: 'draft-changed' });
  assert.deepEqual(applyMessageReuse({ ...value, requestID: 'another-request' }, request, true), { ok: false, reason: 'draft-changed' });
});
test('quotes preserve text, blank lines and code delimiters while exposing the added length', () => {
  const source = 'Hello\r\n\r\n```js\n🙂\n```';
  assert.equal(reuseMessageText(source, 'quote'), '> Hello\n> \n> ```js\n> 🙂\n> ```\n\n');
  const value = draft(), result = applyMessageReuse(value, intent(value, { text: source, mode: 'quote' }), true, () => 'new');
  assert(result.ok); assert.equal(result.length, result.draft.text.length); assert.equal(result.limit, 12000);
});
test('input limits reject oversize source or append atomically, without silent truncation or new request allocation', () => {
  let identities = 0;
  const value = draft('saved'), before = structuredClone(value);
  const result = applyMessageReuse(value, intent(value, { text: 'x'.repeat(12000) }), true, () => { identities++; return 'new'; });
  assert.deepEqual(result, { ok: false, reason: 'too-long', length: 12007, limit: 12000 });
  assert.equal(identities, 0); assert.deepEqual(value, before);
  const empty = draft(); const exact = applyMessageReuse(empty, intent(empty, { text: '🙂'.repeat(6000) }), true, () => 'new');
  assert(exact.ok); assert.equal(exact.length, 12000);
  assert.equal(applyMessageReuse(empty, intent(empty, { text: 'x'.repeat(11999), mode: 'quote' }), true).ok, false);
});
test('new legacy directed requests use their 4000-character limit while current conversations use 12000', () => {
  const value = { ...draft(), routing: { kind: 'node' as const, nodeID: 'node', name: 'Node' } }, request = intent(value, { text: 'x'.repeat(4001) });
  assert.deepEqual(applyMessageReuse(value, request, false), { ok: false, reason: 'too-long', length: 4001, limit: 4000 });
  assert(applyMessageReuse(value, request, true).ok);
});
test('empty messages do not modify a draft; explicit identical reuse does not repeat an already issued request ID', () => {
  const value = draft('same');
  assert.deepEqual(applyMessageReuse(value, intent(value, { text: '\n ' }), true), { ok: false, reason: 'empty-message' });
  const result = applyMessageReuse(value, intent(value, { text: 'same', placement: 'replace', replaceConfirmed: true }), true, () => 'fresh');
  assert(result.ok); assert.equal(result.draft.text, value.text); assert.equal(result.draft.requestID, 'fresh'); assert.equal(result.draft.requestSignature, undefined);
});
