import assert from 'node:assert/strict';
import test from 'node:test';
import { composerFileSelectionError, containsDroppedDirectory, isFileTransfer } from '../src/composer-files.ts';
import { taskFileMaximumBytes } from '../shared/task-files.ts';
import { draftFilesReady, type DraftTaskFile } from '../src/task-file-upload.ts';
import { createWorkflowDraft } from '../src/conversation-drafts.ts';
import { decodeDrafts, encodeDrafts } from '../src/draft-storage.ts';

test('file selections validate the whole batch without altering existing attachments', () => {
  const existing = [{ name: '原文件.txt', size: 10 }];
  assert.equal(composerFileSelectionError(existing, [{ name: '新材料.txt', size: 0 }]), '');
  assert.equal(composerFileSelectionError(existing, [{ name: '边界.bin', size: taskFileMaximumBytes }]), '');
  assert.ok(composerFileSelectionError(existing, [{ name: 'too-large.bin', size: taskFileMaximumBytes + 1 }]));
  assert.ok(composerFileSelectionError(existing, Array.from({ length: 5 }, () => ({ name: 'file.txt', size: 1 }))));
  assert.ok(composerFileSelectionError(existing, [{ name: '../escape.txt', size: 1 }]));
  assert.deepEqual(existing, [{ name: '原文件.txt', size: 10 }]);
});

test('five maximum-size files are allowed; empty selection is harmless', () => {
  assert.equal(composerFileSelectionError([], Array.from({ length: 5 }, (_, i) => ({ name: `${i}.bin`, size: taskFileMaximumBytes }))), '');
  assert.equal(composerFileSelectionError([], []), '');
});

test('only file drag transfers are intercepted, leaving text and links alone', () => {
  assert.equal(isFileTransfer(null), false);
  assert.equal(isFileTransfer({ types: ['text/plain', 'text/uri-list'] }), false);
  assert.equal(isFileTransfer({ types: ['Files', 'text/plain'] }), true);
});

test('directory drops are rejected, including mixed file and directory selections', () => {
  const file = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) } as DataTransferItem;
  const directory = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) } as DataTransferItem;
  assert.equal(containsDroppedDirectory([file]), false);
  assert.equal(containsDroppedDirectory([file, directory]), true);
  assert.equal(containsDroppedDirectory([{ kind: 'file' } as DataTransferItem]), false);
});

test('sending waits for a removal to finish, so a removed file cannot race into a message', () => {
  const file: DraftTaskFile = { id: 'synthetic', file: { name: 'notes.txt', size: 10, type: 'text/plain' }, state: 'complete', receivedBytes: 10, error: null };
  assert.equal(draftFilesReady([file]), true);
  assert.equal(draftFilesReady([{ ...file, removing: true }]), false);
  assert.equal(draftFilesReady([{ ...file, removing: false }]), true);
  assert.equal(draftFilesReady([]), true);
  const draft = { ...createWorkflowDraft(), text: 'Keep this body', files: [{ ...file, removing: true }] };
  const restored = decodeDrafts(encodeDrafts({ drafts: { new: draft } })).drafts.new;
  assert.equal(restored.text, draft.text);
  assert.deepEqual(restored.files, []);
  assert.equal(draft.files.length, 1);
});
