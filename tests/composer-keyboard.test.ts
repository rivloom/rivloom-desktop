import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComposerSendMode, shouldSendComposer } from '../src/composer-keyboard.ts';
import type { WorkspaceKeyEvent } from '../src/workspace-commands.ts';

test('send modes preserve Enter default while the alternate mode requires Ctrl or Cmd', () => {
  for (const mode of ['enter', 'ctrl-enter'] as const) {
    assert.equal(shouldSendComposer({ key: 'Enter' }, mode), mode === 'enter');
    assert.equal(shouldSendComposer({ key: 'Enter', ctrlKey: true }, mode), true);
    assert.equal(shouldSendComposer({ key: 'Enter', metaKey: true }, mode), true);
    for (const extra of [{}, { ctrlKey: true }, { metaKey: true }])
      assert.equal(shouldSendComposer({ key: 'Enter', shiftKey: true, ...extra }, mode), false);
  }
});

test('composer does not submit during mentions, IME, modifier conflicts, held keys or disabled states', () => {
  for (const mode of ['enter', 'ctrl-enter'] as const) {
    const chord: WorkspaceKeyEvent = { key: 'Enter', ctrlKey: true };
    for (const extra of [{ repeat: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])
      assert.equal(shouldSendComposer({ ...chord, ...extra }, mode), false);
    for (const context of [{ composing: true }, { mentionOpen: true }, { disabled: true }])
      assert.equal(shouldSendComposer(chord, mode, context), false);
    assert.equal(shouldSendComposer({ key: ' ' }, mode), false);
    assert.equal(shouldSendComposer({ key: 'Escape' }, mode), false);
  }
});

test('missing, unsupported and corrupt send preferences migrate to the existing Enter behavior', () => {
  assert.equal(normalizeComposerSendMode('ctrl-enter'), 'ctrl-enter');
  for (const value of [undefined, null, false, {}, [], 'enter', 'ctrl+enter', 'CTRL-ENTER', 1])
    assert.equal(normalizeComposerSendMode(value), 'enter');
});
