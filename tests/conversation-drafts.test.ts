import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeDrafts, encodeDrafts, draftStorageKey, latestDrafts } from '../src/draft-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { WorkspacePreferences } from '../server/workspace-preferences.ts';
import {
  createConversationDraft,
  conversationCreationNeedsModel,
  conversationInputUsage,
  updateConversationDraft,
  prepareConversationRequest,
  clearSubmittedDraft,
  createdConversationKey,
} from '../src/conversation-drafts.ts';

test('saved drafts restore content, routing, options, uploaded metadata and the exact retry identity', () => {
  const id = randomUUID(), key = `workflow:${randomUUID()}`;
  const draft = prepareConversationRequest(updateConversationDraft(createConversationDraft(), { text: 'Keep **this** draft',
    routing: { kind: 'workflow', target: { mode: 'locked', nodeID: 'A'.repeat(32) } }, files: [{ id,
      file: new File(['hello'], 'notes.txt'), state: 'complete', receivedBytes: 5, error: null,
      descriptor: { id, name: 'notes.txt', bytes: 5, sha256: 'a'.repeat(64), mime: 'application/octet-stream' } }] }), { model: 'fixture/model' });
  const settings = { projectID: 'project', model: 'fixture/model', approvalChoice: 'ask' as const, criteria: 'Keep original files' };
  const recovered = decodeDrafts(encodeDrafts({ drafts: { [key]: draft }, settings }));
  assert.equal(recovered.drafts[key].text, draft.text); assert.equal(recovered.drafts[key].requestID, draft.requestID);
  assert.equal(recovered.drafts[key].requestSignature, draft.requestSignature); assert.deepEqual(recovered.drafts[key].routing, draft.routing);
  assert.deepEqual(recovered.settings, settings); assert.equal(recovered.drafts[key].files![0].file.name, 'notes.txt');
  assert.equal(recovered.drafts[key].files![0].state, 'complete'); assert.deepEqual(recovered.drafts[key].files![0].descriptor, draft.files![0].descriptor);
  assert.notEqual(draftStorageKey('one', 'node'), draftStorageKey('two', 'node'));
  assert.notEqual(draftStorageKey('one', 'node'), draftStorageKey('one', 'another'));
});

test('incomplete uploads recover as explicit missing-file errors and malformed storage does not break the composer', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Pending upload', files: [{ id: randomUUID(),
    file: new File(['hello'], 'notes.txt'), state: 'uploading', receivedBytes: 3, error: null }] });
  const recovered = decodeDrafts(encodeDrafts({ drafts: { new: draft } })).drafts.new;
  assert.equal(recovered.requestID, draft.requestID); assert.equal(recovered.files![0].state, 'failed');
  assert.match(recovered.files![0].error!, /上传尚未完成/); assert.equal(recovered.files![0].file.arrayBuffer, undefined);
  for (const input of [null, '{', '{}', '{"version":9,"drafts":{}}']) assert.equal(decodeDrafts(input).drafts.new.text, '');
});

test('drafts survive service reconstruction and browser origin changes without older requests or other users overwriting them', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  try {
    let store = new WorkspacePreferences(db);
    const older = encodeDrafts({ savedAt: 10, drafts: { new: updateConversationDraft(createConversationDraft(), { text: 'Old text' }) } });
    const newer = encodeDrafts({ savedAt: 20, drafts: { new: updateConversationDraft(createConversationDraft(), { text: 'Unsaved new text' }) } });
    store.saveConversationDrafts('owner', { value: newer }); store.saveConversationDrafts('owner', { value: older });
    store = new WorkspacePreferences(db); assert.equal(store.conversationDrafts('owner'), newer);
    assert.equal(store.conversationDrafts('another'), null);
    assert.equal(latestDrafts(null, store.conversationDrafts('owner')).drafts.new.text, 'Unsaved new text');
    assert.equal(latestDrafts(newer, older).drafts.new.text, 'Unsaved new text');
    assert.equal(latestDrafts(older, newer).drafts.new.text, 'Unsaved new text');
    assert.throws(() => store.saveConversationDrafts('owner', { value: '{' }));
    assert.equal(store.conversationDrafts('owner'), newer);
  } finally { db.close(); }
});

test('permanent history deletion clears its drafts for every user and stale clients cannot restore retired content', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new WorkspacePreferences(db), key = `workflow:${randomUUID()}`, otherKey = `workflow:${randomUUID()}`;
    const draft = updateConversationDraft(createConversationDraft(), { text: 'Remove this private draft' });
    const value = encodeDrafts({ savedAt: 20, drafts: { [key]: draft, [otherKey]: { ...draft, text: 'Keep this draft' } } });
    for (const user of ['one', 'two']) store.saveConversationDrafts(user, { value });
    assert.equal(store.draftsForConversations([key]).length, 2);
    db.prepare('INSERT INTO conversation_retired VALUES (?,?,?,1)').run('workflow', key.slice(9), key);
    store.forgetConversations([key]);
    for (const user of ['one', 'two']) {
      assert.equal(decodeDrafts(store.conversationDrafts(user)).drafts[key], undefined);
      assert.equal(decodeDrafts(store.conversationDrafts(user)).drafts[otherKey].text, 'Keep this draft');
    }
    const replay = JSON.parse(value); replay.savedAt = Date.now() + 1000;
    store.saveConversationDrafts('one', { value: JSON.stringify(replay) });
    assert.equal(decodeDrafts(store.conversationDrafts('one')).drafts[key], undefined);
    assert.equal(store.draftsForConversations([key]).length, 0);
  } finally { db.close(); }
});

test('input usage preserves an oversized draft when switching from local to remote routing', () => {
  const local = updateConversationDraft(createConversationDraft('original'), {
    text: '需求'.repeat(2500),
  });
  assert.equal(conversationInputUsage(local, false).limit, 12000);
  for (const routing of [
    { kind: 'automatic' } as const,
    { kind: 'node', nodeID: 'other', name: 'Other device' } as const,
  ]) {
    const remote = updateConversationDraft(local, { routing });
    assert.deepEqual(conversationInputUsage(remote, false), {
      length: 5000,
      limit: 4000,
      remaining: -1000,
      nearLimit: true,
      overLimit: true,
    });
    assert.equal(remote.text, local.text);
    assert.equal(conversationInputUsage(remote, true).limit, 12000);
    assert.equal(conversationInputUsage(remote, true).overLimit, false);
    const restored = updateConversationDraft(remote, { routing: { kind: 'local' } });
    assert.equal(restored.text, local.text);
    assert.equal(conversationInputUsage(restored, false).overLimit, false);
  }
});

test('input capacity uses the existing textarea count for near, exact and exceeded limits', () => {
  const remote = updateConversationDraft(createConversationDraft(), {
    routing: { kind: 'automatic' },
  });
  for (const [length, nearLimit, overLimit] of [
    [0, false, false],
    [3599, false, false],
    [3600, true, false],
    [4000, true, false],
    [4001, true, true],
  ] as const) {
    const usage = conversationInputUsage({ ...remote, text: '文'.repeat(length) }, false);
    assert.equal(usage.nearLimit, nearLimit);
    assert.equal(usage.overLimit, overLimit);
    assert.equal(usage.remaining, 4000 - length);
  }
  const emoji = conversationInputUsage({ ...remote, text: '文\n🙂' }, false);
  assert.equal(emoji.length, 4);
  assert.equal(emoji.remaining, 3996);
});

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
