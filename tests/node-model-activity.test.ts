import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Message as EngineMessage, Part } from '@opencode-ai/sdk/v2';
import { NodeModelActivity, type ModelActivityTask } from '../server/node-model-activity.ts';
import { TaskMessageStream } from '../server/task-stream.ts';
import type { EngineMessageRecord } from '../server/task-messages.ts';
import type { Task } from '../shared/types.ts';

const task = (id = 'a', connection = 'office'): ModelActivityTask => ({ id, sessionID: `session-${id}`, runAfter: 1000,
  state: 'running', feed: `private-account\0C:/private-project-${connection}`,
  connection: { id: connection, name: connection, providerName: 'Provider' } });
function info(value: ModelActivityTask, patch: Record<string, unknown> = {}): EngineMessage {
  return { id: 'message', sessionID: value.sessionID!, role: 'assistant', parentID: 'user', modelID: 'model', providerID: 'provider',
    mode: 'build', agent: 'build', path: { cwd: '.', root: '.' }, time: { created: 1100, completed: 2000 }, finish: 'stop', cost: 0,
    tokens: { input: 600, output: 80, reasoning: 40, cache: { read: 5000, write: 9000 } }, ...patch } as EngineMessage;
}
const records = (value: ModelActivityTask, patch: Record<string, unknown> = {}, parts: Part[] = []): EngineMessageRecord[] => [{ info: info(value, patch), parts }];
const delta = (value: ModelActivityTask, id = 'event', text = 'abcdefghijkl'): Event => ({ id, type: 'message.part.delta',
  properties: { sessionID: value.sessionID!, messageID: 'message', partID: 'text', field: 'text', delta: text } });
function begin(activity: NodeModelActivity, value: ModelActivityTask, now = 1000) {
  activity.feedOpened(value.feed, now);
  activity.observeTask(value, now, true);
}

test('Node aggregates concurrent local executions across accounts using one common time window', () => {
  const activity = new NodeModelActivity(), first = task(), second = task('b'), received = task('remote-received', 'backup');
  for (const value of [first, second, received]) {
    begin(activity, value);
    activity.event(value, delta(value), 2100);
    activity.snapshot(value, records(value), 2200);
  }
  const snapshot = activity.read(2300);
  assert.equal(snapshot.inputTokensPerSecond, 30, 'input is 1800 / 60, not cache-inclusive or prefill speed');
  assert.equal(snapshot.outputTokensPerSecond, 3, '36 ASCII characters estimate 9 tokens over three seconds');
  assert.equal(snapshot.counts.active, 3);
  assert.equal(snapshot.counts.generating, 3);
  assert.equal(snapshot.connections.find(item => item.id === 'office')?.outputTokensPerSecond, 2);
  assert.equal(snapshot.connections.length, 2);
});

test('duplicate events and repeated HTTP snapshots never double count; snapshot text is not output', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const event = delta(value);
  activity.event(value, event, 2100);
  activity.event(value, event, 2200);
  const text: Part = { id: 'text', messageID: 'message', sessionID: value.sessionID!, type: 'text', text: 'x'.repeat(100_000) };
  activity.snapshot(value, records(value, {}, [text]), 2300);
  activity.snapshot(value, records(value, {}, [text]), 2400);
  activity.event(value, { id: 'correction', type: 'message.part.updated', properties: { sessionID: value.sessionID!, time: 2500, part: text } }, 2500);
  assert.equal(activity.read(2600).outputTokensPerSecond, 1);
  assert.equal(activity.read(2600).inputTokensPerSecond, 10);
});

test('input and output completeness are independent; missing connections hide only the affected total', () => {
  const activity = new NodeModelActivity(), first = task(), second = task('b', 'other');
  begin(activity, first); begin(activity, second);
  activity.snapshot(first, records(first), 2000);
  activity.event(second, delta(second), 2100);
  const snapshot = activity.read(2200);
  assert.equal(snapshot.inputTokensPerSecond, null);
  assert.equal(snapshot.outputTokensPerSecond, null);
  assert.equal(snapshot.connections.find(item => item.id === 'office')?.inputTokensPerSecond, 10);
  assert.equal(snapshot.connections.find(item => item.id === 'other')?.outputTokensPerSecond, 1);
  assert.equal(snapshot.inputComplete, false);
  assert.equal(snapshot.outputComplete, false);
});

