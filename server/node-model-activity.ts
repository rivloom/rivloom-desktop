import type { Event } from '@opencode-ai/sdk/v2';
import type { Task, TaskState } from '../shared/types.ts';
import type { NodeModelActivityConnection, NodeModelActivityCounts, NodeModelActivitySnapshot } from '../shared/node-model-activity.ts';
import type { EngineMessageRecord } from './task-messages.ts';

const INPUT_WINDOW = 60_000, OUTPUT_WINDOW = 3000, FRESHNESS = 15_000;
const MAX_RUNS = 512, MAX_MESSAGES = 1024, MAX_EVENTS = 8192, MAX_BUCKETS = 610;
const active = (state: TaskState) => ['running', 'waiting_approval', 'waiting_input', 'stopping'].includes(state);
const failure = (state: TaskState) => state === 'failed' || state === 'interrupted';
const counts = (): NodeModelActivityCounts => ({ active: 0, generating: 0, tools: 0, waiting: 0, failed: 0 });
const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sum = (values: number[]) => { const value = values.reduce((a, b) => a + b, 0); return Number.isFinite(value) ? value : null; };

export type ModelActivityTask = Pick<Task, 'id' | 'sessionID' | 'runAfter' | 'state'> & {
  connection: { id: string; name: string; providerName: string };
  /** Internal engine account + project subscription identity; never sent to the UI. */
  feed: string;
};
type Bucket = { at: number; tokens: number };
type Run = {
  task: ModelActivityTask;
  observedAt: number;
  startedAt: number;
  endedAt: number | null;
  failedAt: number | null;
  input: Bucket[];
  output: Bucket[];
  inputAt: number | null;
  outputKnown: boolean;
  outputObservedSince: number | null;
  observationFailed: boolean;
  toolRunning: boolean;
  inputMessages: Map<string, number | null>;
  missingMessages: Map<string, number>;
  completedMessages: Set<string>;
  unfinishedMessages: Set<string>;
  seen: Set<string>;
  limited: boolean;
};
type Feed = { connected: boolean; at: number };

