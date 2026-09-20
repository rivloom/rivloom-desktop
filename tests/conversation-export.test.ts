import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation } from '../shared/conversations.ts';
import type { BrainTask, RemoteTaskInvite, Task } from '../shared/types.ts';
import type { Workflow, WorkflowAttempt, WorkflowRound } from '../shared/workflows.ts';
import { WorkflowStore, workflowStep } from '../server/workflows.ts';
import { conversationExportFilename, conversationExportNotes, createConversationExportFile, exportTextFence, exportVisibleConversation, serializeConversationExport } from '../src/conversation-export.ts';

const at = '2026-09-18T12:00:00.000Z';
const file = { id: randomUUID(), name: 'notes.txt', bytes: 16, mime: 'text/plain', sha256: 'a'.repeat(64), sourcePath: 'DO_NOT_EXPORT_SOURCE_PATH' };
function conversation(extra: Partial<Conversation> = {}): Conversation {
  return { key: 'local:example', title: 'Visible title', description: 'Visible requirement', createdAt: at, updatedAt: at, incoming: false, sourceNodeID: 'local', attempts: [], ...extra };
}
function workflow(): Workflow {
  const database = new DatabaseSync(':memory:');
  try { const value = new WorkflowStore(database).create({ requestID: randomUUID(), creatorID: 'owner', title: 'Example', description: 'Initial round', criteria: 'INTERNAL_CRITERIA',
    projectID: null, model: null, approvalMode: 'ask', target: { mode: 'automatic' }, inputFiles: [] }); value.inputFiles = [file]; value.model = 'PRIVATE_MODEL_CONFIG'; return value; }
  finally { database.close(); }
}
function completed(value: Workflow, text: string) {
  value.state = 'completed'; value.summary = 'Visible plan'; value.planVersion = 1;
  const step = workflowStep({ id: 'result', title: 'Visible step', instructions: 'INTERNAL_INSTRUCTIONS', dependsOn: [], nodeID: null, resources: [], software: [], requirements: {} });
  const attempt: WorkflowAttempt = { number: 1, executionID: 'PRIVATE_EXECUTION', nodeID: 'local', kind: 'local', phase: 'completed', createdAt: at, updatedAt: at,
    summary: 'PRIVATE_ENGINE_ENVELOPE', outcome: { kind: 'completed', summary: text, files: ['PRIVATE_RESULT_PATH'] }, inputFiles: [file], outputFiles: [file], error: null,
    context: { workflowID: value.id, stepID: 'result', attempt: 1, role: 'executor', target: value.target, instructions: 'INTERNAL_INSTRUCTIONS', evidence: 'PRIVATE_EVIDENCE', priorContext: 'PRIVATE_PRIOR_CONTEXT' }, handled: true };
  step.state = 'completed'; step.checkpoint = text; step.attempts = [attempt]; value.steps = [step];
}

test('workflow export includes archived/current visible rounds and pending requests without engine context or cancelled work', () => {
  const value = workflow(); completed(value, 'First result');
  value.rounds = [{ ...structuredClone(value), requestID: value.requestID } as WorkflowRound];
  value.roundRequestID = randomUUID(); value.description = 'Second request'; completed(value, 'Second result');
  value.messages = [
    { requestID: value.roundRequestID, text: 'Second request', state: 'queued', createdAt: at, inputFiles: [] },
    { requestID: randomUUID(), text: 'Pending request', state: 'queued', createdAt: at, inputFiles: [file] },
    { requestID: randomUUID(), text: 'CANCELLED_SECRET', state: 'cancelled', createdAt: at, inputFiles: [] },
  ];
  const item = conversation({ key: `workflow:${value.id}`, workflow: value }); const before = structuredClone(item);
  const result = exportVisibleConversation(item, at);
  assert.equal(result.coverage, 'workflow-rounds'); assert.equal(result.conversation.kind, 'workflow');
  assert.deepEqual(result.rounds.map(round => round.number), [1, 2]);
  assert.deepEqual(result.rounds.map(round => round.entries.filter(entry => entry.kind === 'response').map(entry => entry.text)), [['First result'], ['Second result']]);
  assert.deepEqual(result.queuedRequests.map(entry => entry.text), ['Pending request']);
  assert.deepEqual(result.rounds[0].entries[0].attachments, [{ name: 'notes.txt', bytes: 16, mime: 'text/plain' }]);
  assert.deepEqual(result.rounds[1].entries[0].attachments, []);
  const encoded = JSON.stringify(result);
  for (const privateText of ['PRIVATE_', 'INTERNAL_', 'CANCELLED_SECRET', 'DO_NOT_EXPORT_SOURCE_PATH', 'sha256', 'creatorID', 'approvalMode', 'sessionID']) assert(!encoded.includes(privateText), privateText);
  assert.deepEqual(item, before);
});