test('unreported input is hidden, official zero is visible and caches are not counted as input', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 10000, write: 20000 } };
  activity.snapshot(value, records(value, { time: { created: 1100 }, finish: undefined, tokens: zero }), 1500);
  assert.equal(activity.read(1600).inputTokensPerSecond, null, 'initial engine zero is a placeholder');
  activity.snapshot(value, records(value, { tokens: zero }), 2200);
  assert.equal(activity.read(2300).inputTokensPerSecond, 0, 'reported zero is a measurement');
  assert.equal(activity.read(2300).outputTokensPerSecond, null);
});

test('expired observations hide rates instead of presenting a disconnected stream as zero', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  activity.event(value, delta(value), 1900);
  activity.snapshot(value, records(value), 2100);
  activity.feedSeen(value.feed, 5000);
  activity.snapshot(value, records(value), 5500);
  assert.equal(activity.read(5600).outputTokensPerSecond, 0, 'fresh, observed silence after a measured delta is zero');
  assert.equal(activity.read(23000).outputTokensPerSecond, null);
  assert.equal(activity.read(23000).inputTokensPerSecond, null);
  activity.snapshot(value, records(value), 63000);
  assert.equal(activity.read(63000).inputTokensPerSecond, 0, 'fresh observation with known usage support confirms no new reports in this window');
});

test('reconnection discards the old output window and ignores replayed events', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const event = delta(value);
  activity.event(value, event, 2100);
  activity.feedClosed(value.feed, 2300);
  assert.equal(activity.read(2400).outputTokensPerSecond, null);
  activity.feedOpened(value.feed, 2500);
  activity.snapshot(value, records(value, { finish: undefined, time: { created: 1100 } }), 2600);
  activity.event(value, event, 2700);
  assert.equal(activity.read(2800).outputTokensPerSecond, null);
  activity.event(value, delta(value, 'new-live', '中文'), 2900);
  assert.equal(activity.read(3000).outputTokensPerSecond, 1);
});

test('first observation baselines historical usage instead of making history an input burst', () => {
  const activity = new NodeModelActivity(), value = task();
  activity.feedOpened(value.feed, 5000);
  activity.observeTask(value, 5000);
  activity.snapshot(value, records(value), 5100);
  assert.equal(activity.read(5200).inputTokensPerSecond, null);
  activity.snapshot(value, [...records(value), ...records(value, { id: 'new', time: { created: 5300, completed: 6000 } })], 6100);
  assert.equal(activity.read(6200).inputTokensPerSecond, 10);
});

test('an in-progress message adopted after creation still counts its later confirmed input', () => {
  const activity = new NodeModelActivity(), value = task();
  activity.feedOpened(value.feed, 5000);
  activity.observeTask(value, 5000);
  activity.snapshot(value, records(value, { finish: undefined, time: { created: 1100 } }), 5100);
  activity.snapshot(value, records(value, { time: { created: 1100, completed: 5500 } }), 5600);
  assert.equal(activity.read(5700).inputTokensPerSecond, 10);
});

test('adopted unfinished messages count step-finish usage before the final completed timestamp arrives', () => {
  const activity = new NodeModelActivity(), value = task();
  activity.feedOpened(value.feed, 5000);
  activity.observeTask(value, 5000);
  activity.snapshot(value, records(value, { finish: undefined, time: { created: 1100 } }), 5100);
  activity.usageEvent(value.feed, { id: 'step-finish', type: 'message.updated', properties: { sessionID: value.sessionID!,
    info: info(value, { finish: 'stop', time: { created: 1100 } }) } }, 5500);
  activity.snapshot(value, records(value, { time: { created: 1100, completed: 5600 } }), 5700);
  assert.equal(activity.read(5800).inputTokensPerSecond, 10);
});

test('completed message deltas remain fenced after reconnect even when replay IDs change', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  activity.event(value, delta(value), 1800);
  activity.snapshot(value, records(value), 2100);
  activity.feedClosed(value.feed, 2200);
  activity.feedOpened(value.feed, 2300);
  activity.event(value, delta(value, 'new-replay-id', 'old completed text'), 2400);
  assert.equal(activity.read(2500).outputTokensPerSecond, null);
});

