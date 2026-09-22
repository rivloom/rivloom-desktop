import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskMessageDigest } from '../server/task-continuation.ts';
import { decodeDrafts, encodeDrafts, draftStorageKey, latestDrafts } from '../src/draft-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { WorkspacePreferences } from '../server/workspace-preferences.ts';
import type { Task } from '../shared/types.ts';
import { modelReadinessIssue, modelSendGuidance, type ModelSendGuidanceInput } from '../src/model-onboarding.ts';
import {
  createConversationDraft,
  conversationCreationNeedsModel,
  conversationInputUsage,
  updateConversationDraft,
  prepareConversationRequest,
  clearSubmittedDraft,
  createdConversationKey,
  initializeConversationDraftModel,
  isPendingLocalTaskMessage,
  conversationReasoningFields,
  localTaskCanContinue,
  submitLocalTaskMessage,
} from '../src/conversation-drafts.ts';

test('thinking choices survive draft restore and submission but reset on a model change', () => {
  const seeded = initializeConversationDraftModel(createConversationDraft(), 'account/model', 'high');
  const pending = prepareConversationRequest(updateConversationDraft(seeded, { text: 'Continue' }), { reasoningEffort: 'high' });
  assert.equal(initializeConversationDraftModel(pending, 'account/model', 'low'), pending);
  const restored = decodeDrafts(encodeDrafts({ drafts: { new: pending } })).drafts.new;
  assert.equal(restored.reasoningEffort, 'high');
  assert.equal(restored.requestID, pending.requestID);
  assert.equal(clearSubmittedDraft({ new: pending }, 'new', pending.requestID).new.reasoningEffort, 'high');
  const auto = updateConversationDraft(pending, { reasoningEffort: null });
  assert.notEqual(auto.requestID, pending.requestID);
  assert.equal(auto.requestSignature, undefined);
  assert.equal(updateConversationDraft(pending, { model: 'another/model' }).reasoningEffort, null);
  const corrupt = decodeDrafts(encodeDrafts({ drafts: { new: { ...pending, reasoningEffort: {} as string } } }));
  assert.equal(corrupt.drafts.new.reasoningEffort, undefined);
  const request = { requestID: randomUUID(), text: 'Continue', model: 'account/model' };
  assert.notEqual(taskMessageDigest(request), taskMessageDigest({ ...request, reasoningEffort: null }));
  assert.notEqual(taskMessageDigest({ ...request, reasoningEffort: 'high' }), taskMessageDigest({ ...request, reasoningEffort: 'low' }));
  const old = prepareConversationRequest({ ...pending, reasoningEffort: undefined, requestSignature: undefined }, { model: 'account/model' });
  assert.deepEqual(conversationReasoningFields(old, null), {});
  assert.equal(prepareConversationRequest(old, { model: 'account/model', ...conversationReasoningFields(old, null) }).requestID, old.requestID);
  assert.deepEqual(conversationReasoningFields(updateConversationDraft(old, { reasoningEffort: null }), null), { reasoningEffort: null });
});

test('model readiness prioritizes engine startup and errors over empty or stale model catalogs', () => {
  const models = [{ id: 'provider/model', name: 'Model' }];
  for (const catalog of [[], models]) {
    assert.equal(modelReadinessIssue({ ready: false, error: null, models: catalog }, 'provider/model'), 'engine');
    assert.equal(modelReadinessIssue({ ready: true, error: 'Engine exited', models: catalog }, 'provider/model'), 'engine');
  }
});

test('model readiness describes available choices without inferring saved credentials or requiring a model test', () => {
  const empty = { ready: true, error: null, models: [] };
  assert.equal(modelReadinessIssue(empty, ''), 'empty');
  assert.equal(modelReadinessIssue(empty, 'previous-account/model'), 'empty');
  const engine = { ready: true, error: null, models: [
    { id: 'keyless/local-model', name: 'Local model' },
    { id: 'rivloom-account-alias/org/model', name: 'Account model' },
  ] };
  assert.equal(modelReadinessIssue(engine, 'keyless/local-model'), null);
  assert.equal(modelReadinessIssue(engine, 'rivloom-account-alias/org/model'), null);
  assert.equal(modelReadinessIssue(engine, ''), 'selection');
  assert.equal(modelReadinessIssue(engine, 'removed/model'), 'selection');
  assert.equal(modelReadinessIssue(engine, 'org/model'), 'selection', 'Account-qualified IDs must match exactly');
});

const guidanceInput: ModelSendGuidanceInput = {
  issue: 'empty', hasCurrent: false, localPickerVisible: true, continuationBlocked: false,
  requestPending: false, owner: true, targetMode: 'automatic', legacyNeedsModel: false,
};