test('visible historical attempts are exported without duplicating the final response', () => {
  const value = workflow(); completed(value, 'Final result');
  const step = value.steps[0], previous = structuredClone(step.attempts[0]);
  previous.number = 1; previous.phase = 'stopped'; previous.outcome = { kind: 'handoff', nodeID: null, reason: 'Visible reason', checkpoint: 'Old checkpoint', files: [], processesStopped: true };
  step.attempts[0].number = 2; step.attempts.unshift(previous);
  const entries = exportVisibleConversation(conversation({ workflow: value }), at).rounds[0].entries;
  assert.equal(entries.filter(entry => entry.text === 'Final result').length, 1);
  assert.deepEqual(entries.find(entry => entry.text === 'Old checkpoint'), { kind: 'step-result', text: 'Old checkpoint', stepTitle: 'Visible step', attempt: 1, attachments: [{ name: 'notes.txt', bytes: 16, mime: 'text/plain' }] });
});

test('legacy Task uses displayed requirement instead of the initial engine envelope and omits tools and configuration', () => {
  const task = { messages: [
    { id: 'first', role: 'user', text: 'PRIVATE_ENGINE_ENVELOPE', tools: [] },
    { id: 'answer', role: 'assistant', text: 'Visible reply', tools: [{ name: 'bash', output: 'PRIVATE_TOOL_OUTPUT' }] },
    { id: 'followup', role: 'user', text: 'Visible follow-up', tools: [] },
  ], inputFiles: [file], sessionID: 'PRIVATE_SESSION', model: 'PRIVATE_MODEL', credentials: { apiKey: 'PRIVATE_API_KEY' } } as unknown as Task;
  const result = exportVisibleConversation(conversation({ localTask: task }), at);
  assert.equal(result.coverage, 'local-messages');
  assert.deepEqual(result.rounds[0].entries.map(entry => entry.text), ['Visible requirement', 'Visible reply', 'Visible follow-up']);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'format', 'exportedAt', 'conversation', 'coverage', 'limitations', 'rounds', 'queuedRequests']);
});

test('missing first user and empty Task retain visible requirements and accurately report missing responses', () => {
  const messages = [{ id: 'answer', role: 'assistant' as const, text: 'Retained response', tools: [] }];
  const result = exportVisibleConversation(conversation({ localTask: { messages } as unknown as Task }), at);
  assert.deepEqual(result.rounds[0].entries.map(entry => entry.text), ['Visible requirement', 'Retained response']);
  const empty = exportVisibleConversation(conversation({ localTask: { messages: [] } as unknown as Task }), at);
  assert.equal(empty.coverage, 'request-only'); assert(empty.limitations.includes('no-response-recorded'));
});