test('late terminal usage is observed through the existing feed and stays with its original run/account', () => {
  const activity = new NodeModelActivity(), old = task(); begin(activity, old);
  activity.observeTask({ ...old, state: 'accepted' }, 2100);
  const current = { ...task('a', 'new-account'), sessionID: 'new-session', runAfter: 3000 };
  begin(activity, current, 3000);
  const update: Event = { id: 'late-usage', type: 'message.updated', properties: { sessionID: old.sessionID!, info: info(old) } };
  activity.usageEvent(old.feed, update, 4000);
  activity.usageEvent(old.feed, update, 4100);
  const snapshot = activity.read(4200);
  assert.equal(snapshot.connections.find(connection => connection.id === 'office')?.inputTokensPerSecond, 10);
  assert.equal(snapshot.connections.find(connection => connection.id === 'new-account')?.inputTokensPerSecond, null);
  assert.equal(snapshot.counts.active, 1);
});

test('late usage after a same-session continuation is routed by the original message creation time', () => {
  const activity = new NodeModelActivity(), old = task(); begin(activity, old);
  activity.observeTask({ ...old, state: 'accepted' }, 2100);
  const current = { ...old, runAfter: 3000 }; begin(activity, current, 3000);
  activity.usageEvent(old.feed, { id: 'late', type: 'message.updated', properties: { sessionID: old.sessionID!, info: info(old) } }, 4000);
  assert.equal(activity.read(4100).inputTokensPerSecond, 10, 'new unfinished request on a known connection is not missing usage');
});

test('known input support allows pending requests to coexist with reported throughput; unknown support stays hidden', () => {
  const activity = new NodeModelActivity(), first = task(), pending = task('b');
  begin(activity, first); activity.snapshot(first, records(first), 2100);
  begin(activity, pending); activity.snapshot(pending, records(pending, { finish: undefined, time: { created: 1100 } }), 2200);
  assert.equal(activity.read(2300).inputTokensPerSecond, 10);
  activity.snapshot(pending, records(pending, { tokens: { input: undefined } }), 2400);
  assert.equal(activity.read(2500).inputTokensPerSecond, null, 'a completed report missing input is genuinely incomplete');
});

test('fully observed waiting and tool phases contribute genuine zero without hiding other output', () => {
  const activity = new NodeModelActivity(), running = task(), waiting = task('b', 'other');
  begin(activity, running); begin(activity, waiting);
  activity.observeTask({ ...waiting, state: 'waiting_input' }, 2200);
  activity.event(running, delta(running), 2300);
  assert.equal(activity.read(2500).outputTokensPerSecond, null, 'partial observation is not a zero');
  activity.feedSeen(waiting.feed, 4000); activity.feedSeen(running.feed, 4000);
  const snapshot = activity.read(4100);
  assert.equal(snapshot.outputTokensPerSecond, 1);
  assert.equal(snapshot.connections.find(connection => connection.id === 'other')?.outputTokensPerSecond, 0);
  assert.equal(snapshot.counts.generating, 1);
  assert.equal(snapshot.counts.waiting, 1);
});

test('failed messages with only initial engine zeros are not reported as measured zero input', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  activity.snapshot(value, records(value, { finish: undefined, error: { name: 'MessageAbortedError', data: {} },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), 2100);
  assert.equal(activity.read(2200).inputTokensPerSecond, null);
});

test('finished all-zero usage does not establish input capability or disguise absent provider usage', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  activity.snapshot(value, records(value, { tokens: zero }), 2100);
  assert.equal(activity.read(2200).inputTokensPerSecond, null);
  activity.snapshot(value, records(value), 2300);
  assert.equal(activity.read(2400).inputTokensPerSecond, 10);
  activity.snapshot(value, [...records(value), ...records(value, { id: 'missing-provider-usage', tokens: zero,
    time: { created: 2500, completed: 2700 } })], 2800);
  assert.equal(activity.read(2900).inputTokensPerSecond, null, 'known connection support cannot turn a subsequent all-zero report into evidence');
});

test('input zero is confirmed when another official usage counter demonstrates a reported measurement', () => {
  for (const field of ['output', 'reasoning', 'cacheRead', 'cacheWrite']) {
    const activity = new NodeModelActivity(), value = task(); begin(activity, value);
    const tokens = { input: 0, output: field === 'output' ? 1 : 0, reasoning: field === 'reasoning' ? 1 : 0,
      cache: { read: field === 'cacheRead' ? 1 : 0, write: field === 'cacheWrite' ? 1 : 0 } };
    activity.snapshot(value, records(value, { tokens }), 2100);
    assert.equal(activity.read(2200).inputTokensPerSecond, 0, field);
  }
});