test('new model guidance allows owners to keep automatic or preferred scheduling without promising a remote candidate', () => {
  for (const targetMode of ['automatic', 'preferred'] as const) {
    for (const issue of ['engine', 'empty', 'selection'] as const) {
      assert.deepEqual(modelSendGuidance({ ...guidanceInput, targetMode, issue }), { required: true, canSchedule: true });
      assert.deepEqual(modelSendGuidance({ ...guidanceInput, targetMode, issue, owner: false }), { required: true, canSchedule: false });
    }
  }
  assert.deepEqual(modelSendGuidance({ ...guidanceInput, issue: null }), { required: false, canSchedule: false });
});

test('locked local guidance cannot bypass model setup while a remote-only composer needs no local model', () => {
  assert.deepEqual(modelSendGuidance({ ...guidanceInput, targetMode: 'locked' }), { required: true, canSchedule: false });
  for (const targetMode of ['locked', 'preferred'] as const) {
    for (const issue of ['engine', 'empty', 'selection'] as const) {
      assert.deepEqual(modelSendGuidance({ ...guidanceInput, targetMode, issue, localPickerVisible: false }),
        { required: false, canSchedule: false });
    }
  }
});

test('continuation guidance follows existing model blocking instead of blocking remote defaults or active supplements', () => {
  for (const localPickerVisible of [true, false]) {
    const current = { ...guidanceInput, hasCurrent: true, localPickerVisible };
    assert.deepEqual(modelSendGuidance(current), { required: false, canSchedule: false });
    assert.deepEqual(modelSendGuidance({ ...current, continuationBlocked: true }), { required: true, canSchedule: false });
  }
});

test('model onboarding never intercepts confirmation of an already submitted request or changes its draft', () => {
  const pending = prepareConversationRequest(updateConversationDraft(createConversationDraft(), {
    text: 'Keep this pending work', model: 'removed/model',
  }), { model: 'removed/model' });
  const before = structuredClone(pending);
  for (const hasCurrent of [false, true]) {
    assert.deepEqual(modelSendGuidance({ ...guidanceInput, hasCurrent, requestPending: !!pending.requestSignature,
      continuationBlocked: true, legacyNeedsModel: true }), { required: false, canSchedule: false });
  }
  assert.deepEqual(pending, before);
  const edited = updateConversationDraft(pending, { text: 'Different work' });
  assert.deepEqual(modelSendGuidance({ ...guidanceInput, requestPending: !!edited.requestSignature }),
    { required: true, canSchedule: true });
});

test('an unsent legacy local draft keeps its local model requirement and offers no scheduling bypass', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Local work' });
  assert.deepEqual(modelSendGuidance({ ...guidanceInput, legacyNeedsModel: conversationCreationNeedsModel(draft) }),
    { required: true, canSchedule: false });
  const pending = prepareConversationRequest(draft, { model: 'removed/model' });
  assert.deepEqual(modelSendGuidance({ ...guidanceInput, requestPending: !!pending.requestSignature,
    legacyNeedsModel: conversationCreationNeedsModel(pending) }), { required: false, canSchedule: false });
});

test('conversation models initialize once and live task updates preserve the unsent choice and request identity', () => {
  const old = updateConversationDraft(createConversationDraft(), { text: 'Continue this work' });
  const seeded = initializeConversationDraftModel(old, 'original/model');
  assert.equal(seeded.model, 'original/model');
  assert.equal(seeded.requestID, old.requestID);
  const chosen = updateConversationDraft(seeded, { model: 'account/another' });
  assert.notEqual(chosen.requestID, seeded.requestID);
  assert.equal(initializeConversationDraftModel(chosen, 'bootstrap/replacement'), chosen);
  assert.equal(updateConversationDraft(chosen, { model: 'account/another' }).requestID, chosen.requestID);
  const inherited = initializeConversationDraftModel(old, null);
  assert.equal(initializeConversationDraftModel(inherited, 'new/default'), inherited);
  assert.equal(inherited.model, null);
});

test('per-conversation model choices survive user-scoped persistence without changing the new conversation default', () => {
  const a = `local:${randomUUID()}`, b = `workflow:${randomUUID()}`;
  const local = initializeConversationDraftModel(createConversationDraft(), 'account-a/model');
  const workflow = initializeConversationDraftModel(createConversationDraft(), 'account-b/model');
  const settings = { projectID: 'project', model: 'new/default', approvalChoice: 'ask' as const, criteria: '' };
  const snapshot = encodeDrafts({ savedAt: 50, drafts: { [a]: local, [b]: workflow }, settings });
  const db = new DatabaseSync(':memory:');
  try {
    let store = new WorkspacePreferences(db);
    store.saveConversationDrafts('one', { value: snapshot });
    store = new WorkspacePreferences(db);
    const restored = latestDrafts(null, store.conversationDrafts('one'));
    assert.equal(restored.drafts[a].model, 'account-a/model');
    assert.equal(restored.drafts[b].model, 'account-b/model');
    assert.equal(restored.settings?.model, 'new/default');
    assert.equal(restored.drafts.new.model, undefined);
    assert.equal(store.conversationDrafts('two'), null);
  } finally { db.close(); }
});