/** Numeric, bounded observation of live local engine work. Reads do not query the database. */
export class NodeModelActivity {
  private runs = new Map<string, Run>();
  private feeds = new Map<string, Feed>();
  private inputConnections = new Map<string, number>();
  private limitedUntil = 0;
  /** Keep optional observation failures out of the task's execution/update path. */
  observe(taskID: string | undefined, observation: () => void, now = Date.now()) {
    try { observation(); }
    catch {
      let found = false;
      for (const run of this.runs.values()) if (taskID === undefined || run.task.id === taskID) {
        found = true;
        run.observationFailed = true;
        run.output = [];
        run.outputKnown = false;
        run.outputObservedSince = null;
        run.observedAt = now - FRESHNESS - 1;
      }
      if (!found) this.limitedUntil = Math.max(this.limitedUntil, now + FRESHNESS);
    }
  }
  private key(task: Pick<ModelActivityTask, 'id' | 'sessionID' | 'runAfter'>) { return `${task.id}\0${task.sessionID}\0${task.runAfter}`; }
  private recentMissing(run: Run, now: number) {
    return [...run.missingMessages.values()].some(at => now - at < INPUT_WINDOW);
  }
  private expired(run: Run, now: number) {
    return run.endedAt !== null && now - run.endedAt > INPUT_WINDOW &&
      !run.input.some(sample => sample.at > now - INPUT_WINDOW) && !this.recentMissing(run, now);
  }
  private trim(now: number) {
    for (const [key, run] of this.runs) {
      run.input = run.input.filter(sample => sample.at > now - INPUT_WINDOW);
      run.output = run.output.filter(sample => sample.at > now - OUTPUT_WINDOW);
      if (this.expired(run, now)) this.runs.delete(key);
    }
    const needed = new Set([...this.runs.values()].map(run => run.task.feed));
    for (const [key, feed] of this.feeds) if (!needed.has(key) && now - feed.at > INPUT_WINDOW) this.feeds.delete(key);
  }
  observeTask(task: ModelActivityTask, now = Date.now(), fromStart = false) {
    if (!task.sessionID || !Number.isFinite(task.runAfter) || task.runAfter <= 0) return;
    const key = this.key(task);
    let run = this.runs.get(key);
    if (!run && !active(task.state)) return;
    if (!run) {
      this.trim(now);
      // A new execution fences the previous run without losing its recent input reports.
      for (const previous of this.runs.values()) if (previous.task.id === task.id && active(previous.task.state)) {
        previous.task = { ...previous.task, state: 'stopped' };
        previous.endedAt = now;
        previous.output = [];
      }
      if (this.runs.size >= MAX_RUNS) {
        const oldest = this.runs.keys().next().value!;
        this.runs.delete(oldest);
        this.limitedUntil = now + INPUT_WINDOW;
      }
      run = { task, observedAt: now, startedAt: fromStart ? task.runAfter : now, endedAt: null, failedAt: null,
        input: [], output: [], inputAt: null, outputKnown: false, observationFailed: false,
        outputObservedSince: this.feeds.get(task.feed)?.connected ? now : null,
        toolRunning: false, inputMessages: new Map(), missingMessages: new Map(), completedMessages: new Set(),
        unfinishedMessages: new Set(), seen: new Set(), limited: false };
      this.runs.set(key, run);
    }
    if (failure(task.state) && !failure(run.task.state)) run.failedAt = now;
    run.task = task;
    if (!active(task.state)) {
      run.endedAt ??= now;
      // Completion ends generation, but does not erase deltas still inside the
      // three-second rate window before the UI has had a chance to sample them.
      run.toolRunning = false;
    }
  }
  feedOpened(key: string, now = Date.now()) {
    this.feeds.set(key, { connected: true, at: now });
    for (const run of this.runs.values()) if (run.task.feed === key) run.outputObservedSince = now;
    if (this.feeds.size > MAX_RUNS) {
      this.feeds.delete(this.feeds.keys().next().value!);
      this.limitedUntil = now + INPUT_WINDOW;
    }
  }
  feedSeen(key: string, now = Date.now()) {
    const feed = this.feeds.get(key);
    if (feed?.connected) {
      if (now - feed.at > FRESHNESS) for (const run of this.runs.values()) if (run.task.feed === key) {
        run.output = []; run.outputKnown = false; run.outputObservedSince = now;
      }
      for (const run of this.runs.values()) if (run.task.feed === key && run.outputObservedSince === null) run.outputObservedSince = now;
      feed.at = now;
    }
  }
  feedClosed(key?: string, now = Date.now()) {
    for (const [id, feed] of this.feeds) if (key === undefined || id === key) { feed.connected = false; feed.at = now; }
    for (const run of this.runs.values()) if (key === undefined || run.task.feed === key) {
      run.output = [];
      run.outputKnown = false;
      run.outputObservedSince = null;
      run.observedAt = now - FRESHNESS - 1;
    }
  }
  private add(samples: Bucket[], tokens: number, now: number) {
    // 100 ms buckets bound storage regardless of provider chunk frequency.
    const at = Math.floor(now / 100) * 100;
    const last = samples.at(-1);
    if (last?.at === at) last.tokens += tokens;
    else samples.push({ at, tokens });
    if (samples.length > MAX_BUCKETS) samples.splice(0, samples.length - MAX_BUCKETS);
  }
  private usage(run: Run, info: EngineMessageRecord['info'], now: number) {
    if (info.role !== 'assistant' || info.sessionID !== run.task.sessionID || info.time.created < run.task.runAfter) return;
    if (!(info.finish || info.time.completed)) {
      if (!run.completedMessages.has(info.id)) {
        if (run.unfinishedMessages.size >= MAX_MESSAGES) { run.limited = true; return; }
        run.unfinishedMessages.add(info.id);
      }
      return;
    }
    const observedUnfinished = run.unfinishedMessages.delete(info.id);
    // Older completed records establish a baseline, not a newly missing report.
    const historical = !observedUnfinished && (info.time.completed ?? info.time.created) < run.startedAt;
    if (info.time.completed) {
      if (run.completedMessages.size >= MAX_MESSAGES && !run.completedMessages.has(info.id)) { run.limited = true; return; }
      run.completedMessages.add(info.id);
    }
    const input = info.tokens?.input;
    const previous = run.inputMessages.get(info.id);
    if (!run.inputMessages.has(info.id) && run.inputMessages.size >= MAX_MESSAGES) { run.limited = true; return; }
    const zeroHasEvidence = [info.tokens?.output, info.tokens?.reasoning, info.tokens?.cache?.read, info.tokens?.cache?.write]
      .some(value => validTokens(value) && value > 0);
    // Aborted/error messages may retain the engine's initial zero placeholders.
    // The engine also normalizes absent provider usage into an all-zero object.
    // Conservatively hide that indistinguishable case, including genuinely all-zero reports.
    if (!validTokens(input) || input === 0 && (!zeroHasEvidence || !!info.error && !info.finish)) {
      run.inputMessages.set(info.id, previous ?? null);
      if (!historical && !run.missingMessages.has(info.id)) run.missingMessages.set(info.id, now);
      return;
    }
    // Never count records already completed before observation started as new throughput.
    this.inputConnections.set(run.task.connection.id, now);
    if (this.inputConnections.size > MAX_RUNS) this.inputConnections.delete(this.inputConnections.keys().next().value!);
    if (!historical && (previous === undefined || previous === null || input > previous)) {
      this.add(run.input, input - (previous ?? 0), now);
      run.inputAt = now;
    }
    // Cumulative corrections may reduce the counter, but must not be added again later.
    run.inputMessages.set(info.id, Math.max(input, previous ?? 0));
    run.missingMessages.delete(info.id);
  }
  /** Late usage may belong to a terminal task or an earlier run/account, whose route has since changed. */
  usageEvent(feed: string, event: Event, now = Date.now()) {
    if (event.type !== 'message.updated' || event.properties.info.role !== 'assistant') return;
    const info = event.properties.info;
    let target: Run | undefined;
    for (const run of this.runs.values()) if (run.task.feed === feed && run.task.sessionID === info.sessionID &&
      run.task.runAfter <= info.time.created && (!target || run.task.runAfter > target.task.runAfter)) target = run;
    // Late reports retain their own window; allow corrections for exactly as long as reads retain them.
    if (!target || this.expired(target, now)) return;
    this.usage(target, info, now);
    target.observedAt = now;
    target.observationFailed = false;
  }
  /** Only accepted engine events are supplied: display stream validation already knows role/part ownership. */
  event(task: Pick<ModelActivityTask, 'id' | 'sessionID' | 'runAfter' | 'state'>, event: Event, now = Date.now()) {
    const run = this.runs.get(this.key(task));
    if (!run || !active(run.task.state) || !active(task.state) || task.state === 'stopping') return;
    if ('sessionID' in event.properties && event.properties.sessionID !== task.sessionID) return;
    if (event.id) {
      if (run.seen.has(event.id)) return;
      // Do not forget a replay guard and later count an old event as fresh output.
      if (run.seen.size >= MAX_EVENTS) { run.limited = true; return; }
      run.seen.add(event.id);
    }
    run.observedAt = now;
    run.observationFailed = false;
    if (event.type === 'message.updated') this.usage(run, event.properties.info, now);
    // A part.updated is a cumulative snapshot/correction, not a measured delta.
    if (event.type !== 'message.part.delta' || event.properties.field !== 'text' || !event.id) return;
    if (run.completedMessages.has(event.properties.messageID)) return;
    const feed = this.feeds.get(run.task.feed);
    if (!feed?.connected || now - feed.at > FRESHNESS) return;
    let tokens = 0;
    for (const character of event.properties.delta) tokens += /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff]/u.test(character) ? 1.5 : 0.25;
    if (!tokens) return;
    this.add(run.output, tokens, now);
    run.outputKnown = true;
  }
  /** Polls reconcile usage and phase only. Their text is deliberately never sampled as output. */
  snapshot(task: ModelActivityTask, records: readonly EngineMessageRecord[] | undefined, now = Date.now()) {
    this.observeTask(task, now);
    const run = this.runs.get(this.key(task));
    if (!run || !records) return;
    run.observedAt = now;
    run.observationFailed = false;
    const current = records.filter(record => record.info.role === 'assistant' && record.info.sessionID === task.sessionID &&
      record.info.time.created >= task.runAfter);
    for (const record of current) this.usage(run, record.info, now);
    run.toolRunning = active(task.state) && current.some(record => record.parts.some(part =>
      part.type === 'tool' && ['pending', 'running'].includes(part.state.status)));
  }
  read(now = Date.now()): NodeModelActivitySnapshot {
    this.trim(now);
    const groups = new Map<string, { connection: NodeModelActivityConnection; input: number[]; output: number[];
      inputRequired: boolean; outputRequired: boolean; inputMissing: boolean; outputMissing: boolean }>();
    let limited = this.limitedUntil > now;
    for (const run of this.runs.values()) {
      const isActive = active(run.task.state), fresh = now - run.observedAt <= FRESHNESS;
      const inputRecent = run.inputAt !== null && now - run.inputAt < INPUT_WINDOW;
      const outputRecent = run.output.length > 0;
      const inputMissing = this.recentMissing(run, now);
      const recentFailure = run.failedAt !== null && now - run.failedAt < INPUT_WINDOW;
      if (!isActive && !inputRecent && !outputRecent && !inputMissing && !recentFailure) continue;
      let group = groups.get(run.task.connection.id);
      if (!group) {
        group = { connection: { ...run.task.connection, inputTokensPerSecond: null, outputTokensPerSecond: null, countsComplete: true, counts: counts() },
          input: [], output: [], inputRequired: false, outputRequired: false, inputMissing: false, outputMissing: false };
        groups.set(run.task.connection.id, group);
      }
      const count = group.connection.counts;
      if (isActive) count.active++;
      if (recentFailure) count.failed++;
      if (isActive && fresh && run.task.state === 'running' && run.toolRunning) count.tools++;
      if (isActive && ['waiting_input', 'waiting_approval'].includes(run.task.state)) count.waiting++;
      const feed = this.feeds.get(run.task.feed);
      const observed = fresh && !!feed?.connected && now - feed.at <= FRESHNESS && !run.observationFailed && !run.limited;
      if (isActive && !observed || run.limited) group.connection.countsComplete = false;
      const observedSilence = run.outputObservedSince !== null && now - run.outputObservedSince >= OUTPUT_WINDOW &&
        (run.toolRunning || ['waiting_input', 'waiting_approval'].includes(run.task.state));
      const outputValid = observed && (run.outputKnown || observedSilence);
      if (isActive && run.task.state !== 'stopping' || !isActive && outputRecent) {
        group.outputRequired = true;
        if (outputValid) {
          const value = sum(run.output.map(sample => sample.tokens));
          if (value !== null) group.output.push(value / (OUTPUT_WINDOW / 1000)); else group.outputMissing = true;
          if (run.output.length && run.task.state === 'running' && !run.toolRunning) count.generating++;
        } else group.outputMissing = true;
      }
      if (isActive || inputRecent || inputMissing) {
        group.inputRequired = true;
        const observedInput = inputRecent || this.inputConnections.has(run.task.connection.id) &&
          (run.startedAt <= run.task.runAfter || now - run.startedAt >= INPUT_WINDOW);
        if (observedInput && !inputMissing && !run.limited && !run.observationFailed && (fresh || !isActive)) {
          const value = sum(run.input.map(sample => sample.tokens));
          if (value !== null) group.input.push(value / (INPUT_WINDOW / 1000)); else group.inputMissing = true;
        } else group.inputMissing = true;
      }
      limited ||= run.limited;
    }
    const entries = [...groups.values()];
    for (const group of entries) {
      if (group.inputRequired && !group.inputMissing) group.connection.inputTokensPerSecond = sum(group.input);
      if (group.outputRequired && !group.outputMissing) group.connection.outputTokensPerSecond = sum(group.output);
    }
    const inputComplete = !limited && entries.some(group => group.inputRequired) && entries.every(group => !group.inputMissing);
    const outputComplete = !limited && entries.some(group => group.outputRequired) && entries.every(group => !group.outputMissing);
    const countsComplete = !limited && entries.every(group => group.connection.countsComplete);
    const total = counts();
    for (const group of entries) for (const key of Object.keys(total) as (keyof NodeModelActivityCounts)[]) total[key] += group.connection.counts[key];
    return { sampledAt: now, inputWindowSeconds: 60, outputWindowSeconds: 3, limited, inputComplete, outputComplete, countsComplete,
      inputTokensPerSecond: inputComplete ? sum(entries.flatMap(group => group.input)) : null,
      outputTokensPerSecond: outputComplete ? sum(entries.flatMap(group => group.output)) : null,
      counts: total, connections: entries.map(group => group.connection).sort((a, b) => a.name.localeCompare(b.name)) };
  }
}

export const nodeModelActivity = new NodeModelActivity();
export const readNodeModelActivity = (now = Date.now()): NodeModelActivitySnapshot => nodeModelActivity.read(now);