test('session and run boundaries fence late events while retaining already reported recent input', () => {
  const activity = new NodeModelActivity(), previous = task(); begin(activity, previous);
  activity.event(previous, delta(previous), 2100);
  activity.snapshot(previous, records(previous), 2200);
  const current = { ...previous, sessionID: 'new-session', runAfter: 3000 };
  begin(activity, current, 3000);
  activity.event(previous, delta(previous, 'late-old', 'x'.repeat(600)), 3100);
  activity.event(current, delta(previous, 'wrong-session'), 3100);
  assert.equal(activity.read(3200).outputTokensPerSecond, null);
  assert.equal(activity.read(3200).counts.active, 1);
  activity.event(current, delta(current, 'live-new'), 3500);
  activity.snapshot(current, records(current, { time: { created: 3100, completed: 3550 } }), 3600);
  assert.equal(activity.read(3800).inputTokensPerSecond, 20);
  assert.equal(activity.read(3800).outputTokensPerSecond, 1);
});

test('partial failure does not suppress healthy output and recent failures expire', () => {
  const activity = new NodeModelActivity(), first = task(), failed = task('b', 'bad');
  begin(activity, first); begin(activity, failed);
  activity.event(first, delta(first), 2100);
  activity.observeTask({ ...failed, state: 'failed' }, 2200);
  const snapshot = activity.read(2300);
  assert.equal(snapshot.outputTokensPerSecond, 1);
  assert.equal(snapshot.counts.failed, 1);
  assert.equal(snapshot.counts.active, 1);
  assert.equal(snapshot.connections.find(item => item.id === 'bad')?.outputTokensPerSecond, null);
  assert.equal(activity.read(63000).counts.failed, 0);
});

test('tool and approval phases do not count as generating, and stopping ends output animation', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const tool = { id: 'tool', messageID: 'message', sessionID: value.sessionID!, type: 'tool', tool: 'bash', callID: 'call',
    state: { status: 'running', input: {}, time: { start: 2000 } } } as Part;
  activity.event(value, delta(value), 2100);
  activity.snapshot(value, records(value, {}, [tool]), 2200);
  assert.equal(activity.read(2300).counts.tools, 1);
  assert.equal(activity.read(2300).counts.generating, 0);
  activity.observeTask({ ...value, state: 'waiting_approval' }, 2400);
  assert.equal(activity.read(2500).counts.waiting, 1);
  assert.equal(activity.read(2500).counts.tools, 0);
  activity.observeTask({ ...value, state: 'stopping' }, 2600);
  assert.equal(activity.read(2700).counts.generating, 0);
  assert.equal(activity.read(2700).outputTokensPerSecond, null);
  activity.observeTask({ ...value, state: 'stopped' }, 2800);
  assert.equal(activity.read(2900).counts.active, 0);
});

test('missing usage can arrive later, numeric corrections and duplicates remain idempotent', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  activity.snapshot(value, records(value, { tokens: { input: undefined } }), 2100);
  assert.equal(activity.read(2200).inputTokensPerSecond, null);
  activity.snapshot(value, records(value), 2300);
  assert.equal(activity.read(2400).inputTokensPerSecond, 10);
  activity.snapshot(value, records(value, { tokens: { input: 300 } }), 2500);
  activity.snapshot(value, records(value), 2600);
  assert.equal(activity.read(2700).inputTokensPerSecond, 10);
  activity.snapshot(value, records(value, { tokens: { input: undefined } }), 2800);
  assert.equal(activity.read(2900).inputTokensPerSecond, null);
  activity.snapshot(value, records(value), 3000);
  assert.equal(activity.read(3100).inputTokensPerSecond, 10);
});

test('missing input affects only its original reporting window; repeated history polls do not extend it', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  const missing = records(value, { id: 'missing', tokens: { input: undefined } });
  activity.snapshot(value, missing, 2100);
  const measured = records(value, { id: 'measured', time: { created: 3200, completed: 3500 } });
  activity.snapshot(value, [...missing, ...measured], 3600);
  assert.equal(activity.read(3700).inputTokensPerSecond, null);
  activity.snapshot(value, [...missing, ...measured], 30000);
  assert.equal(activity.read(30100).inputTokensPerSecond, null);
  const latest = records(value, { id: 'latest', time: { created: 62000, completed: 62500 }, tokens: { input: 1200 } });
  activity.snapshot(value, [...missing, ...measured, ...latest], 63000);
  assert.equal(activity.read(63100).inputTokensPerSecond, 30);
  activity.snapshot(value, [...missing, ...measured, ...latest], 63200);
  assert.equal(activity.read(63300).inputTokensPerSecond, 30);
});