test('older and malformed draft models preserve text while missing selections remain eligible for initialization', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Do not discard' });
  for (const model of [undefined, '', 42, { id: 'bad/model' }, 'x'.repeat(201)]) {
    const value = JSON.parse(encodeDrafts({ drafts: { new: draft } }));
    value.drafts.new.model = model;
    const recovered = decodeDrafts(JSON.stringify(value)).drafts.new;
    assert.equal(recovered.model, undefined);
    assert.equal(recovered.text, draft.text);
    assert.equal(recovered.requestID, draft.requestID);
    assert.equal(initializeConversationDraftModel(recovered, 'task/current').model, 'task/current');
  }
  const inherited = initializeConversationDraftModel(draft, null);
  assert.equal(decodeDrafts(encodeDrafts({ drafts: { new: inherited } })).drafts.new.model, null);
});

test('message retry captures the model and keeps its endpoint after live task status changes', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Next request', model: 'account/model' });
  const options = { text: 'Next request', model: draft.model, confirmed: true, messageKind: 'local-task' };
  const sent = prepareConversationRequest(draft, options);
  assert.equal(isPendingLocalTaskMessage(sent), true);
  assert.equal(isPendingLocalTaskMessage({ ...sent, requestSignature: '{' }), false);
  const refreshed = initializeConversationDraftModel(sent, 'server/different');
  const retried = prepareConversationRequest(refreshed, options);
  assert.equal(retried.requestID, sent.requestID);
  assert.equal(retried.requestSignature, sent.requestSignature);
  assert.equal(refreshed.model, 'account/model');
  const task = { assigneeID: 'user', state: 'running' as const };
  assert.equal(localTaskCanContinue(task, 'user'), false);
  assert.equal(isPendingLocalTaskMessage(retried), true);
  const edited = updateConversationDraft(sent, { model: 'account/other' });
  assert.equal(isPendingLocalTaskMessage(edited), false);
  assert.notEqual(edited.requestID, sent.requestID);
  assert.notEqual(prepareConversationRequest(sent, { ...options, model: 'account/other' }).requestID, sent.requestID);
});

test('successful messages clear only the submitted text and attachments while retaining that conversation model', () => {
  const sent = updateConversationDraft(createConversationDraft(), { text: 'Send', model: 'selected/model' });
  const other = updateConversationDraft(createConversationDraft(), { text: 'Keep', model: 'another/model' });
  const cleared = clearSubmittedDraft({ a: sent, b: other }, 'a', sent.requestID);
  assert.equal(cleared.a.text, '');
  assert.equal(cleared.a.files, undefined);
  assert.equal(cleared.a.model, 'selected/model');
  assert.equal(cleared.b, other);
  assert.equal(cleared.a.requestSignature, undefined);
  assert.notEqual(cleared.a.requestID, sent.requestID);
  const newer = updateConversationDraft(sent, { model: 'newer/model' });
  const drafts = { a: newer };
  assert.equal(clearSubmittedDraft(drafts, 'a', sent.requestID), drafts);
});

test('only the assignee of an idle ordinary local task can use task continuation', () => {
  for (const state of ['ready', 'stopped', 'failed', 'review', 'accepted'] as const) {
    const task = { assigneeID: 'executor', state };
    assert.equal(localTaskCanContinue(task, 'executor'), true);
    assert.equal(localTaskCanContinue(task, 'creator'), false);
    assert.equal(localTaskCanContinue({ ...task, remoteOrigin: { remoteTaskID: 'remote', ownerNodeID: 'node', ownerBrainID: 'brain' } }, 'executor'), false);
    assert.equal(localTaskCanContinue({ ...task, collaboration: {} as Task['collaboration'] }, 'executor'), false);
  }
  for (const state of ['open', 'running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted'] as const) {
    assert.equal(localTaskCanContinue({ assigneeID: 'executor', state }, 'executor'), false);
  }
  assert.equal(localTaskCanContinue(undefined, 'executor'), false);
});