test('Brain and remote exports disclose unavailable full transcripts and never include old executions', () => {
  for (const kind of ['brain', 'remote'] as const) {
    const item = conversation(kind === 'brain' ? { brainTask: { executionSummary: 'Synced summary', status: 'completed', executions: [{ summary: 'PRIVATE_OLD_EXECUTION' }], inputFiles: [file] } as unknown as BrainTask }
      : { remote: { executionSummary: 'Synced summary', executionState: 'accepted', executionLeaseID: 'PRIVATE_LEASE', remoteApprovals: [{ metadata: 'PRIVATE_APPROVAL' }], inputFiles: [file] } as unknown as RemoteTaskInvite });
    const result = exportVisibleConversation(item, at);
    assert.equal(result.conversation.kind, kind); assert.equal(result.coverage, 'summary-only');
    assert(result.limitations.includes('remote-transcript-unavailable')); assert.equal(result.rounds[0].entries[1].text, 'Synced summary');
    assert(!JSON.stringify(result).includes('PRIVATE_')); assert(conversationExportNotes(result).length >= 4);
  }
  const empty = exportVisibleConversation(conversation({ remote: { executionSummary: '', executionState: 'not_started' } as RemoteTaskInvite }), at);
  assert.equal(empty.coverage, 'request-only'); assert(empty.limitations.includes('no-response-recorded'));
});

test('a Brain record with authorized local messages exports those messages while retaining its stable kind', () => {
  const item = conversation({ brainTask: {} as BrainTask, localTask: { messages: [{ id: 'a', role: 'assistant', text: 'Local response', tools: [] }] } as unknown as Task });
  const result = exportVisibleConversation(item, at);
  assert.equal(result.conversation.kind, 'brain'); assert.equal(result.coverage, 'local-messages'); assert(!result.limitations.includes('remote-transcript-unavailable'));
});

test('Markdown fences preserve arbitrary code, HTML and long repeated markers as inert source text', () => {
  const source = '```js\nconsole.log(1)\n```\n`````\n<img src="https://untrusted.example/pixel">';
  const result = exportTextFence(source);
  assert(result.startsWith('``````text\n')); assert(result.endsWith('\n``````')); assert(result.includes(source));
  assert.doesNotThrow(() => exportTextFence('` '.repeat(150_000)));
  const document = exportVisibleConversation(conversation({ title: '# Unsafe <img>\nnew heading', description: source }), at);
  const markdown = serializeConversationExport(document, 'markdown');
  assert(markdown.startsWith('# \\# Unsafe \\<img\\> new heading')); assert(markdown.includes(result));
});

test('export filenames resist paths, control/bidi characters, reserved basenames and UTF-8 byte overflow', () => {
  const title = '../CON:<bad>|/..\\file\u0000\u202e ' + '工程🙂'.repeat(100);
  const name = conversationExportFilename(title, 'json', at);
  assert(name.startsWith('rivloom-')); assert(name.endsWith('-2026-09-18.json'));
  assert(!/[<>:"/\\|?*\u0000\u202e]/.test(name)); assert(Buffer.byteLength(name) < 200); assert(!/[\uD800-\uDBFF]$/.test(name));
  assert.equal(conversationExportFilename('  ...  ', 'markdown', at), 'rivloom-conversation-2026-09-18.md');
  assert.equal(conversationExportFilename('CON', 'markdown', at), 'rivloom-CON-2026-09-18.md');
});

test('public JSON has explicit schema and the two file formats preserve all visible text without mutation', () => {
  const item = conversation({ description: 'Line 1\r\nLine 2\n🙂' }); const document = exportVisibleConversation(item, at);
  const file = createConversationExportFile(document, 'json'); const json = JSON.parse(file.text);
  assert.equal(json.schemaVersion, 1); assert.equal(json.format, 'rivloom-visible-conversation');
  assert.equal(json.rounds[0].entries[0].text, item.description); assert(file.mime.startsWith('application/json'));
  assert(createConversationExportFile(document, 'markdown').mime.startsWith('text/markdown'));
  assert.throws(() => exportVisibleConversation(item, 'invalid'), /timestamp/);
});