test('accepted and failed executions without input reports remain in input coverage but never block healthy output', () => {
  for (const state of ['accepted', 'failed'] as const) {
    const activity = new NodeModelActivity(), missing = task(), healthy = task('b', 'healthy');
    begin(activity, missing); begin(activity, healthy);
    activity.event(healthy, delta(healthy), 1800);
    activity.snapshot(healthy, records(healthy), 2100);
    activity.snapshot({ ...missing, state }, records(missing, { tokens: { input: undefined } }), 2100);
    const snapshot = activity.read(2200);
    assert.equal(snapshot.inputTokensPerSecond, null, state);
    assert.equal(snapshot.inputComplete, false, state);
    assert.equal(snapshot.outputTokensPerSecond, 1, state);
    assert.equal(snapshot.outputComplete, true, state);
    assert.equal(snapshot.connections.find(connection => connection.id === 'office')?.inputTokensPerSecond, null, state);
    assert.equal(snapshot.connections.find(connection => connection.id === 'healthy')?.inputTokensPerSecond, 10, state);
    assert.equal(snapshot.counts.active, 1, state);

    // Keep a healthy report in the next minute so recovery cannot pass merely
    // because every value disappeared together with the terminal execution.
    activity.feedSeen(healthy.feed, 62000);
    activity.snapshot(healthy, records(healthy, { id: 'next-minute', time: { created: 61000, completed: 62000 } }), 62050);
    assert.equal(activity.read(62099).inputTokensPerSecond, null, `${state}: missing report still inside its minute`);
    const recovered = activity.read(62101);
    assert.equal(recovered.inputComplete, true, state);
    assert.equal(recovered.inputTokensPerSecond, 10, state);
    assert.equal(recovered.connections.some(connection => connection.id === 'office'), false, state);
  }
});

test('a late missing report is retained for its own minute beyond the terminal execution retention time', () => {
  const activity = new NodeModelActivity(), missing = task(), healthy = task('b', 'healthy');
  begin(activity, missing); begin(activity, healthy);
  activity.observeTask({ ...missing, state: 'accepted' }, 2000);
  const late: Event = { id: 'late-missing', type: 'message.updated', properties: {
    sessionID: missing.sessionID!, info: info(missing, { tokens: { input: undefined } }) } };
  activity.usageEvent(missing.feed, late, 59900);
  activity.usageEvent(missing.feed, late, 60000);
  activity.feedSeen(healthy.feed, 62000);
  activity.snapshot(healthy, records(healthy, { id: 'healthy-later', time: { created: 61000, completed: 62000 } }), 62000);
  const afterTerminalMinute = activity.read(62100);
  assert.equal(afterTerminalMinute.inputComplete, false);
  assert.equal(afterTerminalMinute.inputTokensPerSecond, null);
  assert.equal(afterTerminalMinute.connections.some(connection => connection.id === 'office'), true,
    'trim must keep a late missing report even after endedAt + 60 seconds');
  activity.feedSeen(healthy.feed, 119700);
  activity.snapshot(healthy, records(healthy, { id: 'healthy-latest', time: { created: 119000, completed: 119700 } }), 119700);
  assert.equal(activity.read(119899).inputTokensPerSecond, null);
  const recovered = activity.read(119901);
  assert.equal(recovered.inputComplete, true);
  assert.equal(recovered.inputTokensPerSecond, 20, 'healthy reports remain valid when the missing report expires');
  assert.equal(recovered.connections.some(connection => connection.id === 'office'), false,
    'the duplicate late snapshot must not extend the missing-report window');
});

test('counts hide stale active and waiting observations while preserving fresh connection counts', () => {
  const activity = new NodeModelActivity(), stale = task(), fresh = task('b', 'fresh');
  begin(activity, stale); begin(activity, fresh);
  activity.observeTask({ ...stale, state: 'waiting_input' }, 2000);
  activity.snapshot(fresh, records(fresh), 20000);
  activity.feedSeen(fresh.feed, 20000);
  const snapshot = activity.read(20100);
  assert.equal(snapshot.counts.active, 2, 'cached state is retained internally, not replaced with an invented zero');
  assert.equal(snapshot.countsComplete, false);
  assert.equal(snapshot.connections.find(connection => connection.id === 'office')?.countsComplete, false);
  assert.equal(snapshot.connections.find(connection => connection.id === 'fresh')?.countsComplete, true);
  activity.observeTask({ ...stale, state: 'stopped' }, 20200);
  activity.observeTask({ ...fresh, state: 'failed' }, 20200);
  assert.equal(activity.read(22000).countsComplete, true, 'confirmed terminal counts do not require an active feed');
});