test('new local follow-ups confirm the same session stopped before submission and retain their draft on failure', async () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Continue after checking the interrupted execution' });
  const saved = JSON.stringify(draft);
  for (const state of ['running', 'waiting_approval', 'waiting_input', 'stopping', 'interrupted'] as const) {
    const task = { id: 'task', sessionID: 'session', state };
    const calls: string[] = [];
    let release!: () => void;
    const stopping = new Promise<void>(done => { release = done; });
    const pending = submitLocalTaskMessage(task, draft, async () => {
      calls.push('stop'); await stopping;
      return { ...task, state: 'stopped' };
    }, async () => { calls.push('message'); return 'submitted'; });
    await Promise.resolve();
    assert.deepEqual(calls, ['stop'], `${state}: no message before stop acknowledgement`);
    release();
    assert.equal(await pending, 'submitted');
    assert.deepEqual(calls, ['stop', 'message']);
  }
  const task = { id: 'task', sessionID: 'session', state: 'interrupted' as const };
  let submissions = 0;
  const submit = async () => { submissions++; };
  await assert.rejects(submitLocalTaskMessage(task, draft, async () => { throw new Error('Stop could not be confirmed'); }, submit), /Stop could not be confirmed/);
  for (const response of [{ ...task, state: 'running' as const }, { ...task, state: 'stopped' as const, sessionID: 'other' },
    { ...task, state: 'stopped' as const, id: 'other' }])
    await assert.rejects(submitLocalTaskMessage(task, draft, async () => response, submit));
  assert.equal(submissions, 0);
  assert.equal(JSON.stringify(draft), saved, 'Failed stop must not consume the text or rotate its retry identity');
});

test('idle continuation and exact request replay do not stop or replace a previous submission', async () => {
  const fresh = updateConversationDraft(createConversationDraft(), { text: 'Follow-up' });
  const pending = prepareConversationRequest(fresh, { messageKind: 'local-task', model: 'account/model' });
  let stops = 0, submissions = 0;
  const stop = async () => { stops++; throw new Error('Unexpected stop'); };
  for (const state of ['ready', 'stopped', 'failed', 'review', 'accepted'] as const)
    await submitLocalTaskMessage({ id: 'task', sessionID: 'session', state }, fresh, stop, async () => { submissions++; });
  const retryID = pending.requestID, signature = pending.requestSignature;
  for (const state of ['running', 'interrupted'] as const) {
    await assert.rejects(submitLocalTaskMessage({ id: 'task', sessionID: 'session', state }, pending, stop, async () => {
      submissions++;
      assert.equal(pending.requestID, retryID);
      assert.equal(pending.requestSignature, signature);
      throw new Error('Message submission is uncertain');
    }), /submission is uncertain/);
  }
  assert.equal(stops, 0);
  assert.equal(submissions, 7);
});

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
  assert.deepEqual(recovered.settings, { ...settings, sendMode: 'enter' }); assert.equal(recovered.drafts[key].files![0].file.name, 'notes.txt');
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

test('send preferences migrate old drafts and survive user-scoped server reconstruction without changing request identity', () => {
  const draft = updateConversationDraft(createConversationDraft(), { text: 'Unsent work' });
  const settings = { projectID: 'project', model: 'provider/model', approvalChoice: 'ask' as const, criteria: 'Keep files' };
  const old = encodeDrafts({ savedAt: 10, drafts: { new: draft }, settings });
  assert.equal(decodeDrafts(old).settings?.sendMode, 'enter');
  const alternate = encodeDrafts({ savedAt: 20, drafts: { new: draft }, settings: { ...settings, sendMode: 'ctrl-enter' } });
  const bad = JSON.parse(alternate); bad.settings.sendMode = { unexpected: true };
  assert.equal(decodeDrafts(JSON.stringify(bad)).settings?.sendMode, 'enter');
  assert.equal(decodeDrafts(JSON.stringify(bad)).drafts.new.requestID, draft.requestID);
  const db = new DatabaseSync(':memory:');
  try {
    let store = new WorkspacePreferences(db);
    store.saveConversationDrafts('one', { value: alternate });
    store.saveConversationDrafts('two', { value: old });
    store.saveConversationDrafts('one', { value: old });
    store = new WorkspacePreferences(db);
    const recovered = latestDrafts(old, store.conversationDrafts('one'));
    assert.equal(recovered.settings?.sendMode, 'ctrl-enter');
    assert.equal(recovered.drafts.new.requestID, draft.requestID);
    assert.equal(recovered.drafts.new.text, draft.text);
    assert.equal(latestDrafts(alternate, old).settings?.sendMode, 'ctrl-enter');
    assert.equal(decodeDrafts(store.conversationDrafts('two')).settings?.sendMode, 'enter');
    assert.equal(store.conversationDrafts('other'), null);
  } finally { db.close(); }
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
