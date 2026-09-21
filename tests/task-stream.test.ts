import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Message as EngineMessage, Part } from '@opencode-ai/sdk/v2';
import type { Message, Task } from '../shared/types.ts';
import { normalizeMessages, type EngineMessageRecord } from '../server/task-messages.ts';
import { TaskMessageStream } from '../server/task-stream.ts';
import { applyTaskStream, reconcileTaskStream } from '../shared/task-stream.ts';
import { messageSpeed } from '../shared/message-speed.ts';

const task = (patch: Partial<Task> = {}): Task => ({ id: 'task', sessionID: 'session', runAfter: 1000, state: 'running', messages: [], ...patch } as Task);
const info = (id = 'a'): EngineMessage => ({ id, role: 'assistant', sessionID: 'session', parentID: 'user', modelID: 'model', providerID: 'local', mode: 'build', agent: 'build',
  path: { cwd: '.', root: '.' }, time: { created: 1100 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
const reason = (text = ''): Part => ({ id: 'r', messageID: 'a', sessionID: 'session', type: 'reasoning', text, time: { start: 1200 }, metadata: { signature: 'PRIVATE_SIGNATURE', encrypted: 'PRIVATE_ENCRYPTED' } });
let eventNumber = 0;
const updated = (part: Part): Event => ({ id: String(++eventNumber), type: 'message.part.updated', properties: { sessionID: 'session', time: 1200, part } });
const delta = (text: string): Event => ({ id: String(++eventNumber), type: 'message.part.delta', properties: { sessionID: 'session', messageID: 'a', partID: 'r', field: 'text', delta: text } });
const messageEvent = (value = info()): Event => ({ id: String(++eventNumber), type: 'message.updated', properties: { sessionID: 'session', info: value } });

test('ordered visible parts preserve thought/text/tool order, redact values and omit provider metadata', () => {
  const record: EngineMessageRecord = { info: info(), parts: [reason('Check sk-12345678901234567890'),
    { id: 'text', messageID: 'a', sessionID: 'session', type: 'text', text: 'I will inspect the file.' },
    { id: 'tool', messageID: 'a', sessionID: 'session', type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed', input: { command: 'echo hello', count: 2 }, title: 'Shell', output: 'password=private', time: { start: 2000, end: 2200 }, metadata: {} } },
    { ...reason('Done'), id: 'r2' }] };
  const message = normalizeMessages([record])[0];
  assert.deepEqual(message.parts?.map(p => p.type), ['reasoning', 'text', 'tool', 'reasoning']);
  assert.equal(message.text, 'I will inspect the file.');
  assert.equal(message.tools[0].output, 'password=[REDACTED]');
  assert(!JSON.stringify(message).includes('PRIVATE_'));
  assert(!JSON.stringify(message).includes('sk-123'));
  assert.equal(message.timing?.outputTokens, undefined, 'initial zero usage is not measured throughput');
});

test('stream accumulates reasoning and tool snapshots without replaying or exposing raw deltas', () => {
  const stream = new TaskMessageStream(), value = task();
  stream.event(value, messageEvent());
  stream.event(value, updated(reason()));
  stream.event(value, delta('Inspect sk-123456'));
  const chunk = delta('78901234567890');
  const frame = stream.event(value, chunk)!;
  assert.equal(stream.event(value, chunk), null, 'engine SSE replay does not append a delta twice');
  assert.equal(frame.message.parts?.[0].type, 'reasoning');
  assert(!JSON.stringify(frame).includes('sk-123'));
  const first = applyTaskStream(value, frame);
  assert.equal(applyTaskStream(first, frame), first, 'duplicate frame is idempotent');
  assert.equal(first.messages.length, 1);
  const raw = [{ info: info(), parts: [reason('Inspect sk-12345678901234567890')] }];
  const messages = stream.reconcile(value, raw, stream.mark());
  assert.equal(messages[0].parts?.length, 1);
  const stable = stream.reconcile(value, raw, stream.mark());
  assert.deepEqual(stable, messages, 'unchanged polls do not churn revisions or rewrite the database');
});

test('a delta during a poll wins over its stale snapshot and later authoritative corrections replace it', () => {
  const stream = new TaskMessageStream(), value = task();
  stream.reconcile(value, [{ info: info(), parts: [reason('Before')] }], stream.mark());
  const started = stream.mark();
  const frame = stream.event(value, delta(' after'))!;
  const polled = stream.reconcile(value, [{ info: info(), parts: [reason('Before')] }], started);
  assert.deepEqual(polled[0], frame.message);
  const current = applyTaskStream(value, frame);
  const stale = { ...value, messages: [{ ...frame.message, streamVersion: frame.message.streamVersion! - 1, parts: [] }] };
  assert.deepEqual(reconcileTaskStream(current, stale).messages[0], frame.message);
  const corrected = stream.reconcile(value, [{ info: info(), parts: [reason('Corrected')] }], stream.mark());
  assert.equal(corrected[0].parts?.[0].type === 'reasoning' && corrected[0].parts[0].text, 'Corrected');
  assert(corrected[0].streamVersion! > frame.message.streamVersion!);
});

test('new messages during polls are retained; unknown-role and unknown-part deltas are ignored', () => {
  const stream = new TaskMessageStream(), value = task(), started = stream.mark();
  assert.equal(stream.event(value, delta('orphan')), null);
  assert.equal(stream.event(value, updated(reason('unknown'))), null);
  stream.event(value, messageEvent());
  stream.event(value, updated(reason('New')));
  assert.equal(stream.reconcile(value, [], started).length, 1);
  assert.equal(stream.event(value, messageEvent({ ...info(), time: { created: 900 } })), null);
});

test('late frames cannot cross stop, restart, session, task or run boundaries', () => {
  const message: Message = { id: 'a', role: 'assistant', text: 'live', tools: [], streamVersion: 20 };
  const frame = { taskID: 'task', sessionID: 'session', runAfter: 1000, message };
  for (const patch of [{ state: 'stopped' }, { state: 'accepted' }, { state: 'interrupted' }, { sessionID: 'other' }, { runAfter: 2000 }, { id: 'other' }] as Partial<Task>[]) {
    const value = task(patch);
    assert.equal(applyTaskStream(value, frame), value);
  }
  const terminal = task({ state: 'accepted', messages: [{ ...message, text: 'final', streamVersion: undefined }] });
  assert.equal(reconcileTaskStream(task({ messages: [message] }), terminal), terminal);
});

test('bounded reasoning and tools show truncation and legacy records need no migration', () => {
  const message = normalizeMessages([{ info: info(), parts: [reason('x'.repeat(65_000))] }])[0];
  assert.equal(message.parts?.[0].type === 'reasoning' && message.parts[0].text.length, 64_000);
  assert.equal(message.parts?.[0].truncated, true);
  const old = task({ messages: [{ id: 'old', role: 'assistant', text: 'old', tools: [] }] });
  assert.equal(reconcileTaskStream(old, old), old);
  assert.equal(messageSpeed(old.messages[0], false), null);
});

test('display limits preserve full canonical answers and quoted tool argument secrets are redacted', () => {
  const text = 'answer '.repeat(40_000);
  const raw: EngineMessageRecord = { info: info(), parts: [{ id: 'text', type: 'text', sessionID: 'session', messageID: 'a', text },
    { id: 'tool', type: 'tool', sessionID: 'session', messageID: 'a', callID: 'call', tool: 'fetch', state: { status: 'pending', input: { apiKey: 'private-value', nested: { access_token: 'private-token' } }, raw: '' } }] };
  const stream = new TaskMessageStream();
  const message = stream.reconcile(task(), [raw], stream.mark())[0];
  assert.equal(message.text, text);
  assert.equal(message.parts?.[0].truncated, true);
  assert(!JSON.stringify(message).includes('private-value'));
  assert(!JSON.stringify(message).includes('private-token'));
  const restored = stream.reconcile(task({ messages: [message] }), [raw], stream.mark())[0];
  assert.deepEqual(restored, message);
});

test('speed labels estimated characters live, exact usage after completion, and never fabricates missing data', () => {
  const message: Message = { id: 'a', role: 'assistant', text: 'abcdefgh', tools: [], timing: { created: 1000 } };
  assert.deepEqual(messageSpeed(message, true, 2000), { value: 2, estimated: true });
  assert.equal(messageSpeed(message, false, 2000), null);
  assert.equal(messageSpeed(message, true, 1100), null);
  message.timing = { created: 1000, completed: 3000, outputTokens: 100, reasoningTokens: 20 };
  assert.deepEqual(messageSpeed(message, false), { value: 60, estimated: false });
  for (const invalid of [undefined, NaN, -1, Infinity]) {
    message.timing.reasoningTokens = invalid;
    assert.equal(messageSpeed(message, false), null);
  }
});
