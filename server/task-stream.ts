import type { Event, Message as EngineMessage, Part } from '@opencode-ai/sdk/v2';
import type { Message, Task } from '../shared/types.ts';
import type { TaskStreamUpdate } from '../shared/task-stream.ts';
import { normalizeMessages, type EngineMessageRecord } from './task-messages.ts';

type Entry = { raw: EngineMessageRecord; version: number };
type Run = { sessionID: string; runAfter: number; messages: Map<string, Entry>; seen: Set<string> };

/** Bounded, transient stream projection. Durable state still comes from the existing session poll. */
export class TaskMessageStream {
  private runs = new Map<string, Run>();
  private revision = Date.now();
  mark() { return this.revision; }
  private next() { return this.revision = Math.max(Date.now(), this.revision + 1); }
  private run(task: Task) {
    let run = this.runs.get(task.id);
    if (!run || run.sessionID !== task.sessionID || run.runAfter !== task.runAfter) {
      run = { sessionID: task.sessionID!, runAfter: task.runAfter, messages: new Map(), seen: new Set() };
      this.runs.set(task.id, run);
      if (this.runs.size > 128) this.runs.delete(this.runs.keys().next().value!);
    }
    return run;
  }
  private save(run: Run, raw: EngineMessageRecord, version = this.next()) {
    const entry = { raw, version };
    run.messages.set(raw.info.id, entry);
    if (run.messages.size > 32) run.messages.delete(run.messages.keys().next().value!);
    return entry;
  }
  private display(entry: Entry): Message {
    return { ...normalizeMessages([entry.raw])[0], streamVersion: entry.version };
  }
  event(task: Task, event: Event): TaskStreamUpdate | null {
    const run = this.run(task);
    if (event.id) {
      if (run.seen.has(event.id)) return null;
      run.seen.add(event.id);
      if (run.seen.size > 4096) run.seen.delete(run.seen.values().next().value!);
    }
    let entry: Entry | undefined;
    if (event.type === 'message.updated') {
      const info = event.properties.info;
      if (info.role !== 'assistant' || info.time.created < task.runAfter) return null;
      entry = this.save(run, { info, parts: run.messages.get(info.id)?.raw.parts || [] });
    } else if (event.type === 'message.part.updated') {
      const part = event.properties.part;
      if (!['text', 'reasoning', 'tool'].includes(part.type)) return null;
      const previous = run.messages.get(part.messageID);
      // Unknown-role parts are reconciled by the poll, never guessed to be assistant text.
      if (!previous) return null;
      const parts = [...previous.raw.parts];
      const index = parts.findIndex(value => value.id === part.id);
      if (index < 0) { if (parts.length >= 256) return null; parts.push(this.bounded(part)); }
      else parts[index] = this.bounded(part);
      entry = this.save(run, { ...previous.raw, parts });
    } else if (event.type === 'message.part.removed') {
      const previous = run.messages.get(event.properties.messageID);
      if (previous) entry = this.save(run, { ...previous.raw, parts: previous.raw.parts.filter(p => p.id !== event.properties.partID) });
    } else if (event.type === 'message.part.delta' && event.properties.field === 'text') {
      const { messageID, partID, delta } = event.properties;
      const previous = run.messages.get(messageID);
      const part = previous?.raw.parts.find(value => value.id === partID);
      if (!previous || !part || part.type !== 'text' && part.type !== 'reasoning') return null;
      entry = this.save(run, { ...previous.raw, parts: previous.raw.parts.map(value => value.id === partID ?
        this.bounded({ ...part, text: part.text + delta }) : value) });
    }
    return entry ? { taskID: task.id, sessionID: run.sessionID, runAfter: run.runAfter, message: this.display(entry) } : null;
  }
  private bounded(part: Part): Part {
    // Keep raw accumulated text for whole-string redaction (a secret may span chunks).
    if (part.type === 'text' || part.type === 'reasoning') return { ...part, text: part.type === 'reasoning' ? part.text.slice(0, 64_001) : part.text, metadata: undefined };
    if (part.type === 'tool') {
      const state = part.state;
      const inputText = JSON.stringify(state.input || {});
      const input = inputText.length > 8000 ? { truncatedInput: inputText.slice(0, 8001) } : state.input;
      return { ...part, state: { ...state, input, ...('output' in state ? { output: state.output.slice(0, 24_001) } : {}),
        ...('error' in state ? { error: state.error.slice(0, 24_001) } : {}) } };
    }
    return part;
  }
  reconcile(task: Task, raw: readonly EngineMessageRecord[], started: number): Message[] {
    const run = this.run(task);
    const result = normalizeMessages(raw);
    for (let i = 0; i < raw.length; i++) {
      const record = raw[i];
      if (record.info.role !== 'assistant' || record.info.time.created < task.runAfter) continue;
      let entry = run.messages.get(record.info.id);
      if (!entry || entry.version <= started) {
        const next = { info: record.info as EngineMessage, parts: record.parts.filter(p => ['text', 'reasoning', 'tool'].includes(p.type)).slice(0, 256).map(p => this.bounded(p)) };
        if (!entry || JSON.stringify(entry.raw) !== JSON.stringify(next)) {
          const saved = task.messages.find(message => message.id === record.info.id);
          const { streamVersion, ...content } = saved || {};
          const unchanged = streamVersion && JSON.stringify(content) === JSON.stringify(normalizeMessages([next])[0]);
          entry = unchanged ? this.save(run, next, streamVersion) : this.save(run, next);
        }
      }
      result[i] = this.display(entry!);
    }
    // Include a newly started message whose event arrived after the HTTP read began.
    for (const [id, entry] of run.messages) if (entry.version > started && !result.some(m => m.id === id)) result.push(this.display(entry));
    return result;
  }
  clear(taskID?: string) { if (taskID) this.runs.delete(taskID); else this.runs.clear(); }
}
