import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentConversationFindShortcut, nextConversationFindMatch } from '../src/current-conversation-find-keyboard.ts';
import type { SearchMatch } from '../src/conversation-search.ts';

const matches: SearchMatch[] = [0, 1, 2].map((index) => ({ id: `message:${index}`, text: 'Needle text', start: 0, end: 6, target: { kind: 'message', messageID: String(index) } }));

test('current-conversation navigation wraps and safely handles removed or empty matches without mutating the index', () => {
  assert.equal(nextConversationFindMatch(matches, matches[0].id, 1), matches[1]);
  assert.equal(nextConversationFindMatch(matches, matches[2].id, 1), matches[0]);
  assert.equal(nextConversationFindMatch(matches, matches[0].id, -1), matches[2]);
  assert.equal(nextConversationFindMatch(matches, 'stale', 1), matches[0]);
  assert.equal(nextConversationFindMatch(matches, null, -1), matches[2]);
  assert.equal(nextConversationFindMatch([], 'stale', 1), null);
  assert.deepEqual(matches.map((match) => match.id), ['message:0', 'message:1', 'message:2']);
});

test('Ctrl or Cmd F opens find while F3 navigation is restricted to an open current-conversation search', () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(currentConversationFindShortcut({ key: 'f', ...modifier }, { active: false }), 'open');
    assert.equal(currentConversationFindShortcut({ key: 'F', ...modifier }, { active: true }), 'open');
    assert.equal(currentConversationFindShortcut({ key: 'f', shiftKey: true, ...modifier }, { active: true }), null);
  }
  assert.equal(currentConversationFindShortcut({ key: 'F3' }, { active: true }), 'next');
  assert.equal(currentConversationFindShortcut({ key: 'F3', shiftKey: true }, { active: true }), 'previous');
  assert.equal(currentConversationFindShortcut({ key: 'F3' }, { active: false }), null);
  assert.equal(currentConversationFindShortcut({ key: 'f' }, { active: true }), null);
});

test('find shortcuts yield to IME, menu/dialog state, repeats, consumed keys and conflicting modifiers', () => {
  for (const chord of [{ key: 'f', ctrlKey: true }, { key: 'F3' }]) {
    for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { altKey: true }, { defaultPrevented: true }])
      assert.equal(currentConversationFindShortcut({ ...chord, ...extra }, { active: true }), null);
    assert.equal(currentConversationFindShortcut(chord, { active: true, composing: true }), null);
    assert.equal(currentConversationFindShortcut(chord, { active: true, blocked: true }), null);
  }
  assert.equal(currentConversationFindShortcut({ key: 'F', ctrlKey: true, metaKey: true }, { active: true }), null);
  assert.equal(currentConversationFindShortcut({ key: 'F3', ctrlKey: true }, { active: true }), null);
  assert.equal(currentConversationFindShortcut({ key: 'F3', metaKey: true }, { active: true }), null);
});