test('counts need fresh engine feed coverage even when the HTTP snapshot remains healthy', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  activity.snapshot(value, records(value), 20000);
  assert.equal(activity.read(20100).countsComplete, false);
  activity.feedSeen(value.feed, 20200);
  assert.equal(activity.read(20300).countsComplete, true);
});

test('observation failures are isolated from business work and invalidate only their affected execution', () => {
  const activity = new NodeModelActivity(), broken = task(), healthy = task('b', 'healthy');
  begin(activity, broken); begin(activity, healthy);
  activity.event(broken, delta(broken), 2100); activity.event(healthy, delta(healthy), 2100);
  activity.snapshot(broken, records(broken), 2200); activity.snapshot(healthy, records(healthy), 2200);
  let continued = false;
  assert.doesNotThrow(() => {
    activity.observe(broken.id, () => { throw new Error('missing project / closed observation database'); }, 2300);
    continued = true;
  });
  assert.equal(continued, true);
  const snapshot = activity.read(2400);
  assert.equal(snapshot.countsComplete, false);
  assert.equal(snapshot.connections.find(connection => connection.id === 'office')?.inputTokensPerSecond, null);
  assert.equal(snapshot.connections.find(connection => connection.id === 'healthy')?.outputTokensPerSecond, 1);
  assert.equal(snapshot.connections.find(connection => connection.id === 'healthy')?.countsComplete, true);
  const businessFailure = new Error('business result must propagate');
  assert.throws(() => { activity.observe(broken.id, () => {}, 2500); throw businessFailure; }, error => error === businessFailure);
  activity.observe('untracked-task', () => { throw new Error('metadata was unavailable before tracking'); }, 2600);
  assert.equal(activity.read(2700).limited, true);
});

test('stream validation excludes user/tool/unknown parts before the numeric sampler sees a delta', () => {
  const activity = new NodeModelActivity(), stream = new TaskMessageStream(), value = task(); begin(activity, value);
  const local = { ...value, messages: [] } as unknown as Task;
  const accept = (event: Event) => { if (stream.event(local, event)) activity.event(local, event, 2200); };
  accept(delta(value, 'unknown'));
  assert.equal(activity.read(2300).outputTokensPerSecond, null);
  accept({ id: 'message-info', type: 'message.updated', properties: { sessionID: value.sessionID!, info: info(value, { finish: undefined, time: { created: 1100 } }) } });
  accept({ id: 'part-info', type: 'message.part.updated', properties: { sessionID: value.sessionID!, time: 2000,
    part: { type: 'reasoning', id: 'text', messageID: 'message', sessionID: value.sessionID!, text: '', time: { start: 2000 } } } });
  accept(delta(value, 'reasoning', 'private content'));
  assert.equal(activity.read(2300).outputTokensPerSecond, 15 * .25 / 3);
  const publicValue = JSON.stringify(activity.read(2300));
  assert(!publicValue.includes('private content'));
  assert(!publicValue.includes('private-project'));
  assert(!publicValue.includes('session-a'));
  assert(!publicValue.includes('message'));
});

test('observation capacity remains bounded and explicitly withholds full Node totals', () => {
  const activity = new NodeModelActivity();
  for (let index = 0; index < 520; index++) begin(activity, task(`task-${index}`));
  const snapshot = activity.read(2000);
  assert.equal(snapshot.limited, true);
  assert.equal(snapshot.inputComplete, false);
  assert.equal(snapshot.outputComplete, false);
  assert(snapshot.counts.active <= 512);
});

test('a full replay guard hides incomplete output instead of evicting IDs and counting old events again', () => {
  const activity = new NodeModelActivity(), value = task(); begin(activity, value);
  for (let index = 0; index < 8193; index++) activity.event(value, delta(value, `event-${index}`, 'a'), 2100);
  activity.event(value, delta(value, 'event-0'), 2200);
  const snapshot = activity.read(2300);
  assert.equal(snapshot.limited, true);
  assert.equal(snapshot.outputTokensPerSecond, null);
  assert.equal(snapshot.connections[0].outputTokensPerSecond, null);
});
